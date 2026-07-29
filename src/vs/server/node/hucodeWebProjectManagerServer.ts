/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type * as http from 'http';
import {
	Queue,
	raceCancellationError,
} from '../../base/common/async.js';
import {
	CancellationToken,
	CancellationTokenSource,
} from '../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../base/common/errors.js';
import {
	Disposable,
	DisposableStore,
	IDisposable,
	MutableDisposable,
	toDisposable,
} from '../../base/common/lifecycle.js';
import { basename, dirname, join } from '../../base/common/path.js';
import { URI } from '../../base/common/uri.js';
import { ILogService } from '../../platform/log/common/log.js';
import {
	CreateWorktreeOptions,
	PROJECT_MANAGER_STORAGE_KEY,
	PROJECT_MANAGER_STORAGE_VERSION,
	ProjectRecord,
	StoredProjectManagerState,
	StoredProjectRecord,
	WorktreeRefQueryOptions,
} from '../../platform/projectManager/common/projectManager.js';
import {
	IProjectMetadataWatcher,
	ProjectManagerMainService,
} from '../../platform/projectManager/node/projectManagerMainService.js';
import { IStateService } from '../../platform/state/node/state.js';

export const HUCODE_WEB_PROJECTS_API_PATH = '/_hucode/projects';
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_EVENT_CLIENT_LIMIT = 64;
const DEFAULT_GIT_READ_CONCURRENCY = 4;
const DEFAULT_PROJECT_REQUEST_PENDING_LIMIT = 64;
const EVENT_RETRY_MS = 1000;
const DEFAULT_EVENT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_EVENT_BACKPRESSURE_TIMEOUT_MS = 30_000;

/**
 * Returns whether a request path targets the Hucode serve-web Projects API.
 */
export function isHucodeWebProjectsApiPath(pathname: string): boolean {
	return (
		pathname === HUCODE_WEB_PROJECTS_API_PATH ||
		pathname.startsWith(`${HUCODE_WEB_PROJECTS_API_PATH}/`)
	);
}

interface HucodeWebProjectManagerRequest
	extends AsyncIterable<Buffer | string | Uint8Array> {
	readonly method?: string;
	readonly headers?: http.IncomingHttpHeaders;
	readonly aborted?: boolean;
	on?(event: 'aborted', listener: () => void): unknown;
	removeListener?(event: 'aborted', listener: () => void): unknown;
}

interface HucodeWebProjectManagerResponse {
	readonly writableFinished?: boolean;
	writeHead(status: number, headers?: http.OutgoingHttpHeaders): unknown;
	write?(data: string): unknown;
	end(data?: string): unknown;
	on?(
		event: 'close' | 'drain' | 'error',
		listener: () => void
	): unknown;
	removeListener?(
		event: 'close' | 'drain' | 'error',
		listener: () => void
	): unknown;
}

interface HucodeWebProjectEventClient {
	readonly req: HucodeWebProjectManagerRequest;
	readonly res: HucodeWebProjectManagerResponse;
	closed: boolean;
	ready: boolean;
	pendingInitialProjects: readonly ProjectRecord[] | undefined;
	blocked: boolean;
	pendingFrame: string | undefined;
	drainListening: boolean;
	heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	backpressureTimer: ReturnType<typeof setTimeout> | undefined;
	onTerminated: () => void;
	onDrain: () => void;
}

/**
 * Filesystem operations used by serve-web project-state persistence.
 */
export interface HucodeProjectStateFileSystem {
	readFile(path: string): string;
	renameSync(source: string, target: string): void;
	exists(path: string): boolean;
	mkdir(path: string): Promise<void>;
	writeFile(path: string, data: string): Promise<void>;
	rename(source: string, target: string): Promise<void>;
	remove(path: string): Promise<void>;
}

const defaultProjectStateFileSystem: HucodeProjectStateFileSystem = {
	readFile: path => fs.readFileSync(path, 'utf8'),
	renameSync: (source, target) => fs.renameSync(source, target),
	exists: path => fs.existsSync(path),
	mkdir: async path => {
		await fs.promises.mkdir(path, { recursive: true });
	},
	writeFile: async (path, data) => {
		await fs.promises.writeFile(path, data);
	},
	rename: async (source, target) => {
		await fs.promises.rename(source, target);
	},
	remove: async path => {
		await fs.promises.rm(path, { force: true });
	},
};

/**
 * File-backed state service for the serve-web project registry.
 */
export class HucodeProjectFileStateService implements IStateService {
	declare readonly _serviceBrand: undefined;

	private readonly storagePath: string;
	private readonly tempStoragePath: string;
	private state: StoredProjectManagerState | undefined;
	private loaded = false;
	private readonly writeQueue = new Queue<void>();
	private stateVersion = 0;
	private persistedVersion = 0;
	private writeGeneration = 0;
	private lastSuccessfulWriteGeneration = 0;
	private readonly pendingWrites = new Map<number, Promise<void>>();
	private failedWrite:
		| { readonly generation: number; readonly error: unknown }
		| undefined;
	private dirtyRetry: Promise<void> | undefined;
	private dirtyWriteError: unknown;

	constructor(
		private readonly serverDataPath: string,
		private readonly logService: ILogService,
		private readonly fileSystem: HucodeProjectStateFileSystem,
		private readonly acquireWriteLease?: () => IDisposable,
	) {
		this.storagePath = join(serverDataPath, 'hucode', 'projects.json');
		this.tempStoragePath = `${this.storagePath}.tmp`;
	}

	getItem<T>(key: string, defaultValue: T): T;
	getItem<T>(key: string, defaultValue?: T): T | undefined;
	getItem<T>(key: string, defaultValue?: T): T | undefined {
		if (key !== PROJECT_MANAGER_STORAGE_KEY) {
			return defaultValue;
		}

		this.ensureLoaded();
		return (this.state as T | undefined) ?? defaultValue;
	}

