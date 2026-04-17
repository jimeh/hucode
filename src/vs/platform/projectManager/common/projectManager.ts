/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * IPC channel name for the Hucode project manager service.
 */
export const PROJECT_MANAGER_CHANNEL_NAME = 'projectManager';
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
	readonly branch?: string;
	readonly isMain: boolean;
	readonly isDetached: boolean;
}

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
	readonly worktrees: readonly WorktreeRecord[];
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
	readonly branchName: string;
	readonly startPoint?: string;
	readonly path?: string;
}

export const IProjectManagerService =
	createDecorator<IProjectManagerService>('projectManagerService');

/**
 * Workbench-facing Hucode project registry and worktree service.
 */
export interface IProjectManagerService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeProjects: Event<readonly ProjectRecord[]>;

	getProjects(): Promise<readonly ProjectRecord[]>;
	addProject(uri: URI): Promise<ProjectRecord>;
	renameProject(id: string, label: string): Promise<void>;
	setPinned(id: string, pinned: boolean): Promise<void>;
	removeProject(id: string): Promise<void>;
	moveProject(id: string, beforeProjectId?: string): Promise<void>;
	refresh(id?: string): Promise<readonly ProjectRecord[]>;
	createWorktree(
		projectId: string,
		options: CreateWorktreeOptions
	): Promise<WorktreeRecord>;
	removeWorktree(projectId: string, worktreePath: string): Promise<void>;
	moveWorktree(
		projectId: string,
		worktreePath: string,
		beforeWorktreePath?: string
	): Promise<void>;
	setLastActiveWorktree(projectId: string, worktreePath: string): Promise<void>;
}
