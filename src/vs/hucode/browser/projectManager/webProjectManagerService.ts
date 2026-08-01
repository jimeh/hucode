/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { mainWindow } from '../../../base/browser/window.js';
import { localize } from '../../../nls.js';
import { InstantiationType, registerSingleton } from
	'../../../platform/instantiation/common/extensions.js';
import {
	CreateWorktreeOptions,
	GitWorktreeTargetChange,
	GitWorktreeTargetObservation,
	IProjectManagerService,
	ProjectRecord,
	RemoveWorktreeOptions,
	RemoveWorktreeResult,
	WorktreeRecord,
	WorktreeRefQueryOptions,
	WorktreeRefRecord,
	WorktreeStatusPreview,
} from '../../../platform/projectManager/common/projectManager.js';
import { IBrowserWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/browser/environmentService.js';
import { getHucodeOmniProjectsApi } from '../../../platform/environment/common/hucodeWebConfiguration.js';

interface ProjectsResponse {
	readonly projects: readonly ProjectRecord[];
}

interface ProjectResponse extends ProjectsResponse {
	readonly project: ProjectRecord;
}

interface WorktreeResponse extends ProjectsResponse {
	readonly worktree: WorktreeRecord;
}

interface WorktreeRefsResponse {
	readonly refs: readonly WorktreeRefRecord[];
}

interface BranchNameResponse {
	readonly valid: boolean;
}

interface WorktreeStatusResponse {
	readonly status: WorktreeStatusPreview;
}

interface RemoveWorktreeResponse extends ProjectsResponse {
	readonly result: RemoveWorktreeResult;
}

export interface IWebProjectManagerServiceTransport {
	readonly fetch: WebProjectManagerFetch;
	readonly EventSource?: IWebProjectManagerEventSourceConstructor;
}

export type WebProjectManagerFetch = (
	input: RequestInfo | URL,
	init?: RequestInit
) => Promise<Response>;

export interface IWebProjectManagerEventSource {
	addEventListener(type: string, listener: (event: Event) => void): void;
	close(): void;
}

export interface IWebProjectManagerEventSourceConstructor {
	new(
		url: string | URL,
		eventSourceInitDict?: EventSourceInit
	): IWebProjectManagerEventSource;
}

function defaultWebProjectManagerTransport(): IWebProjectManagerServiceTransport {
	return {
		fetch: (input, init) => globalThis.fetch(input, init),
		EventSource: typeof mainWindow.EventSource === 'function'
			? mainWindow.EventSource
			: undefined,
	};
}

/**
 * Browser-side Project Manager client for the serve-web Omni shell.
 */
export class WebProjectManagerClient extends Disposable
	implements IProjectManagerService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProjects =
		this._register(new Emitter<readonly ProjectRecord[]>());
	readonly onDidChangeProjects = this._onDidChangeProjects.event;
	private readonly _onDidChangeGitWorktreeTargets = this._register(
		new Emitter<GitWorktreeTargetChange>()
	);
	readonly onDidChangeGitWorktreeTargets =
		this._onDidChangeGitWorktreeTargets.event;
	private eventSessionReady = new DeferredPromise<void>();
	private readonly gitWorktreeTargetPaths =
		new Map<string, readonly string[]>();
	private readonly gitWorktreeTargetRegistrations = new Map<
		string,
		{
			readonly generation: number;
			readonly targetPaths: readonly string[];
			readonly promise: Promise<readonly GitWorktreeTargetObservation[]>;
		}
	>();
	private eventConnectionGeneration = 0;
	private hasEventSource = false;
	private eventConnected = false;

	constructor(
		private readonly projectsApi: string,
		private readonly transport: IWebProjectManagerServiceTransport =
			defaultWebProjectManagerTransport(),
		private readonly eventSessionId: string = generateUuid(),
	) {
		super();

		this.registerProjectEvents(transport);
	}

	async getProjects(): Promise<readonly ProjectRecord[]> {
		return this.readProjectsResponse(
			await this.request<ProjectsResponse>('', { method: 'GET' })
		);
	}

	async addProject(uri: URI): Promise<ProjectRecord> {
		return this.readProjectResponse(await this.request<ProjectResponse>('', {
			method: 'POST',
			body: { rootPath: uri.fsPath || uri.path },
		}));
	}

	async renameProject(id: string, label: string): Promise<void> {
		await this.writeProjectMutation(`${id}/label`, { label });
	}

	async resetProjectLabel(id: string): Promise<void> {
		await this.writeProjectMutation(`${id}/label/reset`, {});
	}

	async renameWorktree(
		projectId: string,
		worktreePath: string,
		label: string
	): Promise<void> {
		await this.writeProjectMutation(
			`${projectId}/worktrees/label`,
			{ worktreePath, label }
		);
	}

	async resetWorktreeLabel(
		projectId: string,
		worktreePath: string
	): Promise<void> {
		await this.writeProjectMutation(
			`${projectId}/worktrees/label/reset`,
			{ worktreePath }
		);
	}

	async setPinned(id: string, pinned: boolean): Promise<void> {
		await this.writeProjectMutation(`${id}/pinned`, { pinned });
	}

	async setWorktreePinned(
		projectId: string,
		worktreePath: string,
		pinned: boolean
	): Promise<void> {
		await this.writeProjectMutation(
			`${projectId}/worktrees/pinned`,
			{ worktreePath, pinned }
		);
	}

	async removeProject(id: string): Promise<void> {
		this.readProjectsResponse(await this.request<ProjectsResponse>(id, {
			method: 'DELETE',
		}));
	}

	async moveProject(
		id: string,
		beforeProjectId?: string
	): Promise<void> {
		await this.writeProjectMutation(`${id}/move`, { beforeProjectId });
	}

	async refresh(id?: string): Promise<readonly ProjectRecord[]> {
		return this.readProjectsResponse(await this.request<ProjectsResponse>(
			id ? `${id}/refresh` : 'refresh',
			{ method: 'POST', body: {} }
		));
	}

	async getWorktreeRefs(
		projectId: string,
		options?: WorktreeRefQueryOptions,
		token: CancellationToken = CancellationToken.None
	): Promise<readonly WorktreeRefRecord[]> {
		return (await this.request<WorktreeRefsResponse>(
			`${projectId}/worktrees/refs`,
			{ method: 'POST', body: { options } },
			token
		)).refs;
	}

	async isValidBranchName(
		projectId: string,
		branchName: string,
		token: CancellationToken = CancellationToken.None
	): Promise<boolean> {
		return (await this.request<BranchNameResponse>(
			`${projectId}/worktrees/branch-name`,
			{ method: 'POST', body: { branchName } },
			token
		)).valid;
	}

	async createWorktree(
		projectId: string,
		options: CreateWorktreeOptions
	): Promise<WorktreeRecord> {
		return this.readWorktreeResponse(
			await this.request<WorktreeResponse>(
				`${projectId}/worktrees`,
				{ method: 'POST', body: { options } }
			)
		);
	}

	async removeWorktree(
		projectId: string,
		worktreePath: string,
		options: RemoveWorktreeOptions
	): Promise<RemoveWorktreeResult> {
		const response = await this.request<RemoveWorktreeResponse>(
			`${projectId}/worktrees/remove`,
			{ method: 'POST', body: { worktreePath, options } }
		);
		this.readProjectsResponse(response);
		return response.result;
	}

	async getWorktreeStatus(
		projectId: string,
		worktreePath: string
	): Promise<WorktreeStatusPreview> {
		return (await this.request<WorktreeStatusResponse>(
			`${projectId}/worktrees/status`,
			{ method: 'POST', body: { worktreePath } }
		)).status;
	}

	async moveWorktree(
		projectId: string,
		worktreePath: string,
		beforeWorktreePath?: string
	): Promise<void> {
		await this.writeProjectMutation(
			`${projectId}/worktrees/move`,
			{ worktreePath, beforeWorktreePath }
		);
	}

	async setLastActiveWorktree(
		projectId: string,
		worktreePath: string
	): Promise<void> {
		await this.writeProjectMutation(
			`${projectId}/worktrees/last-active`,
			{ worktreePath }
		);
	}

	async setGitWorktreeTargets(
		consumerId: string,
		targetPaths: readonly string[]
	): Promise<readonly GitWorktreeTargetObservation[]> {
		const paths = [...targetPaths];
		this.gitWorktreeTargetPaths.set(consumerId, paths);
		if (this.hasEventSource) {
			await this.eventSessionReady.p;
		}
		if (this.gitWorktreeTargetPaths.get(consumerId) !== paths) {
			return [];
		}
		return this.registerGitWorktreeTargets(consumerId, paths);
	}

	async clearGitWorktreeTargets(consumerId: string): Promise<void> {
		const registration = this.gitWorktreeTargetRegistrations.get(consumerId);
		this.gitWorktreeTargetPaths.delete(consumerId);
		this.gitWorktreeTargetRegistrations.delete(consumerId);
		try {
			await registration?.promise;
		} catch {
			// The idempotent clear still applies after a failed registration.
		}
		if (this.gitWorktreeTargetPaths.has(consumerId) ||
			this.gitWorktreeTargetRegistrations.has(consumerId)) {
			return;
		}
		if (this.hasEventSource && !this.eventConnected) {
			return;
		}
		await this.request('git-monitor/clear', {
			method: 'POST',
			body: { sessionId: this.eventSessionId, consumerId },
		});
	}

	private registerGitWorktreeTargets(
		consumerId: string,
		targetPaths: readonly string[]
	): Promise<readonly GitWorktreeTargetObservation[]> {
		const existing = this.gitWorktreeTargetRegistrations.get(consumerId);
		if (existing?.generation === this.eventConnectionGeneration &&
			sameStringArray(existing.targetPaths, targetPaths)) {
			return existing.promise;
		}

		const generation = this.eventConnectionGeneration;
		const promise = this.request<{
			readonly observations: readonly GitWorktreeTargetObservation[];
		}>('git-monitor/targets', {
			method: 'POST',
			body: {
				sessionId: this.eventSessionId,
				consumerId,
				targetPaths,
			},
		}).then(response => response.observations);
		const registration = { generation, targetPaths, promise };
		this.gitWorktreeTargetRegistrations.set(consumerId, registration);
		promise.catch(() => {
			if (this.gitWorktreeTargetRegistrations.get(consumerId) ===
				registration) {
				this.gitWorktreeTargetRegistrations.delete(consumerId);
			}
		});
		return promise;
	}

	private async restoreGitWorktreeTargets(publish: boolean): Promise<void> {
		for (const [consumerId, targetPaths] of this.gitWorktreeTargetPaths) {
			try {
				const observations = await this.registerGitWorktreeTargets(
					consumerId,
					targetPaths
				);
				if (this.gitWorktreeTargetPaths.get(consumerId) !== targetPaths) {
					continue;
				}
				if (publish) {
					this._onDidChangeGitWorktreeTargets.fire({
						consumerId,
						observations,
					});
				}
			} catch {
				// EventSource reconnect will retry the complete current target set.
			}
		}
	}

	private async writeProjectMutation(path: string, body: unknown): Promise<void> {
		this.readProjectsResponse(await this.request<ProjectsResponse>(
			path,
			{ method: 'POST', body }
		));
	}

	private readProjectResponse(response: ProjectResponse): ProjectRecord {
		const projects = this.reviveProjects(response.projects);
		this._onDidChangeProjects.fire(projects);
		return reviveProject(response.project);
	}

	private readWorktreeResponse(response: WorktreeResponse): WorktreeRecord {
		const projects = this.reviveProjects(response.projects);
		this._onDidChangeProjects.fire(projects);
		return response.worktree;
	}

	private readProjectsResponse(
		response: ProjectsResponse
	): readonly ProjectRecord[] {
		const projects = this.reviveProjects(response.projects);
		this._onDidChangeProjects.fire(projects);
		return projects;
	}

	private reviveProjects(
		projects: readonly ProjectRecord[]
	): readonly ProjectRecord[] {
		return projects.map(project => reviveProject(project));
	}

	private async request<T>(
		path: string,
		options: { method: string; body?: unknown },
		token: CancellationToken = CancellationToken.None
	): Promise<T> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() =>
			controller.abort()
		);
		try {
			const response = await this.transport.fetch(this.toApiUrl(path), {
				method: options.method,
				credentials: 'include',
				headers: options.body === undefined
					? undefined
					: { 'Content-Type': 'application/json' },
				body: options.body === undefined
					? undefined
					: JSON.stringify(options.body),
				signal: controller.signal,
			});
			const body = await response.json().catch(() => undefined) as
				{ error?: string } | T | undefined;
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			if (!response.ok) {
				const error = getErrorMessage(body);
				throw new Error(
					error ||
					localize(
						'projectManagerRequestFailed',
						'Project manager request failed: {0}',
						response.status
					)
				);
			}

			return body as T;
		} catch (error) {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			throw error;
		} finally {
			cancellation.dispose();
		}
	}

	private toApiUrl(path: string): string {
		const suffix = path ? `/${path}` : '';
		return `${this.projectsApi}${suffix}`;
	}

	private registerProjectEvents(
		transport: IWebProjectManagerServiceTransport
	): void {
		if (typeof transport.EventSource !== 'function') {
			return;
		}

		const events = new transport.EventSource(
			this.toApiUrl(
				`events/${encodeURIComponent(this.eventSessionId)}`
			),
			{ withCredentials: true }
		);
		this.hasEventSource = true;
		this._register(toDisposable(() => events.close()));
		events.addEventListener('open', () => {
			const reconnecting = this.eventConnectionGeneration > 0;
			this.eventConnectionGeneration++;
			this.eventConnected = true;
			void this.eventSessionReady.complete();
			void this.restoreGitWorktreeTargets(reconnecting);
		});
		events.addEventListener('error', () => {
			this.eventConnected = false;
			if (this.eventConnectionGeneration === 0) {
				void this.eventSessionReady.complete();
			} else if (this.eventSessionReady.isResolved) {
				this.eventSessionReady = new DeferredPromise<void>();
			}
		});
		events.addEventListener('projects', event => {
			const projects = readProjectEvent(event);
			if (projects) {
				this._onDidChangeProjects.fire(projects);
			}
		});
		events.addEventListener('git-worktrees', event => {
			const change = readGitWorktreeEvent(event);
			if (change) {
				this._onDidChangeGitWorktreeTargets.fire(change);
			}
		});
	}
}

