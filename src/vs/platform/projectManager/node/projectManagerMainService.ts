/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout, ThrottledDelayer } from '../../../base/common/async.js';
import {
	CancellationToken,
	CancellationTokenSource,
} from '../../../base/common/cancellation.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import {
	Disposable,
	DisposableMap,
	DisposableStore,
	IDisposable,
	toDisposable,
} from '../../../base/common/lifecycle.js';
import { basename, join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { URI } from '../../../base/common/uri.js';
import { isLinux } from '../../../base/common/platform.js';
import { IStateService } from '../../state/node/state.js';
import { ILogService } from '../../log/common/log.js';
import { IFileService } from '../../files/common/files.js';
import {
	CreateWorktreeOptions,
	IProjectManagerService,
	PROJECT_MANAGER_STORAGE_KEY,
	ProjectRecord,
	ProjectWorktreeState,
	StoredProjectRecord,
	WorktreeRecord,
	WorktreeRefQueryOptions,
	WorktreeRefRecord,
} from '../common/projectManager.js';
import {
	applyStoredWorktreeLabels,
	applyStoredWorktreeOrder,
	applyStoredWorktreePins,
	applyStoredWorktreeVisits,
	createStoredProjectManagerState,
	filterStoredWorktreeLabel,
	filterStoredWorktreePath,
	loadStoredProjectManagerState,
	projectManagerPathsEqual,
	pruneStoredPinnedWorktreePaths,
	pruneStoredWorktreeLabels,
	pruneStoredWorktreeOrder,
	pruneStoredWorktreeVisits,
	setStoredWorktreeVisited,
} from '../common/projectManagerState.js';
import { GitWorktreeService } from './gitWorktreeService.js';

const PROJECT_AUTO_REFRESH_DEBOUNCE_MS = 1000;
const PROJECT_AUTO_REFRESH_QUIET_MS = 5000;
const PROJECT_REFRESH_RETRY_DELAYS_MS = [
	1000,
	2000,
	5000,
	10_000,
	30_000,
] as const;

interface ProjectRefreshOwner {
	readonly source: CancellationTokenSource;
	initialAttempt?: Promise<ProjectRefreshAttemptResult>;
}

type ProjectRefreshAttemptResult =
	| { readonly kind: 'canceled' }
	| { readonly kind: 'failed'; readonly stateChanged: boolean }
	| { readonly kind: 'committed-retry' }
	| { readonly kind: 'complete' };

/**
 * Watches targeted project metadata paths for worktree-affecting changes.
 */
export interface IProjectMetadataWatcher {
	watch(path: string, onDidChange: () => void): IDisposable;
}

/**
 * Git operations used by the main-process project manager.
 */
export type ProjectManagerGitService = Pick<
	GitWorktreeService,
	'resolveProjectRoot' |
	'getGitCommonDir' |
	'listWorktreeAdminDirs' |
	'listWorktrees' |
	'listRefs' |
	'isValidBranchName' |
	'createWorktree' |
	'removeWorktree'
>;

/**
 * Optional dependencies for production wiring and focused unit tests.
 */
export interface ProjectManagerMainServiceOptions {
	readonly fileService?: IFileService;
	readonly gitWorktreeService?: ProjectManagerGitService;
	readonly metadataWatcher?: IProjectMetadataWatcher;
	readonly now?: () => number;
	readonly autoRefreshDebounceMs?: number;
	readonly autoRefreshQuietMs?: number;
	readonly refreshDelay?: (milliseconds: number) => Promise<void>;
	readonly retryDelay?: (
		milliseconds: number,
		token: CancellationToken
	) => Promise<void>;
}

class FileServiceProjectMetadataWatcher implements IProjectMetadataWatcher {

	constructor(private readonly fileService: IFileService) {
	}

	watch(path: string, onDidChange: () => void): IDisposable {
		const store = new DisposableStore();
		const watcher = store.add(this.fileService.createWatcher(URI.file(path), {
			recursive: false,
			excludes: [],
		}));
		store.add(watcher.onDidChange(() => onDidChange()));

		return store;
	}
}

/**
 * Main-process Hucode project registry and worktree orchestration service.
 */
export class ProjectManagerMainService extends Disposable
	implements IProjectManagerService {

	declare readonly _serviceBrand: undefined;

	private readonly gitWorktreeService: ProjectManagerGitService;
	private readonly metadataWatcher: IProjectMetadataWatcher | undefined;
	private readonly autoRefreshDebounceMs: number;
	private readonly autoRefreshQuietMs: number;
	private readonly refreshDelay: (milliseconds: number) => Promise<void>;
	private readonly retryDelay: (
		milliseconds: number,
		token: CancellationToken
	) => Promise<void>;
	private readonly now: () => number;
	private readonly _onDidChangeProjects =
		this._register(new Emitter<readonly ProjectRecord[]>());
	readonly onDidChangeProjects = this._onDidChangeProjects.event;

	private storedProjects: StoredProjectRecord[] = [];
	private projectWorktrees = new Map<string, readonly WorktreeRecord[]>();
	private readonly projectWorktreeStates =
		new Map<string, ProjectWorktreeState>();
	private readonly projectRefreshOwners =
		new Map<string, ProjectRefreshOwner>();
	private readonly projectHydrations =
		new Map<string, Promise<void>>();
	private readonly projectWatchers =
		this._register(new DisposableMap<string>());
	private readonly autoRefreshDelayers =
		this._register(new DisposableMap<string, ThrottledDelayer<void>>());
	private stateLoaded = false;

	constructor(
		@IStateService private readonly stateService: IStateService,
		@ILogService private readonly logService: ILogService,
		options: ProjectManagerMainServiceOptions = {},
	) {
		super();

		this.gitWorktreeService = options.gitWorktreeService ??
			new GitWorktreeService(logService);
		this.metadataWatcher = options.metadataWatcher ??
			(options.fileService
				? new FileServiceProjectMetadataWatcher(options.fileService)
				: undefined);
		this.autoRefreshDebounceMs = options.autoRefreshDebounceMs ??
			PROJECT_AUTO_REFRESH_DEBOUNCE_MS;
		this.autoRefreshQuietMs = options.autoRefreshQuietMs ??
			PROJECT_AUTO_REFRESH_QUIET_MS;
		this.refreshDelay = options.refreshDelay ?? timeout;
		this.retryDelay = options.retryDelay ??
			((milliseconds, token) => timeout(milliseconds, token));
		this.now = options.now ?? (() => Date.now());
		this._register(toDisposable(() => {
			for (const owner of this.projectRefreshOwners.values()) {
				owner.source.dispose(true);
			}
			this.projectRefreshOwners.clear();
			this.projectHydrations.clear();
		}));
	}

	async getProjects(): Promise<readonly ProjectRecord[]> {
		this.ensureStateLoaded();
		await this.hydrateMissingProjectWorktrees();
		return this.toProjectRecords();
	}

	async addProject(uri: URI): Promise<ProjectRecord> {
		this.ensureStateLoaded();
		const rootPath = await this.gitWorktreeService.resolveProjectRoot(uri.fsPath);
		const existing = this.storedProjects.find(project =>
			this.pathsEqual(project.rootPath, rootPath)
		);
		if (existing) {
			await this.refresh(existing.id);
			return this.toProjectRecord(existing);
		}

		const nextOrder = this.storedProjects.reduce(
			(max, project) => Math.max(max, project.order),
			0
		) + 1;
		const storedProject: StoredProjectRecord = {
			id: generateUuid(),
			label: basename(rootPath),
			rootPath,
			pinned: false,
			order: nextOrder,
		};

		this.storedProjects = [...this.storedProjects, storedProject];
		await this.refreshProject(storedProject);
		this.saveState();
		this.emitChange();

		return this.toProjectRecord(storedProject);
	}

	async renameProject(id: string, label: string): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(id);
		project.label = label.trim() || project.label;
		this.saveState();
		this.emitChange();
	}

	async resetProjectLabel(id: string): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(id);
		const defaultLabel = basename(project.rootPath);
		if (project.label === defaultLabel) {
			return;
		}

		project.label = defaultLabel;
		this.saveState();
		this.emitChange();
	}

	async renameWorktree(
		projectId: string,
		worktreePath: string,
		label: string
	): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		const worktrees = await this.getProjectWorktrees(project);
		const worktree = worktrees.find(entry =>
			this.pathsEqual(entry.path, worktreePath)
		);
		if (!worktree) {
			throw new Error(`Unknown worktree "${worktreePath}".`);
		}

		const trimmedLabel = label.trim();
		if (!trimmedLabel) {
			return;
		}

		const worktreeLabels = this.filterWorktreeLabel(
			project.worktreeLabels ?? [],
			worktree.path
		);
		project.worktreeLabels = [
			...worktreeLabels,
			{ path: worktree.path, label: trimmedLabel },
		];
		this.projectWorktrees.set(
			project.id,
			this.applyWorktreePins(
				project,
				this.applyWorktreeLabels(project, worktrees)
			)
		);
		this.saveState();
		this.emitChange();
	}

	async resetWorktreeLabel(
		projectId: string,
		worktreePath: string
	): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		const worktrees = await this.getProjectWorktrees(project);
		const worktree = worktrees.find(entry =>
			this.pathsEqual(entry.path, worktreePath)
		);
		if (!worktree) {
			throw new Error(`Unknown worktree "${worktreePath}".`);
		}

		const worktreeLabels = this.filterWorktreeLabel(
			project.worktreeLabels ?? [],
			worktree.path
		);
		if (worktreeLabels.length === (project.worktreeLabels ?? []).length) {
			return;
		}

		project.worktreeLabels = worktreeLabels.length
			? worktreeLabels
			: undefined;
		this.projectWorktrees.set(
			project.id,
			this.applyWorktreePins(
				project,
				this.applyWorktreeLabels(project, worktrees)
			)
		);
		this.saveState();
		this.emitChange();
	}

	async setPinned(id: string, pinned: boolean): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(id);
		if (project.pinned === pinned) {
			return;
		}

		project.pinned = pinned;
		const orderedProjectIds = this.storedProjects
			.filter(entry => entry.id !== project.id)
			.sort((a, b) => a.order - b.order)
			.map(entry => entry.id);
		orderedProjectIds.push(project.id);
		this.setProjectOrder(orderedProjectIds);
		this.saveState();
		this.emitChange();
	}

	async setWorktreePinned(
		projectId: string,
		worktreePath: string,
		pinned: boolean
	): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		const worktrees = await this.getProjectWorktrees(project);
		const worktree = worktrees.find(entry =>
			this.pathsEqual(entry.path, worktreePath)
		);
		if (!worktree) {
			throw new Error(`Unknown worktree "${worktreePath}".`);
		}

		const pinnedWorktreePaths = project.pinnedWorktreePaths ?? [];
		const hasPinnedWorktree = pinnedWorktreePaths.some(path =>
			this.pathsEqual(path, worktree.path)
		);
		if (pinned === hasPinnedWorktree) {
			return;
		}

		project.pinnedWorktreePaths = pinned
			? [...pinnedWorktreePaths, worktree.path]
			: this.filterWorktreePath(
				pinnedWorktreePaths,
				worktree.path
			);
		if (!project.pinnedWorktreePaths.length) {
			project.pinnedWorktreePaths = undefined;
		}

		this.projectWorktrees.set(
			project.id,
			this.applyWorktreePins(project, worktrees)
		);
		this.saveState();
		this.emitChange();
	}

	async removeProject(id: string): Promise<void> {
		this.ensureStateLoaded();
		this.requireProject(id);
		this.storedProjects = this.storedProjects.filter(project => project.id !== id);
		this.projectHydrations.delete(id);
		this.cancelProjectRefresh(id);
		this.projectWorktrees.delete(id);
		this.projectWorktreeStates.delete(id);
		this.projectWatchers.deleteAndDispose(id);
		this.autoRefreshDelayers.deleteAndDispose(id);
		this.saveState();
		this.emitChange();
	}

	async moveProject(id: string, beforeProjectId?: string): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(id);
		if (beforeProjectId === project.id) {
			return;
		}

		const beforeProject = beforeProjectId
			? this.requireProject(beforeProjectId)
			: undefined;

		const orderedProjects = this.storedProjects
			.filter(entry => entry.id !== project.id)
			.sort((a, b) => a.order - b.order);
		const insertIndex = beforeProject
			? orderedProjects.findIndex(entry => entry.id === beforeProject.id)
			: orderedProjects.length;
		orderedProjects.splice(insertIndex, 0, project);

		this.setProjectOrder(orderedProjects.map(entry => entry.id));
		this.saveState();
		this.emitChange();
	}

	async refresh(id?: string): Promise<readonly ProjectRecord[]> {
		this.ensureStateLoaded();
		if (id) {
			await this.refreshProject(this.requireProject(id));
		} else {
			await Promise.all(
				this.storedProjects.map(project => this.refreshProject(project))
			);
		}

		this.saveState();
		this.emitChange();
		return this.toProjectRecords();
	}

	async getWorktreeRefs(
		projectId: string,
		options?: WorktreeRefQueryOptions
	): Promise<readonly WorktreeRefRecord[]> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		const worktrees = await this.getProjectWorktrees(project);

		return this.gitWorktreeService.listRefs(
			project.rootPath,
			worktrees,
			options
		);
	}

	async isValidBranchName(
		projectId: string,
		branchName: string
	): Promise<boolean> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		return this.gitWorktreeService.isValidBranchName(
			project.rootPath,
			branchName
		);
	}

	async createWorktree(
		projectId: string,
		options: CreateWorktreeOptions
	): Promise<WorktreeRecord> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		const existingWorktrees = await this.getProjectWorktrees(project);
		const worktreePath = await this.gitWorktreeService.createWorktree(
			project.rootPath,
			options,
			existingWorktrees.map(worktree => worktree.path)
		);

		const worktrees = await this.refreshProject(project);
		this.saveState();
		this.emitChange();

		const worktree = worktrees.find(entry =>
			this.pathsEqual(entry.path, worktreePath)
		);
		if (!worktree) {
			throw new Error(`Created worktree "${worktreePath}" was not found.`);
		}

		return worktree;
	}

	async removeWorktree(
		projectId: string,
		worktreePath: string
	): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		const worktrees = await this.getProjectWorktrees(project);
		const worktree = worktrees.find(entry =>
			this.pathsEqual(entry.path, worktreePath)
		);
		if (!worktree) {
			throw new Error(`Unknown worktree "${worktreePath}".`);
		}
		if (worktree.isMain) {
			throw new Error('The main worktree cannot be removed.');
		}

		await this.gitWorktreeService.removeWorktree(project.rootPath, worktreePath);
		await this.refreshProject(project);
		this.saveState();
		this.emitChange();
	}

	async moveWorktree(
		projectId: string,
		worktreePath: string,
		beforeWorktreePath?: string
	): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		const worktrees = await this.getProjectWorktrees(project);
		const source = worktrees.find(entry =>
			this.pathsEqual(entry.path, worktreePath)
		);
		if (!source) {
			throw new Error(`Unknown worktree "${worktreePath}".`);
		}
		if (source.isMain) {
			throw new Error('The main worktree cannot be reordered.');
		}
		if (
			beforeWorktreePath &&
			this.pathsEqual(source.path, beforeWorktreePath)
		) {
			return;
		}

		const movableWorktrees = worktrees.filter(entry =>
			!entry.isMain && !this.pathsEqual(entry.path, source.path)
		);
		let insertIndex = movableWorktrees.length;
		if (beforeWorktreePath) {
			const beforeWorktree = worktrees.find(entry =>
				this.pathsEqual(entry.path, beforeWorktreePath)
			);
			if (!beforeWorktree) {
				throw new Error(`Unknown worktree "${beforeWorktreePath}".`);
			}

			insertIndex = beforeWorktree.isMain
				? 0
				: movableWorktrees.findIndex(entry =>
					this.pathsEqual(entry.path, beforeWorktree.path)
				);
			if (insertIndex < 0) {
				insertIndex = movableWorktrees.length;
			}
		}

		movableWorktrees.splice(insertIndex, 0, source);
		project.worktreeOrder = movableWorktrees.map(entry => entry.path);
		this.projectWorktrees.set(
			project.id,
			this.applyWorktreePins(
				project,
				this.applyWorktreeOrder(project, worktrees)
			)
		);
		this.saveState();
		this.emitChange();
	}

	async setLastActiveWorktree(
		projectId: string,
		worktreePath: string
	): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		const worktrees = await this.getProjectWorktrees(project);
		const worktree = worktrees.find(entry =>
			this.pathsEqual(entry.path, worktreePath)
		);
		if (!worktree) {
			throw new Error(`Unknown worktree "${worktreePath}".`);
		}

		project.lastActiveWorktreePath = worktree.path;
		this.setWorktreeVisited(project, worktree.path, this.now());
		this.saveState();
		this.emitChange();
	}

	private async refreshProject(
		project: StoredProjectRecord
	): Promise<readonly WorktreeRecord[]> {
		const owner = this.replaceProjectRefreshOwner(project.id);
		const initialAttempt = this.tryRefreshProject(project, owner);
		owner.initialAttempt = initialAttempt;
		const completed = await this.waitForRefreshAttempt(
			project.id,
			owner,
			initialAttempt
		);
		if (
			(completed.result.kind === 'failed' ||
				completed.result.kind === 'committed-retry') &&
			completed.owner === owner &&
			this.isCurrentRefreshOwner(project.id, completed.owner)
		) {
			this.retryProjectRefresh(project, completed.owner).then(
				undefined,
				error => {
					this.logService.warn(
						`[ProjectManagerMainService] Failed to retry refresh ` +
						`${project.rootPath}: ${error}`
					);
					this.finishProjectRefresh(project.id, completed.owner);
				}
			);
		}

		return this.projectWorktrees.get(project.id) ?? [];
	}

	private async waitForRefreshAttempt(
		projectId: string,
		owner: ProjectRefreshOwner,
		attempt: Promise<ProjectRefreshAttemptResult>
	): Promise<{
		readonly owner: ProjectRefreshOwner;
		readonly result: ProjectRefreshAttemptResult;
	}> {
		let currentOwner = owner;
		let result = await attempt;
		while (result.kind === 'canceled') {
			const winningOwner = this.projectRefreshOwners.get(projectId);
			const winningAttempt = winningOwner?.initialAttempt;
			if (!winningOwner ||
				winningOwner === currentOwner ||
				!winningAttempt) {
				break;
			}

			currentOwner = winningOwner;
			result = await winningAttempt;
		}

		return { owner: currentOwner, result };
	}

	private async tryRefreshProject(
		project: StoredProjectRecord,
		owner: ProjectRefreshOwner
	): Promise<ProjectRefreshAttemptResult> {
		const token = owner.source.token;
		try {
			// Resolve the git common dir (needed only for metadata watchers)
			// concurrently with the worktree list; both are independent git
			// subprocesses that read only the project root. The catch keeps a
			// getGitCommonDir rejection from surfacing as an unhandled rejection
			// if listWorktrees throws first; createProjectWatchers re-awaits it.
			const commonGitDirPromise = this.metadataWatcher
				? this.gitWorktreeService.getGitCommonDir(project.rootPath, token)
				: undefined;
			commonGitDirPromise?.catch(() => undefined);

			const discoveredWorktrees =
				await this.gitWorktreeService.listWorktrees(
					project.rootPath,
					token
				);
			const watchers = await this.createProjectWatchers(
				project,
				commonGitDirPromise,
				token
			);
			if (!this.isCurrentRefreshOwner(project.id, owner) ||
				token.isCancellationRequested) {
				watchers?.dispose();
				return { kind: 'canceled' };
			}

			// No await may occur between cloning the live metadata and committing
			// the refreshed snapshot. User mutations made while Git or watcher
			// discovery was pending must be incorporated rather than overwritten.
			const stagedProject = this.cloneStoredProject(project);
			const labeledWorktrees = this.applyWorktreeLabels(
				stagedProject,
				discoveredWorktrees
			);
			const orderedWorktrees = this.applyWorktreeOrder(
				stagedProject,
				labeledWorktrees
			);
			this.pruneWorktreeOrder(stagedProject, orderedWorktrees);
			this.prunePinnedWorktreePaths(stagedProject, orderedWorktrees);
			this.pruneWorktreeLabels(stagedProject, orderedWorktrees);
			this.pruneWorktreeVisits(stagedProject, orderedWorktrees);
			const visitedWorktrees = this.applyWorktreeVisits(
				stagedProject,
				orderedWorktrees
			);
			const worktrees = this.applyWorktreePins(
				stagedProject,
				visitedWorktrees
			);

			if (stagedProject.lastActiveWorktreePath &&
				!worktrees.some(worktree =>
					this.pathsEqual(
						worktree.path,
						stagedProject.lastActiveWorktreePath!
					)
				)
			) {
				stagedProject.lastActiveWorktreePath = undefined;
			}

			Object.assign(project, stagedProject);
			this.projectWorktrees.set(project.id, worktrees);
			this.projectWorktreeStates.set(project.id, 'current');
			if (watchers instanceof DisposableStore) {
				this.projectWatchers.set(project.id, watchers);
			}
			if (watchers !== null) {
				this.finishProjectRefresh(project.id, owner);
				return { kind: 'complete' };
			}

			return { kind: 'committed-retry' };
		} catch (error) {
			if (isCancellationError(error) ||
				token.isCancellationRequested ||
				!this.isCurrentRefreshOwner(project.id, owner)) {
				return { kind: 'canceled' };
			}

			this.logService.warn(
				`[ProjectManagerMainService] Failed to refresh ` +
				`${project.rootPath}: ${error}`
			);
			const previousState = this.projectWorktreeStates.get(project.id);
			const nextState = this.projectWorktrees.has(project.id)
				? 'stale'
				: 'unavailable';
			this.projectWorktreeStates.set(project.id, nextState);
			return {
				kind: 'failed',
				stateChanged: previousState !== nextState,
			};
		}
	}

	private async createProjectWatchers(
		project: StoredProjectRecord,
		commonGitDirPromise: Promise<string> | undefined,
		token: CancellationToken
	): Promise<DisposableStore | null | undefined> {
		if (!this.metadataWatcher) {
			return undefined;
		}

		const watchers = new DisposableStore();
		try {
			const commonGitDir = await (
				commonGitDirPromise ??
				this.gitWorktreeService.getGitCommonDir(project.rootPath, token)
			);
			this.watchProjectMetadataPath(
				watchers,
				project.id,
				join(commonGitDir, 'HEAD')
			);
			this.watchProjectMetadataPath(
				watchers,
				project.id,
				join(commonGitDir, 'worktrees')
			);

			for (const adminDirName of
				await this.gitWorktreeService.listWorktreeAdminDirs(commonGitDir)) {
				const adminDir = join(commonGitDir, 'worktrees', adminDirName);
				this.watchProjectMetadataPath(
					watchers,
					project.id,
					join(adminDir, 'HEAD')
				);
				this.watchProjectMetadataPath(
					watchers,
					project.id,
					join(adminDir, 'gitdir')
				);
			}

			return watchers;
		} catch (error) {
			watchers.dispose();
			if (isCancellationError(error) || token.isCancellationRequested) {
				throw error;
			}
			this.logService.warn(
				`[ProjectManagerMainService] Failed to watch ` +
				`${project.rootPath}: ${error}`
			);
			return null;
		}
	}

	private async retryProjectRefresh(
		project: StoredProjectRecord,
		owner: ProjectRefreshOwner
	): Promise<void> {
		let publicationPending = false;
		for (let retry = 0;
			this.isCurrentRefreshOwner(project.id, owner);
			retry++
		) {
			const delay = PROJECT_REFRESH_RETRY_DELAYS_MS[
				Math.min(retry, PROJECT_REFRESH_RETRY_DELAYS_MS.length - 1)
			];
			try {
				await this.retryDelay(delay, owner.source.token);
			} catch (error) {
				if (!isCancellationError(error)) {
					this.logService.warn(
						`[ProjectManagerMainService] Failed to delay refresh ` +
						`${project.rootPath}: ${error}`
					);
				}
				this.finishProjectRefresh(project.id, owner);
				return;
			}

			if (!this.isCurrentRefreshOwner(project.id, owner)) {
				return;
			}
			const result = await this.tryRefreshProject(project, owner);
			if (result.kind === 'canceled') {
				return;
			}
			if (
				result.kind === 'complete' ||
				result.kind === 'committed-retry' ||
				result.kind === 'failed' && result.stateChanged ||
				publicationPending
			) {
				try {
					this.saveState();
					this.emitChange();
					publicationPending = false;
				} catch (error) {
					publicationPending = true;
					this.logService.warn(
						`[ProjectManagerMainService] Failed to publish retry ` +
						`refresh ${project.rootPath}: ${error}`
					);
					if (result.kind === 'complete') {
						return;
					}
				}
			}
			if (result.kind === 'complete') {
				return;
			}
		}
	}

	private replaceProjectRefreshOwner(projectId: string): ProjectRefreshOwner {
		this.cancelProjectRefresh(projectId);
		const owner: ProjectRefreshOwner = {
			source: new CancellationTokenSource(),
		};
		this.projectRefreshOwners.set(projectId, owner);
		return owner;
	}

	private cancelProjectRefresh(projectId: string): void {
		const owner = this.projectRefreshOwners.get(projectId);
		if (!owner) {
			return;
		}

		this.projectRefreshOwners.delete(projectId);
		owner.source.dispose(true);
	}

	private finishProjectRefresh(
		projectId: string,
		owner: ProjectRefreshOwner
	): void {
		if (!this.isCurrentRefreshOwner(projectId, owner)) {
			return;
		}

		this.projectRefreshOwners.delete(projectId);
		owner.source.dispose();
	}

	private isCurrentRefreshOwner(
		projectId: string,
		owner: ProjectRefreshOwner
	): boolean {
		return this.projectRefreshOwners.get(projectId) === owner;
	}

	private cloneStoredProject(project: StoredProjectRecord): StoredProjectRecord {
		return {
			...project,
			worktreeOrder: project.worktreeOrder
				? [...project.worktreeOrder]
				: undefined,
			pinnedWorktreePaths: project.pinnedWorktreePaths
				? [...project.pinnedWorktreePaths]
				: undefined,
			worktreeLabels: project.worktreeLabels
				? project.worktreeLabels.map(label => ({ ...label }))
				: undefined,
			worktreeVisits: project.worktreeVisits
				? project.worktreeVisits.map(visit => ({ ...visit }))
				: undefined,
		};
	}

	private watchProjectMetadataPath(
		watchers: DisposableStore,
		projectId: string,
		path: string
	): void {
		const metadataWatcher = this.metadataWatcher;
		if (!metadataWatcher) {
			return;
		}

		watchers.add(metadataWatcher.watch(path, () => {
			this.scheduleProjectRefresh(projectId);
		}));
	}

	private scheduleProjectRefresh(projectId: string): void {
		let delayer = this.autoRefreshDelayers.get(projectId);
		if (!delayer) {
			delayer = new ThrottledDelayer<void>(this.autoRefreshDebounceMs);
			this.autoRefreshDelayers.set(projectId, delayer);
		}

		delayer.trigger(() => this.runScheduledProjectRefresh(projectId))
			.then(undefined, error => this.logService.warn(
				`[ProjectManagerMainService] Failed to auto-refresh ` +
				`${projectId}: ${error}`
			));
	}

	private async runScheduledProjectRefresh(projectId: string): Promise<void> {
		const project = this.storedProjects.find(entry => entry.id === projectId);
		if (!project) {
			this.autoRefreshDelayers.deleteAndDispose(projectId);
			return;
		}

		await this.refreshProject(project);
		this.saveState();
		this.emitChange();

		if (this.autoRefreshQuietMs > 0) {
			await this.refreshDelay(this.autoRefreshQuietMs);
		}
	}

	private toProjectRecords(): readonly ProjectRecord[] {
		return this.storedProjects
			.slice()
			.sort((a, b) => a.order - b.order)
			.map(project => this.toProjectRecord(project));
	}

	private toProjectRecord(project: StoredProjectRecord): ProjectRecord {
		return {
			id: project.id,
			label: project.label,
			rootUri: URI.file(project.rootPath),
			pinned: project.pinned,
			order: project.order,
			lastActiveWorktreePath: project.lastActiveWorktreePath,
			worktreeState: this.projectWorktreeStates.get(project.id) ??
				'unavailable',
			worktrees: this.projectWorktrees.get(project.id) ?? [],
		};
	}

	private requireProject(id: string): StoredProjectRecord {
		const project = this.storedProjects.find(entry => entry.id === id);
		if (!project) {
			throw new Error(`Unknown project "${id}".`);
		}

		return project;
	}

	private emitChange(): void {
		this._onDidChangeProjects.fire(this.toProjectRecords());
	}

	private setProjectOrder(orderedProjectIds: readonly string[]): void {
		const orderedIdSet = new Set(orderedProjectIds);
		const reorderedProjects = orderedProjectIds.map(id => this.requireProject(id));
		for (const project of this.storedProjects) {
			if (!orderedIdSet.has(project.id)) {
				reorderedProjects.push(project);
			}
		}

		for (const [index, project] of reorderedProjects.entries()) {
			project.order = index + 1;
		}
	}

	private ensureStateLoaded(): void {
		if (this.stateLoaded) {
			return;
		}

		this.storedProjects = this.loadState();
		this.stateLoaded = true;
	}

	private loadState(): StoredProjectRecord[] {
		return loadStoredProjectManagerState(this.stateService.getItem(
			PROJECT_MANAGER_STORAGE_KEY
		));
	}

	private saveState(): void {
		this.stateService.setItem(
			PROJECT_MANAGER_STORAGE_KEY,
			createStoredProjectManagerState(this.storedProjects)
		);
	}

	private pathsEqual(pathA: string, pathB: string): boolean {
		return projectManagerPathsEqual(pathA, pathB, isLinux);
	}

	private filterWorktreePath(
		paths: readonly string[],
		worktreePath: string
	): string[] {
		return filterStoredWorktreePath(paths, worktreePath, isLinux);
	}

	private filterWorktreeLabel(
		labels: readonly { readonly path: string; readonly label: string }[],
		worktreePath: string
	): { readonly path: string; readonly label: string }[] {
		return filterStoredWorktreeLabel(labels, worktreePath, isLinux);
	}

	private applyWorktreeLabels(
		project: StoredProjectRecord,
		worktrees: readonly WorktreeRecord[]
	): readonly WorktreeRecord[] {
		return applyStoredWorktreeLabels(project, worktrees, isLinux);
	}

	private applyWorktreeOrder(
		project: StoredProjectRecord,
		worktrees: readonly WorktreeRecord[]
	): readonly WorktreeRecord[] {
		return applyStoredWorktreeOrder(project, worktrees, isLinux);
	}

	private applyWorktreePins(
		project: StoredProjectRecord,
		worktrees: readonly WorktreeRecord[]
	): readonly WorktreeRecord[] {
		return applyStoredWorktreePins(project, worktrees, isLinux);
	}

	private applyWorktreeVisits(
		project: StoredProjectRecord,
		worktrees: readonly WorktreeRecord[]
	): readonly WorktreeRecord[] {
		return applyStoredWorktreeVisits(project, worktrees, isLinux);
	}

	private setWorktreeVisited(
		project: StoredProjectRecord,
		worktreePath: string,
		lastVisitedAt: number
	): void {
		setStoredWorktreeVisited(project, worktreePath, lastVisitedAt, isLinux);

		const worktrees = this.projectWorktrees.get(project.id);
		if (!worktrees) {
			return;
		}

		this.projectWorktrees.set(
			project.id,
			worktrees.map(worktree =>
				this.pathsEqual(worktree.path, worktreePath)
					? { ...worktree, lastVisitedAt }
					: worktree
			)
		);
	}

	private pruneWorktreeOrder(
		project: StoredProjectRecord,
		worktrees: readonly WorktreeRecord[]
	): void {
		pruneStoredWorktreeOrder(project, worktrees, isLinux);
	}

	private prunePinnedWorktreePaths(
		project: StoredProjectRecord,
		worktrees: readonly WorktreeRecord[]
	): void {
		pruneStoredPinnedWorktreePaths(project, worktrees, isLinux);
	}

	private pruneWorktreeLabels(
		project: StoredProjectRecord,
		worktrees: readonly WorktreeRecord[]
	): void {
		pruneStoredWorktreeLabels(project, worktrees, isLinux);
	}

	private pruneWorktreeVisits(
		project: StoredProjectRecord,
		worktrees: readonly WorktreeRecord[]
	): void {
		pruneStoredWorktreeVisits(project, worktrees, isLinux);
	}

	private async getProjectWorktrees(
		project: StoredProjectRecord
	): Promise<readonly WorktreeRecord[]> {
		const worktrees = this.projectWorktrees.get(project.id);
		if (worktrees) {
			return worktrees;
		}
		if (!this.projectWorktreeStates.has(project.id)) {
			await this.hydrateProjectWorktrees(project);
		}

		return this.projectWorktrees.get(project.id) ?? [];
	}

	private hydrateProjectWorktrees(
		project: StoredProjectRecord
	): Promise<void> {
		const existing = this.projectHydrations.get(project.id);
		if (existing) {
			return existing;
		}
		if (this.projectWorktreeStates.has(project.id)) {
			return Promise.resolve();
		}

		const hydration = this.refreshProject(project)
			.then(() => undefined)
			.finally(() => {
				if (this.projectHydrations.get(project.id) === hydration) {
					this.projectHydrations.delete(project.id);
				}
			});
		this.projectHydrations.set(project.id, hydration);
		return hydration;
	}

	private async hydrateMissingProjectWorktrees(): Promise<void> {
		const missing = this.storedProjects.filter(
			project => !this.projectWorktreeStates.has(project.id)
		);
		if (missing.length === 0) {
			return;
		}

		// Projects are independent (per-project-keyed state), so refresh them
		// concurrently: the first getProjects() after start otherwise pays each
		// project's git subprocesses in series.
		await Promise.all(missing.map(project =>
			this.hydrateProjectWorktrees(project)
		));
		this.saveState();
	}
}