	setItem(
		key: string,
		data?: object | string | number | boolean | undefined | null,
	): void {
		if (key !== PROJECT_MANAGER_STORAGE_KEY) {
			return;
		}

		this.ensureLoaded();
		this.state = data as StoredProjectManagerState | undefined;
		this.writeState();
	}

	setItems(
		items: readonly {
			key: string;
			data?: object | string | number | boolean | undefined | null;
		}[],
	): void {
		for (const item of items) {
			this.setItem(item.key, item.data);
		}
	}

	removeItem(key: string): void {
		if (key !== PROJECT_MANAGER_STORAGE_KEY) {
			return;
		}

		this.ensureLoaded();
		this.state = undefined;
		this.writeState();
	}

	async close(): Promise<void> {
		await this.writeQueue.whenIdle();
		if (this.isDirty) {
			throw this.dirtyWriteError ??
			new Error('Project state has not been persisted.');
		}
	}

	async retryDirtyState(): Promise<void> {
		if (!this.isDirty) {
			return;
		}
		if (this.dirtyRetry) {
			await this.dirtyRetry;
			return;
		}

		const inFlight = this.pendingWrites.get(this.writeGeneration);
		if (inFlight) {
			try {
				await inFlight;
			} catch {
				// A settled failure is retried below using the latest state.
			}
			if (!this.isDirty) {
				return;
			}
			if (this.dirtyRetry) {
				await this.dirtyRetry;
				return;
			}
		}

		if (this.dirtyWriteError === undefined) {
			return;
		}
		const write = this.queueStateWrite(this.state, this.stateVersion);
		const retry = write.then(
			() => {
				if (this.dirtyRetry === retry) {
					this.dirtyRetry = undefined;
				}
			},
			error => {
				if (this.dirtyRetry === retry) {
					this.dirtyRetry = undefined;
				}
				throw error;
			}
		);
		this.dirtyRetry = retry;
		await retry;
	}

	get currentWriteGeneration(): number {
		return this.writeGeneration;
	}

	async flushWritesAfter(generation: number): Promise<void> {
		const targetGeneration = this.writeGeneration;
		if (targetGeneration > generation) {
			await this.flushWritesThrough(targetGeneration);
		}
	}

	async flushWritesThrough(generation: number): Promise<void> {
		if (generation <= this.lastSuccessfulWriteGeneration) {
			return;
		}
		const pendingWrite = this.pendingWrites.get(generation);
		if (pendingWrite) {
			await pendingWrite;
			return;
		}
		if (this.failedWrite &&
			generation <= this.failedWrite.generation &&
			generation > this.lastSuccessfulWriteGeneration) {
			throw this.failedWrite.error;
		}
	}

	private ensureLoaded(): void {
		if (this.loaded) {
			return;
		}

		let serializedState: string;
		try {
			serializedState = this.fileSystem.readFile(this.storagePath);
		} catch (error) {
			if (isFileSystemError(error, 'ENOENT')) {
				this.state = undefined;
				this.loaded = true;
				return;
			}

			this.logService.error(
				`[Hucode Projects] Failed to load ${this.storagePath}`,
				error
			);
			throw new ProjectStateUnavailableError();
		}

		try {
			const state: unknown = JSON.parse(serializedState);
			if (!isStoredProjectManagerState(state)) {
				throw new InvalidProjectStateError();
			}
			this.state = state;
		} catch (error) {
			if (!(error instanceof SyntaxError) &&
				!(error instanceof InvalidProjectStateError)) {
				throw error;
			}
			this.preserveCorruptStateFile(error);
			this.state = undefined;
		}
		this.loaded = true;
	}

	/**
	 * A syntactically or structurally corrupt state file cannot be loaded on a
	 * later retry, so preserve its exact bytes before starting from empty state.
	 */
	private preserveCorruptStateFile(error: unknown): void {
		const basePreservePath = `${this.storagePath}.corrupt`;
		let preservePath = basePreservePath;
		let suffix = 0;
		while (this.fileSystem.exists(preservePath)) {
			preservePath = `${basePreservePath}.${++suffix}`;
		}
		this.logService.error(
			'[Hucode Projects] Stored project state is corrupt; ' +
			`continuing with empty state (${this.storagePath})`,
			error,
		);
		try {
			this.fileSystem.renameSync(this.storagePath, preservePath);
			this.logService.info(
				`[Hucode Projects] Preserved unreadable state as ${preservePath}`,
			);
		} catch (renameError) {
			this.logService.error(
				`[Hucode Projects] Could not preserve ${this.storagePath}`,
				renameError,
			);
			throw new ProjectStateUnavailableError();
		}
	}

	private writeState(): void {
		this.stateVersion++;
		void this.queueStateWrite(this.state, this.stateVersion);
	}

	private queueStateWrite(
		state: StoredProjectManagerState | undefined,
		stateVersion: number
	): Promise<void> {
		const lease = this.acquireWriteLease?.();
		const generation = ++this.writeGeneration;
		let write: Promise<void>;
		try {
			write = this.writeQueue.queue(async () => {
				try {
					await this.persistState(state);
					this.persistedVersion = Math.max(
						this.persistedVersion,
						stateVersion
					);
					if (!this.isDirty) {
						this.dirtyWriteError = undefined;
					}
				} catch (error) {
					this.dirtyWriteError = error;
					this.logService.error(error);
					throw error;
				} finally {
					lease?.dispose();
				}
			});
		} catch (error) {
			lease?.dispose();
			throw error;
		}
		const trackedWrite = write.then(
			() => {
				this.pendingWrites.delete(generation);
				this.lastSuccessfulWriteGeneration = Math.max(
					this.lastSuccessfulWriteGeneration,
					generation
				);
				if (this.failedWrite &&
					this.failedWrite.generation <= generation) {
					this.failedWrite = undefined;
				}
			},
			error => {
				this.pendingWrites.delete(generation);
				if (generation > this.lastSuccessfulWriteGeneration) {
					this.failedWrite = { generation, error };
				}
				throw error;
			}
		);
		this.pendingWrites.set(generation, trackedWrite);
		// setItem cannot return the write promise. Attach a rejection handler
		// immediately; flushWritesAfter and close still report the stored error.
		void trackedWrite.catch(() => { });
		return trackedWrite;
	}