export class WebProjectManagerService extends WebProjectManagerClient {
	constructor(
		@IBrowserWorkbenchEnvironmentService
		environmentService: IBrowserWorkbenchEnvironmentService,
	) {
		super(getHucodeOmniProjectsApi(environmentService.options));
	}
}

function reviveProject(project: ProjectRecord): ProjectRecord {
	return {
		...project,
		rootUri: URI.revive(project.rootUri),
	};
}

function getErrorMessage(body: unknown): string | undefined {
	if (
		!body ||
		typeof body !== 'object' ||
		!Object.prototype.hasOwnProperty.call(body, 'error')
	) {
		return undefined;
	}

	const error = (body as { readonly error?: unknown }).error;
	return typeof error === 'string' ? error : undefined;
}

function sameStringArray(
	a: readonly string[],
	b: readonly string[]
): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function readProjectEvent(event: Event): readonly ProjectRecord[] | undefined {
	const data = (event as { readonly data?: unknown }).data;
	if (typeof data !== 'string') {
		return undefined;
	}

	try {
		const body = JSON.parse(data) as ProjectsResponse;
		if (!Array.isArray(body.projects)) {
			return undefined;
		}

		return body.projects.map(project => reviveProject(project));
	} catch {
		return undefined;
	}
}

function readGitWorktreeEvent(event: Event): GitWorktreeTargetChange | undefined {
	const data = (event as { readonly data?: unknown }).data;
	if (typeof data !== 'string') {
		return undefined;
	}
	try {
		const change = JSON.parse(data) as GitWorktreeTargetChange;
		return typeof change.consumerId === 'string' &&
			Array.isArray(change.observations)
			? change
			: undefined;
	} catch {
		return undefined;
	}
}

registerSingleton(
	IProjectManagerService,
	WebProjectManagerService,
	InstantiationType.Delayed
);
