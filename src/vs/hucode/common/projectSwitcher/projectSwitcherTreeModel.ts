/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
import { isEqual } from '../../../base/common/extpath.js';
import { basename } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import {
	ProjectRecord,
	WorktreeRecord,
} from '../../../platform/projectManager/common/projectManager.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeHostedWorkbenchInstance,
	IHucodeHostedWorkspaceState,
} from '../omniWindow.js';

export const PROJECT_CONTEXT_VALUE = 'hucode-project';
export const PINNED_PROJECT_CONTEXT_VALUE = 'hucode-project-pinned';
export const WORKTREE_CONTEXT_VALUE = 'hucode-worktree';
export const MAIN_WORKTREE_CONTEXT_VALUE = 'hucode-worktree-main';
export const PROJECT_GROUP_SEPARATOR_CONTEXT_VALUE =
	'hucode-project-group-separator';
export const PINNED_SEPARATOR_HANDLE = 'separator:pinned';
export const UNPINNED_SEPARATOR_HANDLE = 'separator:unpinned';

export type ProjectSwitcherSection = 'pinned' | 'unpinned';

export const PINNED_SECTION: ProjectSwitcherSection = 'pinned';
export const UNPINNED_SECTION: ProjectSwitcherSection = 'unpinned';

export interface ProjectSwitcherBaseItem {
	readonly id: string;
	readonly handle: string;
	readonly kind: 'project' | 'worktree' | 'separator';
	readonly label: string;
	readonly description?: string;
	readonly tooltip?: string;
	readonly contextValue: string;
	readonly themeIcon?: ThemeIcon;
}

export interface ProjectSwitcherProjectItem
	extends ProjectSwitcherBaseItem {
	readonly kind: 'project';
	readonly projectId: string;
	readonly pinned: boolean;
	readonly section: ProjectSwitcherSection;
	readonly rootPath: string;
	readonly hasCustomLabel: boolean;
}

export interface ProjectSwitcherWorktreeItem
	extends ProjectSwitcherBaseItem {
	readonly kind: 'worktree';
	readonly projectId: string;
	readonly worktreePath: string;
	readonly isMain: boolean;
	readonly pinned: boolean;
	readonly section: ProjectSwitcherSection;
	readonly hostedWorkbenchInstanceId?: string;
	readonly hostedWorkbenchState?: HucodeHostedWorkbenchLifecycleState;
	readonly isActive: boolean;
	readonly hasCustomLabel: boolean;
}

export interface ProjectSwitcherSeparatorItem extends ProjectSwitcherBaseItem {
	readonly kind: 'separator';
}

export type ProjectSwitcherItem =
	| ProjectSwitcherProjectItem
	| ProjectSwitcherWorktreeItem
	| ProjectSwitcherSeparatorItem;

export interface ProjectSwitcherTreeElement {
	readonly element: ProjectSwitcherItem;
	readonly collapsible?: boolean;
	readonly collapsed?: boolean;
	readonly children?: readonly ProjectSwitcherTreeElement[];
}

export interface ProjectSwitcherTreeModel {
	readonly roots: readonly ProjectSwitcherTreeElement[];
	readonly itemsById: Map<string, ProjectSwitcherItem>;
}

export interface IProjectSwitcherTreeModelOptions {
	readonly projects: readonly ProjectRecord[];
	readonly collapsedProjectIds: ReadonlySet<string>;
	readonly getPathLabel: (path: string) => string;
	readonly isOmniWindow: boolean;
	readonly activeWorktreePath?: string;
	readonly hostedWorkspaceState: IHucodeHostedWorkspaceState;
}

export function encodeProjectHandle(
	projectId: string,
	section: ProjectSwitcherSection
): string {
	return `project:${section}:${projectId}`;
}

export function encodeWorktreeHandle(
	projectId: string,
	worktreePath: string
): string {
	return `worktree:${projectId}:${encodeURIComponent(worktreePath)}`;
}