	private get isDirty(): boolean {
		return this.persistedVersion < this.stateVersion;
	}

	private async persistState(
		state: StoredProjectManagerState | undefined
	): Promise<void> {
		await this.fileSystem.mkdir(join(this.serverDataPath, 'hucode'));
		try {
			await this.fileSystem.writeFile(
				this.tempStoragePath,
				`${JSON.stringify(state ?? {
					version: PROJECT_MANAGER_STORAGE_VERSION,
					projects: [],
				}, null, '\t')}\n`,
			);
			await this.fileSystem.rename(
				this.tempStoragePath,
				this.storagePath
			);
			// Atomic rename protects process-level replacement semantics. Like
			// upstream FileStorage, this does not fsync file and directory data
			// against kernel or power loss.
		} catch (error) {
			try {
				await this.fileSystem.remove(this.tempStoragePath);
			} catch (cleanupError) {
				this.logService.error(
					`[Hucode Projects] Failed to remove ` +
					`${this.tempStoragePath}`,
					cleanupError
				);
			}
			throw error;
		}
	}
}

export class HucodeNodeProjectMetadataWatcher implements IProjectMetadataWatcher {
	watch(path: string, onDidChange: () => void): IDisposable {
		const store = new DisposableStore();
		this.watchPath(store, path, onDidChange);
		return store;
	}

	/**
	 * Watches `path`, tolerating a target that does not exist yet. Raw fs.watch
	 * throws ENOENT for a missing path, so a project whose `.git/worktrees`
	 * directory has not been created yet would be left permanently unwatched
	 * and an externally created worktree would go undetected. The desktop
	 * file-service watcher watches such paths before they exist; match that by
	 * watching the nearest existing ancestor for the missing segment to appear,
	 * then re-establishing a direct watch and notifying.
	 */
	private watchPath(
		store: DisposableStore,
		path: string,
		onDidChange: () => void
	): void {
		if (store.isDisposed) {
			return;
		}

		if (fs.existsSync(path)) {
			try {
				const watcher = fs.watch(
					path,
					{ persistent: false },
					() => onDidChange()
				);
				store.add(toDisposable(() => watcher.close()));
				return;
			} catch (error) {
				this.logService.warn(
					`[Hucode Projects] Failed to watch ${path}: ${error}`
				);
			}
		}

		const ancestor = nearestExistingAncestor(path);
		if (!ancestor) {
			return;
		}

		const pending = new MutableDisposable();
		store.add(pending);
		try {
			const watcher = fs.watch(
				ancestor.dir,
				{ persistent: false },
				(_event, filename) => {
					if (filename !== null && filename !== ancestor.nextSegment) {
						return;
					}
					if (!fs.existsSync(join(ancestor.dir, ancestor.nextSegment))) {
						return;
					}

					// The missing segment appeared: drop the ancestor watch,
					// re-evaluate the full path, and report the change.
					pending.clear();
					this.watchPath(store, path, onDidChange);
					onDidChange();
				}
			);
			pending.value = toDisposable(() => watcher.close());
		} catch (error) {
			this.logService.warn(
				`[Hucode Projects] Failed to watch ${ancestor.dir}: ${error}`
			);
		}
	}

	constructor(private readonly logService: ILogService) { }
}

/**
 * Returns the nearest existing ancestor directory of `path` and the immediate
 * child segment on the way to `path`, or undefined when no ancestor exists.
 */
function nearestExistingAncestor(
	path: string
): { readonly dir: string; readonly nextSegment: string } | undefined {
	let current = path;
	let parent = dirname(current);
	while (parent !== current) {
		if (fs.existsSync(parent)) {
			return { dir: parent, nextSegment: basename(current) };
		}
		current = parent;
		parent = dirname(current);
	}
	return undefined;
}

interface HucodeProjectAdmissionEntry {
	readonly factory: () => Promise<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	cancellation: IDisposable;
}

/**
 * Bounds retained request work while allowing disconnected requests to leave
 * the waiting set before they acquire an execution slot.
 */
class HucodeProjectAdmissionQueue extends Disposable {
	private readonly pending: HucodeProjectAdmissionEntry[] = [];
	private readonly idleCallbacks: Array<() => void> = [];
	private active = 0;
	private unavailable = false;

	constructor(
		private readonly concurrency: number,
		private readonly pendingLimit: number,
		private readonly acquireActiveLease?: () => IDisposable
	) {
		super();
	}

	get size(): number {
		return this.active + this.pending.length;
	}

	queue<T>(
		factory: () => Promise<T>,
		token: CancellationToken
	): Promise<T> {
		if (token.isCancellationRequested) {
			return Promise.reject(new CancellationError());
		}
		if (this.unavailable) {
			return Promise.reject(new ProjectRequestUnavailableError());
		}
		if (this.active >= this.concurrency &&
			this.pending.length >= this.pendingLimit) {
			return Promise.reject(new ProjectRequestCapacityError());
		}

		return new Promise<T>((resolve, reject) => {
			const entry: HucodeProjectAdmissionEntry = {
				factory,
				resolve: value => resolve(value as T),
				reject,
				cancellation: Disposable.None,
			};
			entry.cancellation = token.onCancellationRequested(() => {
				this.cancelPending(entry);
			});
			this.pending.push(entry);
			this.consume();
		});
	}

	private cancelPending(entry: HucodeProjectAdmissionEntry): void {
		const index = this.pending.indexOf(entry);
		if (index < 0) {
			return;
		}
		this.pending.splice(index, 1);
		entry.cancellation.dispose();
		entry.reject(new CancellationError());
	}

