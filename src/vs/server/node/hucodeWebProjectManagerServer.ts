/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type * as http from 'http';
import { Disposable, IDisposable, toDisposable } from
	'../../base/common/lifecycle.js';
import { join } from '../../base/common/path.js';
import { URI } from '../../base/common/uri.js';
import { ILogService } from '../../platform/log/common/log.js';
import {
	CreateWorktreeOptions,
	PROJECT_MANAGER_STORAGE_KEY,
	ProjectRecord,
	StoredProjectManagerState,
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

class HucodeProjectFileStateService implements IStateService {
	declare readonly _serviceBrand: undefined;

	private readonly storagePath: string;
	private state: StoredProjectManagerState | undefined;
	private loaded = false;
	private lastWrite: Promise<void> = Promise.resolve();

	constructor(
		private readonly serverDataPath: string,
		private readonly logService: ILogService,
	) {
		this.storagePath = join(serverDataPath, 'hucode', 'projects.json');
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

		this.state = undefined;
		this.writeState();
	}

	async close(): Promise<void> {
		await this.lastWrite;
	}

	private ensureLoaded(): void {
		if (this.loaded) {
			return;
		}

		try {
			this.state = JSON.parse(
				fs.readFileSync(this.storagePath, 'utf8'),
			) as StoredProjectManagerState;
		} catch (error) {
			this.state = undefined;
			if (
				!(error instanceof Error) ||
				(error as NodeJS.ErrnoException).code !== 'ENOENT'
			) {
				this.preserveUnreadableStateFile(error);
			}
		}
		this.loaded = true;
	}

	/**
	 * An unreadable state file must not permanently fail every Projects API
	 * request, so fall back to empty state and keep the file for inspection.
	 */
	private preserveUnreadableStateFile(error: unknown): void {
		const preservePath = `${this.storagePath}.corrupt`;
		this.logService.error(
			'[Hucode Projects] Failed to load stored projects; ' +
			`continuing with empty state (${this.storagePath})`,
			error,
		);
		try {
			fs.renameSync(this.storagePath, preservePath);
			this.logService.info(
				`[Hucode Projects] Preserved unreadable state as ${preservePath}`,
			);
		} catch (renameError) {
			this.logService.error(
				`[Hucode Projects] Could not preserve ${this.storagePath}`,
				renameError,
			);
		}
	}

	private writeState(): void {
		// IStateService writes are fire-and-forget; chain them so the HTTP
		// request path never blocks on disk and writes stay ordered.
		const state = this.state;
		this.lastWrite = this.lastWrite
			.then(async () => {
				await fs.promises.mkdir(
					join(this.serverDataPath, 'hucode'),
					{ recursive: true },
				);
				if (!state) {
					await fs.promises.rm(this.storagePath, { force: true });
					return;
				}

				await fs.promises.writeFile(
					this.storagePath,
					`${JSON.stringify(state, null, '\t')}\n`,
				);
			})
			.catch(error => this.logService.error(error));
	}
}

class HucodeNodeProjectMetadataWatcher implements IProjectMetadataWatcher {
	watch(path: string, onDidChange: () => void): IDisposable {
		const watcher = fs.watch(path, { persistent: false }, () => onDidChange());
		return toDisposable(() => watcher.close());
	}
}

/**
 * HTTP adapter for the serve-web Project Manager service.
 */
export class HucodeWebProjectManagerServer extends Disposable {
	private readonly service: ProjectManagerMainService | undefined;
	private readonly stateService: HucodeProjectFileStateService | undefined;
	private readonly eventClients = new Set<HucodeWebProjectEventClient>();

	constructor(
		serverDataPath: string,
		logService: ILogService,
		options: { readonly enabled: boolean } = { enabled: true },
	) {
		super();

		if (!options.enabled) {
			return;
		}

		this.stateService =
			new HucodeProjectFileStateService(serverDataPath, logService);
		this.service = this._register(new ProjectManagerMainService(
			this.stateService,
			logService,
			{ metadataWatcher: new HucodeNodeProjectMetadataWatcher() },
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
				const project = await service.addProject(
					URI.file(requireString(body, 'rootPath')),
				);
				return this.writeJson(res, 201, {
					project,
					projects: await service.getProjects(),
				});
			}

			if (req.method === 'DELETE' && isSinglePathSegment(relativePath)) {
				await service.removeProject(decodeURIComponent(relativePath));
				return this.writeProjects(res, 200, await service.getProjects());
			}

			if (req.method === 'DELETE') {
				return this.writeJson(res, 404, { error: 'Not found.' });
			}

			if (req.method === 'POST') {
				return this.handlePost(
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
			const message = error instanceof Error ? error.message : String(error);
			const status = error instanceof BadRequestError ? 400 : 500;
			return this.writeJson(res, status, { error: message });
		}
	}

	async getProjects(): Promise<readonly ProjectRecord[]> {
		return this.service ? this.service.getProjects() : [];
	}

	/**
	 * Waits for queued project state writes to reach disk.
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
			return this.writeProjects(res, 200, await service.refresh());
		}

		if (!projectId) {
			return this.writeJson(res, 404, { error: 'Not found.' });
		}

		switch (command) {
			case 'refresh':
				return this.writeProjects(
					res,
					200,
					await service.refresh(projectId),
				);
			case 'label':
				await service.renameProject(
					projectId,
					requireString(body, 'label'),
				);
				return this.writeProjects(res, 200, await service.getProjects());
			case 'label/reset':
				await service.resetProjectLabel(projectId);
				return this.writeProjects(res, 200, await service.getProjects());
			case 'pinned':
				await service.setPinned(projectId, requireBoolean(body, 'pinned'));
				return this.writeProjects(res, 200, await service.getProjects());
			case 'move':
				await service.moveProject(
					projectId,
					optionalString(body, 'beforeProjectId'),
				);
				return this.writeProjects(res, 200, await service.getProjects());
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
				return this.writeJson(res, 201, {
					worktree: await service.createWorktree(
						projectId,
						(optionalObject(body, 'options') ?? {}) as CreateWorktreeOptions,
					),
					projects: await service.getProjects(),
				});
			case 'worktrees/remove':
				await service.removeWorktree(
					projectId,
					requireString(body, 'worktreePath'),
				);
				return this.writeProjects(res, 200, await service.getProjects());
			case 'worktrees/move':
				await service.moveWorktree(
					projectId,
					requireString(body, 'worktreePath'),
					optionalString(body, 'beforeWorktreePath'),
				);
				return this.writeProjects(res, 200, await service.getProjects());
			case 'worktrees/label':
				await service.renameWorktree(
					projectId,
					requireString(body, 'worktreePath'),
					requireString(body, 'label'),
				);
				return this.writeProjects(res, 200, await service.getProjects());
			case 'worktrees/label/reset':
				await service.resetWorktreeLabel(
					projectId,
					requireString(body, 'worktreePath'),
				);
				return this.writeProjects(res, 200, await service.getProjects());
			case 'worktrees/pinned':
				await service.setWorktreePinned(
					projectId,
					requireString(body, 'worktreePath'),
					requireBoolean(body, 'pinned'),
				);
				return this.writeProjects(res, 200, await service.getProjects());
			case 'worktrees/last-active':
				await service.setLastActiveWorktree(
					projectId,
					requireString(body, 'worktreePath'),
				);
				return this.writeProjects(res, 200, await service.getProjects());
		}

		return this.writeJson(res, 404, { error: 'Not found.' });
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

function readProperty(body: unknown, key: string): unknown {
	return body && typeof body === 'object'
		? (body as Record<string, unknown>)[key]
		: undefined;
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

	let originHost: string;
	try {
		originHost = new URL(origin).host;
	} catch {
		return 'Invalid request origin.';
	}

	const requestHost = getRequestHost(headers);
	if (
		!requestHost ||
		originHost.toLowerCase() !== requestHost.toLowerCase()
	) {
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
