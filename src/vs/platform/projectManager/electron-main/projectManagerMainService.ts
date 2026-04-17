/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { basename } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { URI } from '../../../base/common/uri.js';
import { isLinux } from '../../../base/common/platform.js';
import { isEqual } from '../../../base/common/extpath.js';
import { IStateService } from '../../state/node/state.js';
import { ILogService } from '../../log/common/log.js';
import {
	CreateWorktreeOptions,
	PROJECT_MANAGER_STORAGE_KEY,
	PROJECT_MANAGER_STORAGE_VERSION,
	ProjectRecord,
	StoredProjectManagerState,
	StoredProjectRecord,
	WorktreeRecord,
} from '../common/projectManager.js';
import { IProjectManagerMainService } from './projectManager.js';
import { GitWorktreeService } from './gitWorktreeService.js';

type ProjectManagerGitService = Pick<
	GitWorktreeService,
	'resolveProjectRoot' |
	'listWorktrees' |
	'createWorktree' |
	'removeWorktree'
>;

/**
 * Main-process Hucode project registry and worktree orchestration service.
 */
export class ProjectManagerMainService extends Disposable
	implements IProjectManagerMainService {

	declare readonly _serviceBrand: undefined;

	private readonly gitWorktreeService: ProjectManagerGitService;
	private readonly _onDidChangeProjects =
		this._register(new Emitter<readonly ProjectRecord[]>());
	readonly onDidChangeProjects = this._onDidChangeProjects.event;

	private storedProjects: StoredProjectRecord[] = [];
	private projectWorktrees = new Map<string, readonly WorktreeRecord[]>();
	private stateLoaded = false;

	constructor(
		@IStateService private readonly stateService: IStateService,
		@ILogService private readonly logService: ILogService,
		gitWorktreeService: ProjectManagerGitService =
			new GitWorktreeService(logService),
	) {
		super();

		this.gitWorktreeService = gitWorktreeService;
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

	async setPinned(id: string, pinned: boolean): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(id);
		project.pinned = pinned;
		project.order = this.storedProjects.reduce((max, entry) => {
			if (entry.id === project.id || entry.pinned !== pinned) {
				return max;
			}

			return Math.max(max, entry.order);
		}, 0) + 1;
		this.saveState();
		this.emitChange();
	}

	async removeProject(id: string): Promise<void> {
		this.ensureStateLoaded();
		this.requireProject(id);
		this.storedProjects = this.storedProjects.filter(project => project.id !== id);
		this.projectWorktrees.delete(id);
		this.saveState();
		this.emitChange();
	}

	async moveProject(id: string, beforeProjectId?: string): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(id);
		const beforeProject = beforeProjectId
			? this.requireProject(beforeProjectId)
			: undefined;

		if (beforeProject && beforeProject.pinned !== project.pinned) {
			throw new Error('Pinned and unpinned projects are reordered separately.');
		}

		const orderedProjects = this.storedProjects
			.filter(entry => entry.id !== project.id && entry.pinned === project.pinned)
			.sort((a, b) => a.order - b.order);
		const insertIndex = beforeProject
			? orderedProjects.findIndex(entry => entry.id === beforeProject.id)
			: orderedProjects.length;
		orderedProjects.splice(insertIndex, 0, project);

		this.setProjectOrder(project.pinned, orderedProjects.map(entry => entry.id));
		this.saveState();
		this.emitChange();
	}

	async refresh(id?: string): Promise<readonly ProjectRecord[]> {
		this.ensureStateLoaded();
		if (id) {
			await this.refreshProject(this.requireProject(id));
		} else {
			for (const project of this.storedProjects) {
				await this.refreshProject(project);
			}
		}

		this.saveState();
		this.emitChange();
		return this.toProjectRecords();
	}

	async createWorktree(
		projectId: string,
		options: CreateWorktreeOptions
	): Promise<WorktreeRecord> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		const existingWorktrees = this.projectWorktrees.get(projectId) ??
			await this.gitWorktreeService.listWorktrees(project.rootPath);
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
		const worktrees = this.projectWorktrees.get(projectId) ??
			await this.gitWorktreeService.listWorktrees(project.rootPath);
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
		const worktrees = this.projectWorktrees.get(projectId) ??
			await this.refreshProject(project);
		const source = worktrees.find(entry =>
			this.pathsEqual(entry.path, worktreePath)
		);
		if (!source) {
			throw new Error(`Unknown worktree "${worktreePath}".`);
		}
		if (source.isMain) {
			throw new Error('The main worktree cannot be reordered.');
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
		this.projectWorktrees.set(project.id, this.applyWorktreeOrder(project, worktrees));
		this.saveState();
		this.emitChange();
	}

	async setLastActiveWorktree(
		projectId: string,
		worktreePath: string
	): Promise<void> {
		this.ensureStateLoaded();
		const project = this.requireProject(projectId);
		project.lastActiveWorktreePath = worktreePath;
		this.saveState();
		this.emitChange();
	}

	private async refreshProject(
		project: StoredProjectRecord
	): Promise<readonly WorktreeRecord[]> {
		try {
			const worktrees = this.applyWorktreeOrder(
				project,
				await this.gitWorktreeService.listWorktrees(
					project.rootPath
				)
			);
			this.projectWorktrees.set(project.id, worktrees);
			this.pruneWorktreeOrder(project, worktrees);

			if (project.lastActiveWorktreePath &&
				!worktrees.some(worktree =>
					this.pathsEqual(worktree.path, project.lastActiveWorktreePath!)
				)
			) {
				project.lastActiveWorktreePath = undefined;
			}

			return worktrees;
		} catch (error) {
			this.logService.warn(
				`[ProjectManagerMainService] Failed to refresh ` +
				`${project.rootPath}: ${error}`
			);
			this.projectWorktrees.set(project.id, []);
			return [];
		}
	}

	private toProjectRecords(): readonly ProjectRecord[] {
		return this.storedProjects
			.slice()
			.sort((a, b) => {
				if (a.pinned !== b.pinned) {
					return a.pinned ? -1 : 1;
				}

				return a.order - b.order;
			})
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

	private setProjectOrder(
		pinned: boolean,
		orderedProjectIds: readonly string[]
	): void {
		const orderedIdSet = new Set(orderedProjectIds);
		const otherProjects = this.storedProjects
			.filter(project => project.pinned !== pinned)
			.sort((a, b) => {
				if (a.pinned !== b.pinned) {
					return a.pinned ? -1 : 1;
				}

				return a.order - b.order;
			});
		const reorderedProjects = orderedProjectIds.map(id => this.requireProject(id));
		for (const project of this.storedProjects) {
			if (project.pinned === pinned && !orderedIdSet.has(project.id)) {
				reorderedProjects.push(project);
			}
		}

		const orderedProjects = pinned
			? [...reorderedProjects, ...otherProjects]
			: [...otherProjects, ...reorderedProjects];
		for (const [index, project] of orderedProjects.entries()) {
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
		const state = this.stateService.getItem<StoredProjectManagerState>(
			PROJECT_MANAGER_STORAGE_KEY
		);
		if (!state || state.version !== PROJECT_MANAGER_STORAGE_VERSION) {
			return [];
		}

		return state.projects.map(project => ({ ...project }));
	}

	private saveState(): void {
		const state: StoredProjectManagerState = {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: this.storedProjects,
		};
		this.stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, state);
	}

	private pathsEqual(pathA: string, pathB: string): boolean {
		return isEqual(pathA, pathB, !isLinux);
	}

	private getPathComparisonKey(path: string): string {
		return isLinux ? path : path.toLowerCase();
	}

	private applyWorktreeOrder(
		project: StoredProjectRecord,
		worktrees: readonly WorktreeRecord[]
	): readonly WorktreeRecord[] {
		const orderedPaths = project.worktreeOrder ?? [];
		const orderIndex = new Map<string, number>(
			orderedPaths.map((path, index) => [
				this.getPathComparisonKey(path),
				index
			])
		);
		const mainWorktrees = worktrees.filter(entry => entry.isMain);
		const linkedWorktrees = worktrees
			.filter(entry => !entry.isMain)
			.slice()
			.sort((a, b) => {
				const aIndex = orderIndex.get(
					this.getPathComparisonKey(a.path)
				);
				const bIndex = orderIndex.get(
					this.getPathComparisonKey(b.path)
				);
				if (aIndex !== undefined || bIndex !== undefined) {
					if (aIndex === undefined) {
						return 1;
					}
					if (bIndex === undefined) {
						return -1;
					}
					return aIndex - bIndex;
				}

				return a.label.localeCompare(b.label) ||
					a.path.localeCompare(b.path);
			});

		return [...mainWorktrees, ...linkedWorktrees];
	}

	private pruneWorktreeOrder(
		project: StoredProjectRecord,
		worktrees: readonly WorktreeRecord[]
	): void {
		if (!project.worktreeOrder?.length) {
			return;
		}

		const existingPaths = new Set(
			worktrees
				.filter(entry => !entry.isMain)
				.map(entry => this.getPathComparisonKey(entry.path))
		);
		const worktreeOrder = project.worktreeOrder.filter(path =>
			existingPaths.has(this.getPathComparisonKey(path))
		);
		project.worktreeOrder = worktreeOrder.length
			? worktreeOrder
			: undefined;
	}

	private async hydrateMissingProjectWorktrees(): Promise<void> {
		let didChange = false;

		for (const project of this.storedProjects) {
			if (this.projectWorktrees.has(project.id)) {
				continue;
			}

			await this.refreshProject(project);
			didChange = true;
		}

		if (didChange) {
			this.saveState();
		}
	}
}