	private consume(): void {
		while (!this.unavailable &&
			this.active < this.concurrency &&
			this.pending.length > 0) {
			const entry = this.pending.shift()!;
			entry.cancellation.dispose();
			this.active++;
			let activeLease = Disposable.None;
			let operation: Promise<unknown>;
			try {
				activeLease =
					this.acquireActiveLease?.() ?? Disposable.None;
				operation = entry.factory();
			} catch (error) {
				operation = Promise.reject(error);
			}
			void operation.then(
				value => {
					entry.resolve(value);
					this.complete(activeLease);
				},
				error => {
					entry.reject(error);
					this.complete(activeLease);
				}
			);
		}
	}

	runWhenIdle(callback: () => void): void {
		if (this.active === 0) {
			callback();
		} else {
			this.idleCallbacks.push(callback);
		}
	}

	private complete(activeLease: IDisposable): void {
		try {
			this.active--;
			if (!this.unavailable) {
				this.consume();
			}
			if (this.active === 0) {
				for (const callback of this.idleCallbacks.splice(0)) {
					callback();
				}
			}
		} finally {
			activeLease.dispose();
		}
	}

	override dispose(): void {
		if (this.unavailable) {
			return;
		}
		this.unavailable = true;
		const error = new ProjectRequestUnavailableError();
		for (const entry of this.pending.splice(0)) {
			entry.cancellation.dispose();
			entry.reject(error);
		}
		super.dispose();
	}
}

/**
 * HTTP adapter for the serve-web Project Manager service.
 */
export class HucodeWebProjectManagerServer extends Disposable {
	private readonly service: ProjectManagerMainService | undefined;
	private readonly stateService: HucodeProjectFileStateService | undefined;
	private readonly mutationQueue: HucodeProjectAdmissionQueue;
	private readonly gitReadLimiter: HucodeProjectAdmissionQueue;
	private readonly eventClients = new Set<HucodeWebProjectEventClient>();
	private readonly eventClientLimit: number;
	private readonly eventHeartbeatIntervalMs: number;
	private readonly eventBackpressureTimeoutMs: number;
	private pendingProjectPublication:
		| {
			readonly id: number;
			readonly generation: number;
			readonly projects: readonly ProjectRecord[];
		}
		| undefined;
	private nextProjectPublicationId = 0;
	private disposed = false;

	constructor(
		serverDataPath: string,
		private readonly logService: ILogService,
		options: {
			readonly enabled: boolean;
			readonly fileSystem?: HucodeProjectStateFileSystem;
			readonly acquireStateWriteLease?: () => IDisposable;
			readonly acquireMutationLease?: () => IDisposable;
			/** Internal test override; this is not a serve-web setting. */
			readonly eventClientLimit?: number;
			/** Internal test override; this is not a serve-web setting. */
			readonly gitReadConcurrency?: number;
			/** Internal test override; this is not a serve-web setting. */
			readonly requestPendingLimit?: number;
			/** Internal test override; this is not a serve-web setting. */
			readonly eventHeartbeatIntervalMs?: number;
			/** Internal test override; this is not a serve-web setting. */
			readonly eventBackpressureTimeoutMs?: number;
		} = { enabled: true },
	) {
		super();
		this.eventClientLimit =
			options.eventClientLimit ?? DEFAULT_EVENT_CLIENT_LIMIT;
		this.eventHeartbeatIntervalMs =
			options.eventHeartbeatIntervalMs ??
			DEFAULT_EVENT_HEARTBEAT_INTERVAL_MS;
		this.eventBackpressureTimeoutMs =
			options.eventBackpressureTimeoutMs ??
			DEFAULT_EVENT_BACKPRESSURE_TIMEOUT_MS;
		const requestPendingLimit = Math.max(
			0,
			options.requestPendingLimit ??
			DEFAULT_PROJECT_REQUEST_PENDING_LIMIT
		);
		this.mutationQueue = this._register(
			new HucodeProjectAdmissionQueue(
				1,
				requestPendingLimit,
				options.acquireMutationLease
			)
		);
		this.gitReadLimiter = this._register(new HucodeProjectAdmissionQueue(
			Math.max(
				1,
				options.gitReadConcurrency ?? DEFAULT_GIT_READ_CONCURRENCY
			),
			requestPendingLimit
		));

		if (!options.enabled) {
			return;
		}

		this.stateService =
			new HucodeProjectFileStateService(
				serverDataPath,
				logService,
				options.fileSystem ?? defaultProjectStateFileSystem,
				options.acquireStateWriteLease
			);
		this.service = new ProjectManagerMainService(
			this.stateService,
			logService,
			{ metadataWatcher: new HucodeNodeProjectMetadataWatcher(logService) },
		);
		this._register(this.service.onDidChangeProjects(projects => {
			this.queueProjectsPublication(projects);
		}));
	}