export function getWorktreeItemId(
	projectId: string,
	worktreePath: string,
	hostedWorkbenchInstanceId?: string
): string {
	const handle = encodeWorktreeHandle(projectId, worktreePath);
	return hostedWorkbenchInstanceId
		? `${handle}:loaded:${hostedWorkbenchInstanceId}`
		: `${handle}:idle`;
}

export function isHostedWorkbenchInProgress(
	state: HucodeHostedWorkbenchLifecycleState | undefined
): boolean {
	return state === 'restore-pending' || state === 'loading';
}

export function isProjectItem(
	item: ProjectSwitcherItem | undefined
): item is ProjectSwitcherProjectItem {
	return item?.kind === 'project';
}

export function isWorktreeItem(
	item: ProjectSwitcherItem | undefined
): item is ProjectSwitcherWorktreeItem {
	return item?.kind === 'worktree';
}

export function isSeparatorItem(
	item: ProjectSwitcherItem | undefined
): item is ProjectSwitcherSeparatorItem {
	return item?.kind === 'separator';
}

export function pathsEqual(pathA: string, pathB: string): boolean {
	return isEqual(pathA, pathB, !isLinux);
}

export function getWorktreeDisplayLabel(worktree: WorktreeRecord): string {
	return worktree.customLabel ??
		(worktree.isMain
			? localize('localWorktree', 'local')
			: basename(worktree.path));
}

export function selectionTargetsEqual(
	a: { readonly projectId: string; readonly worktreePath: string } | undefined,
	b: { readonly projectId: string; readonly worktreePath: string } | undefined
): boolean {
	return a?.projectId === b?.projectId &&
		typeof a?.worktreePath === 'string' &&
		typeof b?.worktreePath === 'string' &&
		pathsEqual(a.worktreePath, b.worktreePath);
}

export function buildProjectSwitcherTreeModel(
	options: IProjectSwitcherTreeModelOptions
): ProjectSwitcherTreeModel {
	const itemsById = new Map<string, ProjectSwitcherItem>();
	const roots: ProjectSwitcherTreeElement[] = [];
	const pinnedProjectElements: ProjectSwitcherTreeElement[] = [];
	const unpinnedProjectElements: ProjectSwitcherTreeElement[] = [];

	for (const project of options.projects) {
		const pinnedWorktrees = project.pinned
			? project.worktrees
			: project.worktrees.filter(worktree => worktree.pinned);
		const unpinnedWorktrees = project.pinned
			? []
			: project.worktrees.filter(worktree => !worktree.pinned);

		if (pinnedWorktrees.length) {
			pinnedProjectElements.push(toProjectElement(
				project,
				pinnedWorktrees,
				PINNED_SECTION,
				options,
				itemsById
			));
		}
		if (unpinnedWorktrees.length) {
			unpinnedProjectElements.push(toProjectElement(
				project,
				unpinnedWorktrees,
				UNPINNED_SECTION,
				options,
				itemsById
			));
		}
	}

	if (pinnedProjectElements.length) {
		const separator: ProjectSwitcherSeparatorItem = {
			id: PINNED_SEPARATOR_HANDLE,
			handle: PINNED_SEPARATOR_HANDLE,
			kind: 'separator',
			label: localize('pinnedProjects', 'Pinned'),
			contextValue: PROJECT_GROUP_SEPARATOR_CONTEXT_VALUE,
		};
		itemsById.set(separator.handle, separator);
		roots.push({ element: separator });
		roots.push(...pinnedProjectElements);
	}

	if (pinnedProjectElements.length && unpinnedProjectElements.length) {
		const separator: ProjectSwitcherSeparatorItem = {
			id: UNPINNED_SEPARATOR_HANDLE,
			handle: UNPINNED_SEPARATOR_HANDLE,
			kind: 'separator',
			label: localize('unpinnedProjects', 'Unpinned'),
			contextValue: PROJECT_GROUP_SEPARATOR_CONTEXT_VALUE,
		};
		itemsById.set(separator.handle, separator);
		roots.push({ element: separator });
	}

	roots.push(...unpinnedProjectElements);

	return { roots, itemsById };
}

