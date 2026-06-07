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

/**
 * Context value used by regular project rows in the Projects tree.
 */
export const PROJECT_CONTEXT_VALUE = 'hucode-project';
/**
 * Context value used by pinned project rows in the Projects tree.
 */
export const PINNED_PROJECT_CONTEXT_VALUE = 'hucode-project-pinned';
/**
 * Context value used by regular worktree rows in the Projects tree.
 */
export const WORKTREE_CONTEXT_VALUE = 'hucode-worktree';
/**
 * Context value used by the main worktree row in the Projects tree.
 */
export const MAIN_WORKTREE_CONTEXT_VALUE = 'hucode-worktree-main';
/**
 * Context value used by hosted workbench rows whose git worktree disappeared.
 */
export const MISSING_WORKTREE_CONTEXT_VALUE = 'hucode-worktree-missing';
/**
 * Context value used by pinned/unpinned separator rows.
 */
export const PROJECT_GROUP_SEPARATOR_CONTEXT_VALUE =
	'hucode-project-group-separator';
/**
 * Stable handle for the pinned section separator.
 */
export const PINNED_SEPARATOR_HANDLE = 'separator:pinned';
/**
 * Stable handle for the unpinned section separator.
 */
export const UNPINNED_SEPARATOR_HANDLE = 'separator:unpinned';

/**
 * Visual section a project or worktree row is rendered in.
 */
export type ProjectSwitcherSection = 'pinned' | 'unpinned';

/**
 * Project switcher section for pinned projects and pinned worktrees.
 */
export const PINNED_SECTION: ProjectSwitcherSection = 'pinned';
/**
 * Project switcher section for unpinned projects and worktrees.
 */
export const UNPINNED_SECTION: ProjectSwitcherSection = 'unpinned';

/**
 * Common row contract for Project Switcher tree items.
 */
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

/**
 * Project row rendered by the Project Switcher tree.
 */
export interface ProjectSwitcherProjectItem
	extends ProjectSwitcherBaseItem {
	readonly kind: 'project';
	readonly projectId: string;
	readonly pinned: boolean;
	readonly section: ProjectSwitcherSection;
	readonly rootPath: string;
	readonly hasCustomLabel: boolean;
}

/**
 * Worktree row rendered under a project in the Project Switcher tree.
 */
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
	readonly missingGitWorktree: boolean;
}

/**
 * Separator row rendered between pinned and unpinned sections.
 */
export interface ProjectSwitcherSeparatorItem extends ProjectSwitcherBaseItem {
	readonly kind: 'separator';
}

/**
 * Union of all rows that can appear in the Project Switcher tree.
 */
export type ProjectSwitcherItem =
	| ProjectSwitcherProjectItem
	| ProjectSwitcherWorktreeItem
	| ProjectSwitcherSeparatorItem;

/**
 * Object-tree element used to populate the Project Switcher tree widget.
 */
export interface ProjectSwitcherTreeElement {
	readonly element: ProjectSwitcherItem;
	readonly collapsible?: boolean;
	readonly collapsed?: boolean;
	readonly children?: readonly ProjectSwitcherTreeElement[];
}

/**
 * Built Project Switcher tree roots and handle lookup table.
 */
export interface ProjectSwitcherTreeModel {
	readonly roots: readonly ProjectSwitcherTreeElement[];
	readonly itemsById: Map<string, ProjectSwitcherItem>;
}

/**
 * Input state needed to build a Project Switcher tree model.
 */
export interface IProjectSwitcherTreeModelOptions {
	readonly projects: readonly ProjectRecord[];
	readonly collapsedProjectIds: ReadonlySet<string>;
	readonly getPathLabel: (path: string) => string;
	readonly isOmniWindow: boolean;
	readonly activeWorktreePath?: string;
	readonly hostedWorkspaceState: IHucodeHostedWorkspaceState;
}