	async handle(
		req: HucodeWebProjectManagerRequest,
		res: HucodeWebProjectManagerResponse,
		pathname: string,
	): Promise<boolean> {
		const service = this.service;
		if (!service || !isHucodeWebProjectsApiPath(pathname)) {
			return false;
		}

		// The Projects API mutates local state and runs git commands, so
		// browser requests must come from the serving origin even when the
		// server runs without a connection token.
		const originError = getCrossOriginRequestError(req.headers);
		if (originError) {
			return this.writeJson(res, 403, { error: originError });
		}
		if (req.method === 'POST' && !hasJsonContentType(req.headers)) {
			return this.writeJson(res, 415, {
				error: 'Content-Type must be application/json.',
			});
		}

		const relativePath = pathname
			.substring(HUCODE_WEB_PROJECTS_API_PATH.length)
			.replace(/^\/+/, '');
		if (req.method === 'GET' && relativePath === 'events') {
			try {
				return await this.handleEvents(service, req, res);
			} catch (error) {
				return this.writeRequestError(res, error);
			}
		}

		const requestCancellation = new CancellationTokenSource();
		const onRequestAborted = () => requestCancellation.cancel();
		const onResponseClose = () => {
			if (!res.writableFinished) {
				requestCancellation.cancel();
			}
		};
		req.on?.('aborted', onRequestAborted);
		res.on?.('close', onResponseClose);
		if (req.aborted) {
			requestCancellation.cancel();
		}
		try {
			if (req.method === 'GET' && !relativePath) {
				return this.writeProjects(res, 200, await service.getProjects());
			}

			if (req.method === 'POST' && !relativePath) {
				const body = await this.readJson(req);
				const result = await this.runDurableMutation(async () => {
					const project = await service.addProject(
						URI.file(requireString(body, 'rootPath')),
					);
					return {
						project,
						projects: await service.getProjects(),
					};
				}, requestCancellation.token);
				return this.writeJson(res, 201, {
					project: result.project,
					projects: result.projects,
				});
			}

			if (req.method === 'DELETE' && isSinglePathSegment(relativePath)) {
				const projects = await this.runDurableMutation(async () => {
					const projectId = decodeURIComponent(relativePath);
					if ((await service.getProjects()).some(
						project => project.id === projectId
					)) {
						await service.removeProject(projectId);
					}
					return service.getProjects();
				}, requestCancellation.token);
				return this.writeProjects(res, 200, projects);
			}

			if (req.method === 'DELETE') {
				return this.writeJson(res, 404, { error: 'Not found.' });
			}

			if (req.method === 'POST') {
				return await this.handlePost(
					service,
					res,
					relativePath,
					await this.readJson(req),
					requestCancellation.token
				);
			}

			return this.writeJson(res, 405, {
				error: `Unsupported method ${req.method}`,
			});
		} catch (error) {
			if (isCancellationError(error) &&
				requestCancellation.token.isCancellationRequested) {
				return true;
			}
			return this.writeRequestError(res, error);
		} finally {
			req.removeListener?.('aborted', onRequestAborted);
			res.removeListener?.('close', onResponseClose);
			requestCancellation.dispose();
		}
	}

	async getProjects(): Promise<readonly ProjectRecord[]> {
		return this.service ? this.service.getProjects() : [];
	}

	/**
	 * Waits for queued project state writes. Production writes hold a server
	 * lifetime consumer lease until they settle; this explicit join supports
	 * diagnostics and tests rather than owning production shutdown.
	 */
	async flushState(): Promise<void> {
		await this.stateService?.close();
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.mutationQueue.dispose();
		this.gitReadLimiter.dispose();
		const service = this.service;
		if (service) {
			this.mutationQueue.runWhenIdle(() => {
				try {
					service.dispose();
				} catch (error) {
					this.logService.error(
						'[Hucode Projects] Failed to dispose project manager.',
						error
					);
				}
			});
		}
		this.pendingProjectPublication = undefined;
		for (const client of Array.from(this.eventClients)) {
			this.removeEventClient(client);
		}
		super.dispose();
	}

