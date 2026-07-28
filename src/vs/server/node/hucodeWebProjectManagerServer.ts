/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type * as http from 'http';
import { Queue } from '../../base/common/async.js';
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
	on?(event: 'close', listener: () => void): unknown;
}

interface HucodeWebProjectManagerResponse {
	writeHead(status: number, headers?: http.OutgoingHttpHeaders): unknown;
	write?(data: string): unknown;
	end(data?: string): unknown;
}

interface HucodeWebProjectEventClient {
	readonly res: HucodeWebProjectManagerResponse;
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
	private latestWriteGeneration = 0;
	private latestWrite: Promise<void> = Promise.resolve();
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
		await this.queueStateWrite(this.state, this.stateVersion);
	}

	get currentWriteGeneration(): number {
		return this.writeGeneration;
	}

	async flushWritesAfter(generation: number): Promise<void> {
		if (this.latestWriteGeneration > generation) {
			await this.latestWrite;
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
		this.latestWriteGeneration = generation;
		this.latestWrite = write;
		// setItem cannot return the write promise. Attach a rejection handler
		// immediately; flushWritesAfter and close still report the stored error.
		void write.catch(() => { });
		return write;
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

/**
 * HTTP adapter for the serve-web Project Manager service.
 */
export class HucodeWebProjectManagerServer extends Disposable {
	private readonly service: ProjectManagerMainService | undefined;
	private readonly stateService: HucodeProjectFileStateService | undefined;
	private readonly mutationQueue = new Queue<void>();
	private readonly eventClients = new Set<HucodeWebProjectEventClient>();

	constructor(
		serverDataPath: string,
		logService: ILogService,
		options: {
			readonly enabled: boolean;
			readonly fileSystem?: HucodeProjectStateFileSystem;
			readonly acquireStateWriteLease?: () => IDisposable;
		} = { enabled: true },
	) {
		super();

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
		this.service = this._register(new ProjectManagerMainService(
			this.stateService,
			logService,
			{ metadataWatcher: new HucodeNodeProjectMetadataWatcher(logService) },
		));
		this._register(this.service.onDidChangeProjects(projects => {
			this.broadcastProjects(projects);
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

		try {
			const relativePath = pathname
				.substring(HUCODE_WEB_PROJECTS_API_PATH.length)
				.replace(/^\/+/, '');

			if (req.method === 'GET' && relativePath === 'events') {
				return this.handleEvents(service, req, res);
			}

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
				});
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
				});
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
					await this.readJson(req)
				);
			}

			return this.writeJson(res, 405, {
				error: `Unsupported method ${req.method}`,
			});
		} catch (error) {
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
		super.dispose();
		for (const client of this.eventClients) {
			client.res.end();
		}
		this.eventClients.clear();
	}

	private async handlePost(
		service: ProjectManagerMainService,
		res: HucodeWebProjectManagerResponse,
		relativePath: string,
		body: unknown,
	): Promise<boolean> {
		const [projectId, ...parts] = relativePath
			.split('/')
			.map(decodeURIComponent);
		const command = parts.join('/');

		if (relativePath === 'refresh') {
			const projects = await this.runDurableMutation(
				() => service.refresh()
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
						() => service.refresh(projectId)
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
					});
					return this.writeProjects(res, 200, projects);
				}
			case 'label/reset':
				{
					const projects = await this.runDurableMutation(async () => {
						await service.resetProjectLabel(projectId);
						return service.getProjects();
					});
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
					});
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
					});
					return this.writeProjects(res, 200, projects);
				}
			case 'worktrees/refs':
				return this.writeJson(res, 200, {
					refs: await service.getWorktreeRefs(
						projectId,
						optionalObject(body, 'options') as
						| WorktreeRefQueryOptions
						| undefined,
					),
				});
			case 'worktrees/branch-name':
				return this.writeJson(res, 200, {
					valid: await service.isValidBranchName(
						projectId,
						requireString(body, 'branchName'),
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
					}));
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
					});
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
					});
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
					});
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
					});
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
					});
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
					});
					return this.writeProjects(res, 200, projects);
				}
		}

		return this.writeJson(res, 404, { error: 'Not found.' });
	}

	private async runDurableMutation<T>(
		mutation: () => Promise<T>
	): Promise<T> {
		let result: T | undefined;
		await this.mutationQueue.queue(async () => {
			await this.stateService?.retryDirtyState();
			const writeGeneration =
				this.stateService?.currentWriteGeneration ?? 0;
			result = await mutation();
			await this.stateService?.flushWritesAfter(writeGeneration);
		});
		return result!;
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
	): true {
		res.writeHead(status, {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
		});
		res.end(JSON.stringify(body));
		return true;
	}

	private async handleEvents(
		service: ProjectManagerMainService,
		req: HucodeWebProjectManagerRequest,
		res: HucodeWebProjectManagerResponse
	): Promise<true> {
		const projects = await service.getProjects();

		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-store',
			Connection: 'keep-alive',
		});

		const client: HucodeWebProjectEventClient = { res };
		this.eventClients.add(client);
		req.on?.('close', () => {
			this.eventClients.delete(client);
		});

		res.write?.(': connected\n\n');
		this.writeProjectsEvent(client, projects);
		return true;
	}

	private broadcastProjects(projects: readonly ProjectRecord[]): void {
		for (const client of this.eventClients) {
			this.writeProjectsEvent(client, projects);
		}
	}

	private writeProjectsEvent(
		client: HucodeWebProjectEventClient,
		projects: readonly ProjectRecord[]
	): void {
		client.res.write?.(`event: projects\n`);
		client.res.write?.(`data: ${JSON.stringify({ projects })}\n\n`);
	}
}

class BadRequestError extends Error { }

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