/**
 * Encodes a project row handle for a visual section.
 *
 * @param projectId Project manager record identifier.
 * @param section Visual section containing the project row.
 * @returns A stable tree handle in `project:<section>:<projectId>` format.
 */
export function encodeProjectHandle(
	projectId: string,
	section: ProjectSwitcherSection
): string {
	return `project:${section}:${projectId}`;
}

/**
 * Encodes a worktree row handle.
 *
 * @param projectId Project manager record identifier.
 * @param worktreePath Absolute worktree path.
 * @returns A stable tree handle with the worktree path URI-encoded.
 */
export function encodeWorktreeHandle(
	projectId: string,
	worktreePath: string
): string {
	return `worktree:${projectId}:${encodeURIComponent(worktreePath)}`;
}

/**
 * Builds the identity id for a worktree row.
 *
 * @param projectId Project manager record identifier.
 * @param worktreePath Absolute worktree path.
 * @param hostedWorkbenchInstanceId Hosted instance id when the worktree is
 * loaded in Omni.
 * @returns A row id that changes when the worktree loads into a hosted
 * workbench instance.
 */
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

/**
 * Checks whether a hosted workbench is still starting.
 *
 * @param state Hosted workbench lifecycle state.
 * @returns `true` for restore-pending and loading states.
 */
export function isHostedWorkbenchInProgress(
	state: HucodeHostedWorkbenchLifecycleState | undefined
): boolean {
	return state === 'restore-pending' || state === 'loading';
}

/**
 * Type guard for project rows.
 *
 * @param item Candidate Project Switcher row.
 * @returns Whether the row is a project item.
 */
export function isProjectItem(
	item: ProjectSwitcherItem | undefined
): item is ProjectSwitcherProjectItem {
	return item?.kind === 'project';
}

/**
 * Type guard for worktree rows.
 *
 * @param item Candidate Project Switcher row.
 * @returns Whether the row is a worktree item.
 */
export function isWorktreeItem(
	item: ProjectSwitcherItem | undefined
): item is ProjectSwitcherWorktreeItem {
	return item?.kind === 'worktree';
}

/**
 * Type guard for separator rows.
 *
 * @param item Candidate Project Switcher row.
 * @returns Whether the row is a separator item.
 */
export function isSeparatorItem(
	item: ProjectSwitcherItem | undefined
): item is ProjectSwitcherSeparatorItem {
	return item?.kind === 'separator';
}

/**
 * Compares two file-system paths using platform-aware casing rules.
 *
 * @param pathA First path to compare.
 * @param pathB Second path to compare.
 * @returns Whether the paths refer to the same location.
 */
export function pathsEqual(pathA: string, pathB: string): boolean {
	return isEqual(pathA, pathB, !isLinux);
}

/**
 * Resolves the visible label for a worktree row.
 *
 * @param worktree Worktree record from the project manager.
 * @returns Custom label, `local` for the main worktree, or the path basename.
 */
export function getWorktreeDisplayLabel(worktree: WorktreeRecord): string {
	return worktree.customLabel ??
		(worktree.isMain
			? localize('localWorktree', 'local')
			: basename(worktree.path));
}

/**
 * Compares two project/worktree selection targets.
 *
 * @param a First selection target.
 * @param b Second selection target.
 * @returns Whether both targets point at the same project and worktree path.
 */
export function selectionTargetsEqual(
	a: { readonly projectId: string; readonly worktreePath: string } | undefined,
	b: { readonly projectId: string; readonly worktreePath: string } | undefined
): boolean {
	return a?.projectId === b?.projectId &&
		typeof a?.worktreePath === 'string' &&
		typeof b?.worktreePath === 'string' &&
		pathsEqual(a.worktreePath, b.worktreePath);
}

/**
 * Builds Project Switcher tree rows from project manager and Omni state.
 *
 * @param options Project, collapse, label, and hosted-workspace state.
 * @returns Root tree elements and a lookup table keyed by tree handle.
 */