	private async handlePost(
		service: ProjectManagerMainService,
		res: HucodeWebProjectManagerResponse,
		relativePath: string,
		body: unknown,
		token: CancellationToken,
	): Promise<boolean> {
		const [projectId, ...parts] = relativePath
			.split('/')
			.map(decodeURIComponent);
		const command = parts.join('/');

		if (relativePath === 'refresh') {
			const projects = await this.runDurableMutation(
				() => service.refresh(),
				token
			);
			return this.writeProjects(res, 200, projects);
		}

		if (!projectId) {
			return this.writeJson(res, 404, { error: 'Not found.' });
		}

		switch (command) {
			case 'refresh':
				{
					const projects = await this.runDurableMutation(
						() => service.refresh(projectId),
						token
					);
					return this.writeProjects(res, 200, projects);
				}
			case 'label':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.renameProject(
							projectId,
							requireString(body, 'label'),
						);
						return service.getProjects();
					}, token);
					return this.writeProjects(res, 200, projects);
				}
			case 'label/reset':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.resetProjectLabel(projectId);
						return service.getProjects();
					}, token);
					return this.writeProjects(res, 200, projects);
				}
			case 'pinned':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.setPinned(
							projectId,
							requireBoolean(body, 'pinned')
						);
						return service.getProjects();
					}, token);
					return this.writeProjects(res, 200, projects);
				}
			case 'move':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.moveProject(
							projectId,
							optionalString(body, 'beforeProjectId'),
						);
						return service.getProjects();
					}, token);
					return this.writeProjects(res, 200, projects);
				}
			case 'worktrees/refs':
				return this.writeJson(res, 200, {
					refs: await this.runGitRead(token, () =>
						service.getWorktreeRefs(
							projectId,
							optionalObject(body, 'options') as
							| WorktreeRefQueryOptions
							| undefined,
							token
						)
					),
				});
			case 'worktrees/branch-name':
				return this.writeJson(res, 200, {
					valid: await this.runGitRead(token, () =>
						service.isValidBranchName(
							projectId,
							requireString(body, 'branchName'),
							token
						)
					),
				});
			case 'worktrees':
				{
					const result = await this.runDurableMutation(async () => ({
						worktree: await service.createWorktree(
							projectId,
							readCreateWorktreeOptions(body),
						),
						projects: await service.getProjects(),
					}), token);
					return this.writeJson(res, 201, result);
				}
			case 'worktrees/remove':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.removeWorktree(
							projectId,
							requireString(body, 'worktreePath'),
						);
						return service.getProjects();
					}, token);
					return this.writeProjects(res, 200, projects);
				}
			case 'worktrees/move':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.moveWorktree(
							projectId,
							requireString(body, 'worktreePath'),
							optionalString(body, 'beforeWorktreePath'),
						);
						return service.getProjects();
					}, token);
					return this.writeProjects(res, 200, projects);
				}
			case 'worktrees/label':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.renameWorktree(
							projectId,
							requireString(body, 'worktreePath'),
							requireString(body, 'label'),
						);
						return service.getProjects();
					}, token);
					return this.writeProjects(res, 200, projects);
				}
			case 'worktrees/label/reset':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.resetWorktreeLabel(
							projectId,
							requireString(body, 'worktreePath'),
						);
						return service.getProjects();
					}, token);
					return this.writeProjects(res, 200, projects);
				}
			case 'worktrees/pinned':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.setWorktreePinned(
							projectId,
							requireString(body, 'worktreePath'),
							requireBoolean(body, 'pinned'),
						);
						return service.getProjects();
					}, token);
					return this.writeProjects(res, 200, projects);
				}
			case 'worktrees/last-active':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.setLastActiveWorktree(
							projectId,
							requireString(body, 'worktreePath'),
						);
						return service.getProjects();
					}, token);
					return this.writeProjects(res, 200, projects);
				}
		}

		return this.writeJson(res, 404, { error: 'Not found.' });
	}

	private async runDurableMutation<T>(
		mutation: () => Promise<T>,
		token: CancellationToken
	): Promise<T> {
		let result: T | undefined;
		await this.mutationQueue.queue(async () => {
			this.throwIfCanceled(token);
			await this.stateService?.retryDirtyState();
			try {
				this.throwIfCanceled(token);
				const writeGeneration =
					this.stateService?.currentWriteGeneration ?? 0;
				// Once the mutation starts, it is intentionally detached from
				// the request token. Git create/remove and the state flush must
				// finish even when the browser disconnects.
				result = await mutation();
				await this.stateService?.flushWritesAfter(writeGeneration);
			} finally {
				this.retryPendingProjectPublication();
			}
		}, token);
		this.throwIfCanceled(token);
		return result!;
	}

	private async runGitRead<T>(
		token: CancellationToken,
		read: () => Promise<T>
	): Promise<T> {
		this.throwIfCanceled(token);
		const queued = this.gitReadLimiter.queue(async () => {
			this.throwIfCanceled(token);
			return read();
		}, token);
		return raceCancellationError(queued, token);
	}

	private throwIfCanceled(token: CancellationToken): void {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
	}

	private async readJson(
		req: HucodeWebProjectManagerRequest
	): Promise<unknown> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.byteLength;
			if (size > MAX_JSON_BODY_BYTES) {
				throw new BadRequestError(
					`Request body exceeds ${MAX_JSON_BODY_BYTES} bytes.`
				);
			}
			chunks.push(buffer);
		}
		if (!chunks.length) {
			return {};
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new BadRequestError('Invalid JSON request body.');
			}
			throw error;
		}
	}

	private writeProjects(
		res: HucodeWebProjectManagerResponse,
		status: number,
		projects: readonly ProjectRecord[],
	): true {
		return this.writeJson(res, status, { projects });
	}

	private writeJson(
		res: HucodeWebProjectManagerResponse,
		status: number,
		body: unknown,
		headers: http.OutgoingHttpHeaders = {},
	): true {
		res.writeHead(status, {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...headers,
		});
		res.end(JSON.stringify(body));
		return true;
	}

	private writeRequestError(
		res: HucodeWebProjectManagerResponse,
		error: unknown
	): true {
		if (error instanceof ProjectRequestAdmissionError) {
			return this.writeJson(
				res,
				503,
				{ error: error.message, code: error.code },
				{ 'Retry-After': '1' }
			);
		}
		if (error instanceof ProjectStateUnavailableError) {
			return this.writeJson(res, 503, {
				error: error.message,
				code: error.code,
			});
		}
		const message = error instanceof Error ? error.message : String(error);
		const status = error instanceof BadRequestError ? 400 : 500;
		return this.writeJson(res, status, { error: message });
	}

	private async handleEvents(
		service: ProjectManagerMainService,
		req: HucodeWebProjectManagerRequest,
		res: HucodeWebProjectManagerResponse
	): Promise<true> {
		if (this.disposed) {
			return this.writeEventClientUnavailableError(res);
		}
		if (this.eventClients.size >= this.eventClientLimit) {
			return this.writeEventClientCapacityError(res);
		}

		const client: HucodeWebProjectEventClient = {
			req,
			res,
			closed: false,
			ready: false,
			pendingInitialProjects: undefined,
			blocked: false,
			pendingFrame: undefined,
			drainListening: false,
			heartbeatTimer: undefined,
			backpressureTimer: undefined,
			onTerminated: () => { },
			onDrain: () => { },
		};
		client.onTerminated = () => this.removeEventClient(client);
		client.onDrain = () => this.drainEventClient(client);
		this.eventClients.add(client);
		req.on?.('aborted', client.onTerminated);
		res.on?.('close', client.onTerminated);
		res.on?.('error', client.onTerminated);

		let projects: readonly ProjectRecord[];
		try {
			projects = await service.getProjects();
			const writeGeneration =
				this.stateService?.currentWriteGeneration ?? 0;
			await this.stateService?.retryDirtyState();
			this.retryPendingProjectPublication();
			await this.stateService?.flushWritesThrough(writeGeneration);
		} catch (error) {
			if (client.closed) {
				return true;
			}
			this.removeEventClient(client, false);
			throw error;
		}

		if (client.closed || this.disposed) {
			this.removeEventClient(client);
			return true;
		}

		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-store',
			Connection: 'keep-alive',
		});
		const initialProjects = client.pendingInitialProjects ?? projects;
		client.pendingInitialProjects = undefined;
		client.ready = true;
		this.writeProjectsEvent(
			client,
			initialProjects,
			`: connected\n\nretry: ${EVENT_RETRY_MS}\n\n`
		);
		if (!client.closed) {
			client.heartbeatTimer = setInterval(() => {
				this.writeEventFrame(client, ': heartbeat\n\n', false);
			}, this.eventHeartbeatIntervalMs);
		}
		return true;
	}

	private writeEventClientCapacityError(
		res: HucodeWebProjectManagerResponse
	): true {
		return this.writeJson(
			res,
			503,
			{ error: 'Project event stream capacity reached.' },
			{ 'Retry-After': '1' }
		);
	}

	private writeEventClientUnavailableError(
		res: HucodeWebProjectManagerResponse
	): true {
		return this.writeJson(
			res,
			503,
			{ error: 'Project event stream is unavailable.' },
			{ 'Retry-After': '1' }
		);
	}

	private queueProjectsPublication(
		projects: readonly ProjectRecord[]
	): void {
		const publication = {
			id: ++this.nextProjectPublicationId,
			generation: this.stateService?.currentWriteGeneration ?? 0,
			projects,
		};
		this.pendingProjectPublication = publication;
		void this.publishProjectsWhenDurable(publication);
	}

	private async publishProjectsWhenDurable(
		publication: NonNullable<
			HucodeWebProjectManagerServer['pendingProjectPublication']
		>
	): Promise<void> {
		try {
			await this.stateService?.flushWritesThrough(
				publication.generation
			);
		} catch (error) {
			this.logService.warn(
				`[Hucode Projects] Deferred project event publication: ${error}`
			);
			return;
		}
		if (this.disposed ||
			this.pendingProjectPublication?.id !== publication.id) {
			return;
		}
		this.pendingProjectPublication = undefined;
		this.broadcastProjects(publication.projects);
	}

	private retryPendingProjectPublication(): void {
		const publication = this.pendingProjectPublication;
		if (!publication) {
			return;
		}
		const generation =
			this.stateService?.currentWriteGeneration ?? 0;
		const retry = publication.generation === generation
			? publication
			: {
				id: ++this.nextProjectPublicationId,
				generation,
				projects: publication.projects,
			};
		this.pendingProjectPublication = retry;
		void this.publishProjectsWhenDurable(retry);
	}

	private broadcastProjects(projects: readonly ProjectRecord[]): void {
		for (const client of this.eventClients) {
			if (client.ready) {
				this.writeProjectsEvent(client, projects);
			} else {
				client.pendingInitialProjects = projects;
			}
		}
	}

	private writeProjectsEvent(
		client: HucodeWebProjectEventClient,
		projects: readonly ProjectRecord[],
		prefix = ''
	): void {
		this.writeEventFrame(
			client,
			`${prefix}event: projects\n` +
			`data: ${JSON.stringify({ projects })}\n\n`
		);
	}

	private writeEventFrame(
		client: HucodeWebProjectEventClient,
		frame: string,
		coalesce = true
	): void {
		if (client.closed) {
			return;
		}
		if (client.blocked) {
			if (coalesce) {
				client.pendingFrame = frame;
			}
			return;
		}

		try {
			if (client.res.write?.(frame) === false) {
				client.blocked = true;
				client.backpressureTimer ??= setTimeout(() => {
					client.backpressureTimer = undefined;
					if (client.blocked) {
						this.removeEventClient(client);
					}
				}, this.eventBackpressureTimeoutMs);
				if (!client.drainListening) {
					client.drainListening = true;
					client.res.on?.('drain', client.onDrain);
				}
			}
		} catch {
			this.removeEventClient(client);
		}
	}

	private drainEventClient(client: HucodeWebProjectEventClient): void {
		if (client.closed) {
			return;
		}
		if (client.drainListening) {
			client.res.removeListener?.('drain', client.onDrain);
			client.drainListening = false;
		}
		client.blocked = false;
		if (client.backpressureTimer) {
			clearTimeout(client.backpressureTimer);
			client.backpressureTimer = undefined;
		}

		const pendingFrame = client.pendingFrame;
		client.pendingFrame = undefined;
		if (pendingFrame !== undefined) {
			this.writeEventFrame(client, pendingFrame);
		}
	}

	private removeEventClient(
		client: HucodeWebProjectEventClient,
		endResponse = true
	): void {
		if (client.closed) {
			return;
		}
		client.closed = true;
		this.eventClients.delete(client);
		client.req.removeListener?.('aborted', client.onTerminated);
		client.res.removeListener?.('close', client.onTerminated);
		client.res.removeListener?.('error', client.onTerminated);
		if (client.drainListening) {
			client.res.removeListener?.('drain', client.onDrain);
			client.drainListening = false;
		}
		client.pendingInitialProjects = undefined;
		client.pendingFrame = undefined;
		if (client.heartbeatTimer) {
			clearInterval(client.heartbeatTimer);
			client.heartbeatTimer = undefined;
		}
		if (client.backpressureTimer) {
			clearTimeout(client.backpressureTimer);
			client.backpressureTimer = undefined;
		}
		if (endResponse) {
			try {
				client.res.end();
			} catch {
				// The response can already be closed or failed.
			}
		}
	}
}