function toProjectElement(
	project: ProjectRecord,
	worktrees: readonly WorktreeRecord[],
	section: ProjectSwitcherSection,
	options: IProjectSwitcherTreeModelOptions,
	itemsById: Map<string, ProjectSwitcherItem>
): ProjectSwitcherTreeElement {
	const rootUri = URI.revive(project.rootUri);
	const rootPath = rootUri.fsPath;
	const rootBasename = basename(rootPath);
	const handle = encodeProjectHandle(project.id, section);
	const item: ProjectSwitcherProjectItem = {
		id: handle,
		handle,
		kind: 'project',
		projectId: project.id,
		pinned: project.pinned,
		section,
		rootPath,
		hasCustomLabel: project.label !== rootBasename,
		label: project.label,
		description: project.label === rootBasename ? undefined : rootBasename,
		tooltip: options.getPathLabel(rootPath),
		contextValue: project.pinned
			? PINNED_PROJECT_CONTEXT_VALUE
			: PROJECT_CONTEXT_VALUE,
		themeIcon: Codicon.folder,
	};
	itemsById.set(item.handle, item);

	return {
		element: item,
		collapsible: true,
		collapsed: options.collapsedProjectIds.has(item.id) ||
			options.collapsedProjectIds.has(project.id),
		children: worktrees.map(worktree =>
			toWorktreeElement(project, worktree, section, options, itemsById)
		),
	};
}

function toWorktreeElement(
	project: ProjectRecord,
	worktree: WorktreeRecord,
	section: ProjectSwitcherSection,
	options: IProjectSwitcherTreeModelOptions,
	itemsById: Map<string, ProjectSwitcherItem>
): ProjectSwitcherTreeElement {
	const hostedWorkbenchInstance = getHostedWorkbenchInstance(
		worktree.path,
		options
	);
	const isActive = typeof options.activeWorktreePath === 'string' &&
		pathsEqual(options.activeWorktreePath, worktree.path);
	const worktreeLabel = getWorktreeDisplayLabel(worktree);
	const worktreeDescription = worktree.branch ??
		(worktree.isDetached
			? localize('detachedWorktree', 'Detached')
			: undefined);
	const item: ProjectSwitcherWorktreeItem = {
		id: getWorktreeItemId(
			project.id,
			worktree.path,
			hostedWorkbenchInstance?.instanceId
		),
		handle: encodeWorktreeHandle(project.id, worktree.path),
		kind: 'worktree',
		projectId: project.id,
		worktreePath: worktree.path,
		isMain: worktree.isMain,
		pinned: !!worktree.pinned,
		section,
		hostedWorkbenchInstanceId: hostedWorkbenchInstance?.instanceId,
		hostedWorkbenchState: hostedWorkbenchInstance?.state,
		isActive,
		hasCustomLabel: !!worktree.customLabel,
		label: worktreeLabel,
		description: worktreeLabel === worktreeDescription
			? undefined
			: worktreeDescription,
		tooltip: options.getPathLabel(worktree.path),
		contextValue: worktree.isMain
			? MAIN_WORKTREE_CONTEXT_VALUE
			: WORKTREE_CONTEXT_VALUE,
		themeIcon: isHostedWorkbenchInProgress(hostedWorkbenchInstance?.state)
			? ThemeIcon.modify(Codicon.loading, 'spin')
			: worktree.isMain ? Codicon.repo : Codicon.gitBranch,
	};
	itemsById.set(item.handle, item);
	return { element: item };
}

function getHostedWorkbenchInstance(
	worktreePath: string,
	options: IProjectSwitcherTreeModelOptions
): IHucodeHostedWorkbenchInstance | undefined {
	if (!options.isOmniWindow) {
		return undefined;
	}

	return options.hostedWorkspaceState.instances.find(instance =>
		pathsEqual(instance.worktreePath, worktreePath)
	);
}