export function buildProjectSwitcherTreeModel(
	options: IProjectSwitcherTreeModelOptions
): ProjectSwitcherTreeModel {
	const itemsById = new Map<string, ProjectSwitcherItem>();
	const roots: ProjectSwitcherTreeElement[] = [];
	const pinnedProjectElements: ProjectSwitcherTreeElement[] = [];
	const unpinnedProjectElements: ProjectSwitcherTreeElement[] = [];

	for (const project of options.projects) {
		const missingHostedInstances = getMissingHostedWorkbenchInstances(
			project,
			options
		);
		const pinnedWorktrees = project.pinned
			? project.worktrees
			: project.worktrees.filter(worktree => worktree.pinned);
		const unpinnedWorktrees = project.pinned
			? []
			: project.worktrees.filter(worktree => !worktree.pinned);
		const pinnedMissingInstances = project.pinned
			? missingHostedInstances
			: [];
		const unpinnedMissingInstances = project.pinned
			? []
			: missingHostedInstances;

		if (pinnedWorktrees.length || pinnedMissingInstances.length) {
			pinnedProjectElements.push(toProjectElement(
				project,
				pinnedWorktrees,
				pinnedMissingInstances,
				PINNED_SECTION,
				options,
				itemsById
			));
		}
		if (unpinnedWorktrees.length || unpinnedMissingInstances.length) {
			unpinnedProjectElements.push(toProjectElement(
				project,
				unpinnedWorktrees,
				unpinnedMissingInstances,
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
	missingHostedInstances: readonly IHucodeHostedWorkbenchInstance[],
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
		children: [
			...worktrees.map(worktree =>
				toWorktreeElement(project, worktree, section, options, itemsById)
			),
			...missingHostedInstances.map(instance =>
				toMissingWorktreeElement(
					project,
					instance,
					section,
					options,
					itemsById
				)
			),
		],
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
		missingGitWorktree: false,
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

function toMissingWorktreeElement(
	project: ProjectRecord,
	hostedWorkbenchInstance: IHucodeHostedWorkbenchInstance,
	section: ProjectSwitcherSection,
	options: IProjectSwitcherTreeModelOptions,
	itemsById: Map<string, ProjectSwitcherItem>
): ProjectSwitcherTreeElement {
	const isActive = typeof options.activeWorktreePath === 'string' &&
		pathsEqual(options.activeWorktreePath, hostedWorkbenchInstance.worktreePath);
	const item: ProjectSwitcherWorktreeItem = {
		id: getWorktreeItemId(
			project.id,
			hostedWorkbenchInstance.worktreePath,
			hostedWorkbenchInstance.instanceId
		),
		handle: encodeWorktreeHandle(
			project.id,
			hostedWorkbenchInstance.worktreePath
		),
		kind: 'worktree',
		projectId: project.id,
		worktreePath: hostedWorkbenchInstance.worktreePath,
		isMain: false,
		pinned: false,
		section,
		hostedWorkbenchInstanceId: hostedWorkbenchInstance.instanceId,
		hostedWorkbenchState: hostedWorkbenchInstance.state,
		isActive,
		hasCustomLabel: false,
		missingGitWorktree: true,
		label: basename(hostedWorkbenchInstance.worktreePath),
		description: localize('missingGitWorktree', 'Missing'),
		tooltip: options.getPathLabel(hostedWorkbenchInstance.worktreePath),
		contextValue: MISSING_WORKTREE_CONTEXT_VALUE,
		themeIcon: Codicon.warning,
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

function getMissingHostedWorkbenchInstances(
	project: ProjectRecord,
	options: IProjectSwitcherTreeModelOptions
): readonly IHucodeHostedWorkbenchInstance[] {
	if (!options.isOmniWindow) {
		return [];
	}

	return options.hostedWorkspaceState.instances.filter(instance =>
		instance.projectId === project.id &&
		instance.state !== 'crashed' &&
		instance.state !== 'unloaded' &&
		!project.worktrees.some(worktree =>
			pathsEqual(worktree.path, instance.worktreePath)
		)
	);
}