class BadRequestError extends Error { }

class ProjectRequestAdmissionError extends Error {
	constructor(
		message: string,
		readonly code: string
	) {
		super(message);
	}
}

class ProjectRequestCapacityError extends ProjectRequestAdmissionError {
	constructor() {
		super(
			'Project request capacity reached.',
			'PROJECT_REQUEST_CAPACITY'
		);
	}
}

class ProjectRequestUnavailableError extends ProjectRequestAdmissionError {
	constructor() {
		super(
			'Project request queue is unavailable.',
			'PROJECT_REQUEST_UNAVAILABLE'
		);
	}
}

class ProjectStateUnavailableError extends Error {
	readonly code = 'PROJECT_STATE_UNAVAILABLE';

	constructor() {
		super('Project state is temporarily unavailable.');
	}
}

class InvalidProjectStateError extends Error { }

function requireString(body: unknown, key: string): string {
	const value = readProperty(body, key);
	if (typeof value !== 'string' || !value.trim()) {
		throw new BadRequestError(`Missing ${key}.`);
	}
	return value.trim();
}

function optionalString(body: unknown, key: string): string | undefined {
	const value = readProperty(body, key);
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireBoolean(body: unknown, key: string): boolean {
	const value = readProperty(body, key);
	if (typeof value !== 'boolean') {
		throw new BadRequestError(`Missing ${key}.`);
	}
	return value;
}

function optionalObject(body: unknown, key: string): object | undefined {
	const value = readProperty(body, key);
	return value && typeof value === 'object' ? value : undefined;
}

function readCreateWorktreeOptions(body: unknown): CreateWorktreeOptions {
	const value = readProperty(body, 'options');
	if (value === undefined) {
		return {};
	}
	if (!isRecord(value)) {
		throw new BadRequestError('Invalid options.');
	}

	const branchName = readOptionalWorktreeString(value, 'branchName');
	const path = readOptionalWorktreeString(value, 'path');
	const startPointValue = readProperty(value, 'startPoint');
	let startPoint: string | undefined;
	if (startPointValue !== undefined) {
		if (typeof startPointValue !== 'string') {
			throw new BadRequestError('Invalid options.startPoint.');
		}
		startPoint = startPointValue.trim();
		if (!startPoint || startPoint.startsWith('-')) {
			throw new BadRequestError('Invalid options.startPoint.');
		}
	}

	const detachedValue = readProperty(value, 'detached');
	if (detachedValue !== undefined && typeof detachedValue !== 'boolean') {
		throw new BadRequestError('Invalid options.detached.');
	}

	return {
		...(branchName !== undefined ? { branchName } : {}),
		...(startPoint !== undefined ? { startPoint } : {}),
		...(detachedValue !== undefined ? { detached: detachedValue } : {}),
		...(path !== undefined ? { path } : {}),
	};
}

function readOptionalWorktreeString(
	options: Record<string, unknown>,
	key: 'branchName' | 'path'
): string | undefined {
	const value = readProperty(options, key);
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new BadRequestError(`Invalid options.${key}.`);
	}
	return value;
}

