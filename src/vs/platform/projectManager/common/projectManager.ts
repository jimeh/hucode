/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * IPC channel name for the Hucode project manager service.
 */
export const PROJECT_MANAGER_CHANNEL_NAME = 'projectManager';
/** Maximum arbitrary folders monitored for one Projects sidebar. */
export const PROJECT_MANAGER_GIT_TARGET_LIMIT = 128;

/** Returns the desktop Git-monitor consumer owned by one Projects window. */
export function getProjectSwitcherGitConsumerId(windowId: number): string {
	return `project-switcher:window:${windowId}`;
}

/**
 * Application storage key for persisted Hucode project metadata.
 */
export const PROJECT_MANAGER_STORAGE_KEY = 'hucode.projectManager.projects';
/**
 * Version number for the persisted Hucode project metadata schema.
 */
export const PROJECT_MANAGER_STORAGE_VERSION = 1;

/**
 * Discovered git worktree metadata for a tracked project.
 */
export interface WorktreeRecord {
	readonly path: string;
	readonly label: string;
	readonly customLabel?: string;
	readonly branch?: string;
	readonly isMain: boolean;
	readonly isDetached: boolean;
	readonly pinned?: boolean;
	readonly lastVisitedAt?: number;
}

/** Runtime freshness of Git metadata observed for an arbitrary target path. */
export type GitWorktreeTargetState =
	| 'current'
	| 'stale'
	| 'notRepository'
	| 'unavailable';

/**
 * Ephemeral Git metadata for a folder monitored by an interested consumer.
 */
export interface GitWorktreeTargetObservation {
	readonly targetPath: string;
	readonly state: GitWorktreeTargetState;
	readonly repositoryRoot?: string;
	readonly worktree?: WorktreeRecord;
}

/** Git-monitor update scoped to the consumer that registered the targets. */
export interface GitWorktreeTargetChange {
	readonly consumerId: string;
	readonly observations: readonly GitWorktreeTargetObservation[];
}

/**
 * Runtime freshness of a project's discovered worktrees.
 */
export type ProjectWorktreeState = 'current' | 'stale' | 'unavailable';

/**
 * Runtime project record exposed to the workbench.
 */
export interface ProjectRecord {
	readonly id: string;
	readonly label: string;
	readonly rootUri: URI;
	readonly pinned: boolean;
	readonly order: number;
	readonly lastActiveWorktreePath?: string;
	readonly worktreeState: ProjectWorktreeState;
	readonly worktrees: readonly WorktreeRecord[];
}

/**
 * Git reference that can be used as the start point for a new worktree.
 */
export interface WorktreeRefRecord {
	readonly name: string;
	readonly type: 'head' | 'remote' | 'tag';
	readonly commit?: string;
	readonly upstream?: string;
	readonly tracking?: string;
	readonly relativeDate?: string;
	readonly authorName?: string;
	readonly subject?: string;
	readonly checkedOutPath?: string;
}

/**
 * Supported ordering modes for git refs shown in worktree pickers.
 */
export type WorktreeRefSortOrder = 'alphabetically' | 'committerdate';

/**
 * Options for listing git references that can start a new worktree.
 */
export interface WorktreeRefQueryOptions {
	readonly sort?: WorktreeRefSortOrder;
}

/**
 * Persisted custom display label for a git worktree path.
 */
export interface StoredWorktreeLabel {
	readonly path: string;
	readonly label: string;
}

/**
 * Persisted most-recently-used timestamp for a git worktree path.
 */
export interface StoredWorktreeVisit {
	readonly path: string;
	readonly lastVisitedAt: number;
}

/**
 * Persisted subset of project metadata stored in application state.
 */
export interface StoredProjectRecord {
	id: string;
	label: string;
	rootPath: string;
	pinned: boolean;
	order: number;
	lastActiveWorktreePath?: string;
	worktreeOrder?: readonly string[];
	pinnedWorktreePaths?: readonly string[];
	worktreeLabels?: readonly StoredWorktreeLabel[];
	worktreeVisits?: readonly StoredWorktreeVisit[];
}