function readProperty(body: unknown, key: string): unknown {
	return body && typeof body === 'object'
		? (body as Record<string, unknown>)[key]
		: undefined;
}

function isStoredProjectManagerState(
	value: unknown
): value is StoredProjectManagerState {
	if (!isRecord(value) ||
		value.version !== PROJECT_MANAGER_STORAGE_VERSION ||
		!Array.isArray(value.projects)) {
		return false;
	}
	return value.projects.every(isStoredProjectRecord);
}

function isStoredProjectRecord(value: unknown): value is StoredProjectRecord {
	if (!isRecord(value) ||
		typeof value.id !== 'string' ||
		typeof value.label !== 'string' ||
		typeof value.rootPath !== 'string' ||
		typeof value.pinned !== 'boolean' ||
		!isFiniteNumber(value.order)) {
		return false;
	}

	return isOptionalString(value.lastActiveWorktreePath) &&
		isOptionalStringArray(value.worktreeOrder) &&
		isOptionalStringArray(value.pinnedWorktreePaths) &&
		isOptionalArray(value.worktreeLabels, item =>
			isRecord(item) &&
			typeof item.path === 'string' &&
			typeof item.label === 'string'
		) &&
		isOptionalArray(value.worktreeVisits, item =>
			isRecord(item) &&
			typeof item.path === 'string' &&
			isFiniteNumber(item.lastVisitedAt)
		);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === 'string';
}

function isOptionalStringArray(
	value: unknown
): value is readonly string[] | undefined {
	return value === undefined ||
		(Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function isOptionalArray(
	value: unknown,
	guard: (item: unknown) => boolean
): boolean {
	return value === undefined ||
		(Array.isArray(value) && value.every(guard));
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error &&
		(error as NodeJS.ErrnoException).code === code;
}

function isSinglePathSegment(path: string): boolean {
	return !!path && !path.includes('/');
}

function getCrossOriginRequestError(
	headers: http.IncomingHttpHeaders | undefined
): string | undefined {
	const origin = headers?.origin;
	if (!origin) {
		// Same-origin GET/EventSource requests and non-browser clients do
		// not send an Origin header; the connection token still applies.
		return undefined;
	}

	let originUrl: URL;
	try {
		originUrl = new URL(origin);
	} catch {
		return 'Invalid request origin.';
	}

	const requestHost = getRequestHost(headers);
	if (!requestHost) {
		return 'Cross-origin request rejected.';
	}

	// Normalize the request host through the origin's protocol so a default
	// port on either side (e.g. an `x-forwarded-host` of `host:443` against an
	// `Origin` of `https://host`) does not read as cross-origin. URL.host
	// strips the default port for the scheme, giving both sides one form.
	let normalizedRequestHost: string;
	try {
		normalizedRequestHost = new URL(
			`${originUrl.protocol}//${requestHost}`
		).host;
	} catch {
		return 'Cross-origin request rejected.';
	}

	if (originUrl.host.toLowerCase() !== normalizedRequestHost.toLowerCase()) {
		return 'Cross-origin request rejected.';
	}

	return undefined;
}

function getRequestHost(
	headers: http.IncomingHttpHeaders | undefined
): string | undefined {
	const forwardedHost = headers?.['x-forwarded-host'];
	const firstForwardedHost = Array.isArray(forwardedHost)
		? forwardedHost[0]
		: forwardedHost;
	const host = firstForwardedHost?.split(',')[0].trim() || headers?.host;
	return host?.trim() || undefined;
}

function hasJsonContentType(
	headers: http.IncomingHttpHeaders | undefined
): boolean {
	const contentType = headers?.['content-type'];
	return typeof contentType === 'string' &&
		contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}