/**
 * Persisted schema for the Hucode project registry.
 */
export interface StoredProjectManagerState {
	readonly version: number;
	readonly projects: readonly StoredProjectRecord[];
}

/**
 * Options for creating a new git worktree for a tracked project.
 */
export interface CreateWorktreeOptions {
	readonly branchName?: string;
	readonly startPoint?: string;
	readonly detached?: boolean;
	readonly path?: string;
}

/**
 * One path reported by `git status --porcelain=v1`.
 */
export interface WorktreeStatusEntry {
	readonly indexStatus: string;
	readonly worktreeStatus: string;
	readonly path: string;
	readonly originalPath?: string;
}

/**
 * Bounded worktree status shown before destructive removal.
 */
export interface WorktreeStatusPreview {
	readonly fingerprint: string;
	readonly totalCount: number;
	readonly entries: readonly WorktreeStatusEntry[];
	readonly omittedCount: number;
	/**
	 * The worktree folder was absent when this status snapshot was created.
	 */
	readonly missing?: true;
}

/**
 * Preconditions and mode for removing a worktree.
 */
export interface RemoveWorktreeOptions {
	readonly force: boolean;
	readonly expectedStatusFingerprint: string;
}

/**
 * Result of a conditional worktree removal.
 */
export type RemoveWorktreeResult =
	| { readonly removed: true }
	| {
		readonly removed: false;
		readonly status: WorktreeStatusPreview;
	};

export const IProjectManagerService =
	createDecorator<IProjectManagerService>('projectManagerService');

/**
 * Workbench-facing Hucode project registry and worktree service.
 */
export interface IProjectManagerService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeProjects: Event<readonly ProjectRecord[]>;
	readonly onDidChangeGitWorktreeTargets: Event<GitWorktreeTargetChange>;

	getProjects(): Promise<readonly ProjectRecord[]>;
	addProject(uri: URI): Promise<ProjectRecord>;
	renameProject(id: string, label: string): Promise<void>;
	resetProjectLabel(id: string): Promise<void>;
	renameWorktree(
		projectId: string,
		worktreePath: string,
		label: string
	): Promise<void>;
	resetWorktreeLabel(
		projectId: string,
		worktreePath: string
	): Promise<void>;
	setPinned(id: string, pinned: boolean): Promise<void>;
	setWorktreePinned(
		projectId: string,
		worktreePath: string,
		pinned: boolean
	): Promise<void>;
	removeProject(id: string): Promise<void>;
	moveProject(id: string, beforeProjectId?: string): Promise<void>;
	refresh(id?: string): Promise<readonly ProjectRecord[]>;
	getWorktreeRefs(
		projectId: string,
		options?: WorktreeRefQueryOptions
	): Promise<readonly WorktreeRefRecord[]>;
	isValidBranchName(
		projectId: string,
		branchName: string
	): Promise<boolean>;
	createWorktree(
		projectId: string,
		options: CreateWorktreeOptions
	): Promise<WorktreeRecord>;
	getWorktreeStatus(
		projectId: string,
		worktreePath: string
	): Promise<WorktreeStatusPreview>;
	removeWorktree(
		projectId: string,
		worktreePath: string,
		options: RemoveWorktreeOptions
	): Promise<RemoveWorktreeResult>;
	moveWorktree(
		projectId: string,
		worktreePath: string,
		beforeWorktreePath?: string
	): Promise<void>;
	setLastActiveWorktree(projectId: string, worktreePath: string): Promise<void>;
	/** Replaces one consumer's complete ephemeral Git-monitor target set. */
	setGitWorktreeTargets(
		consumerId: string,
		targetPaths: readonly string[]
	): Promise<readonly GitWorktreeTargetObservation[]>;
	/** Releases all Git-monitor resources owned only by one consumer. */
	clearGitWorktreeTargets(consumerId: string): Promise<void>;
}
