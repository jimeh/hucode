/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqual } from '../../../base/common/extpath.js';
import {
	PROJECT_MANAGER_STORAGE_VERSION,
	StoredProjectManagerState,
	StoredProjectRecord,
	StoredWorktreeLabel,
	WorktreeRecord,
} from './projectManager.js';

/**
 * Returns a cloned project list from a compatible persisted project state.
 */
export function loadStoredProjectManagerState(
	state: StoredProjectManagerState | undefined
): StoredProjectRecord[] {
	if (!state || state.version !== PROJECT_MANAGER_STORAGE_VERSION) {
		return [];
	}

	return state.projects.map(project => ({
		...project,
		...(project.worktreeOrder
			? { worktreeOrder: [...project.worktreeOrder] }
			: {}),
		...(project.pinnedWorktreePaths
			? { pinnedWorktreePaths: [...project.pinnedWorktreePaths] }
			: {}),
		...(project.worktreeLabels
			? {
				worktreeLabels: project.worktreeLabels.map(label => ({
					...label,
				})),
			}
			: {}),
		...(project.worktreeVisits
			? {
				worktreeVisits: project.worktreeVisits.map(visit => ({
					...visit,
				})),
			}
			: {}),
	}));
}

/**
 * Creates the persisted project-manager state shape.
 */
export function createStoredProjectManagerState(
	projects: readonly StoredProjectRecord[]
): StoredProjectManagerState {
	return {
		version: PROJECT_MANAGER_STORAGE_VERSION,
		projects,
	};
}

/**
 * Returns whether two project-manager paths identify the same filesystem path.
 */
export function projectManagerPathsEqual(
	pathA: string,
	pathB: string,
	isCaseSensitive: boolean
): boolean {
	return isEqual(pathA, pathB, !isCaseSensitive);
}

/**
 * Returns the map/set key used for project-manager path comparisons.
 */
export function getProjectManagerPathComparisonKey(
	path: string,
	isCaseSensitive: boolean
): string {
	return isCaseSensitive ? path : path.toLowerCase();
}

/**
 * Removes a worktree path from a path list using platform path semantics.
 */
export function filterStoredWorktreePath(
	paths: readonly string[],
	worktreePath: string,
	isCaseSensitive: boolean
): string[] {
	return paths.filter(path =>
		!projectManagerPathsEqual(path, worktreePath, isCaseSensitive)
	);
}

/**
 * Removes a worktree label from a label list using platform path semantics.
 */
export function filterStoredWorktreeLabel(
	labels: readonly StoredWorktreeLabel[],
	worktreePath: string,
	isCaseSensitive: boolean
): StoredWorktreeLabel[] {
	return labels.filter(entry =>
		!projectManagerPathsEqual(entry.path, worktreePath, isCaseSensitive)
	);
}

/**
 * Applies persisted custom labels to discovered worktrees.
 */
export function applyStoredWorktreeLabels(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): readonly WorktreeRecord[] {
	const labelsByPath = new Map(
		(project.worktreeLabels ?? []).map(entry => [
			getProjectManagerPathComparisonKey(entry.path, isCaseSensitive),
			entry.label,
		])
	);
	return worktrees.map(worktree => {
		const customLabel = labelsByPath.get(
			getProjectManagerPathComparisonKey(worktree.path, isCaseSensitive)
		);
		const baseWorktree = toBaseWorktreeRecord(worktree);
		return customLabel
			? { ...baseWorktree, customLabel }
			: baseWorktree;
	});
}

/**
 * Applies persisted ordering to discovered worktrees.
 */
export function applyStoredWorktreeOrder(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): readonly WorktreeRecord[] {
	const orderedPaths = project.worktreeOrder ?? [];
	const orderIndex = new Map<string, number>(
		orderedPaths.map((path, index) => [
			getProjectManagerPathComparisonKey(path, isCaseSensitive),
			index
		])
	);
	const mainWorktrees = worktrees.filter(entry => entry.isMain);
	const linkedWorktrees = worktrees
		.filter(entry => !entry.isMain)
		.slice()
		.sort((a, b) => {
			const aIndex = orderIndex.get(
				getProjectManagerPathComparisonKey(a.path, isCaseSensitive)
			);
			const bIndex = orderIndex.get(
				getProjectManagerPathComparisonKey(b.path, isCaseSensitive)
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

/**
 * Applies persisted pinned state to discovered worktrees.
 */
export function applyStoredWorktreePins(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): readonly WorktreeRecord[] {
	const pinnedPaths = new Set(
		(project.pinnedWorktreePaths ?? []).map(path =>
			getProjectManagerPathComparisonKey(path, isCaseSensitive)
		)
	);
	return worktrees.map(worktree => {
		// Re-derive pinned from stored state, so drop any incoming pinned flag
		// while preserving the custom label.
		const core = copyWorktreeCoreFields(worktree);
		const unpinnedWorktree: WorktreeRecord =
			worktree.customLabel !== undefined
				? { ...core, customLabel: worktree.customLabel }
				: core;
		if (!pinnedPaths.has(
			getProjectManagerPathComparisonKey(worktree.path, isCaseSensitive)
		)) {
			return unpinnedWorktree;
		}

		return { ...unpinnedWorktree, pinned: true };
	});
}

/**
 * Applies persisted visit timestamps to discovered worktrees.
 */
export function applyStoredWorktreeVisits(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): readonly WorktreeRecord[] {
	const visitsByPath = new Map(
		(project.worktreeVisits ?? []).map(entry => [
			getProjectManagerPathComparisonKey(entry.path, isCaseSensitive),
			entry.lastVisitedAt,
		])
	);
	return worktrees.map(worktree => {
		const lastVisitedAt = visitsByPath.get(
			getProjectManagerPathComparisonKey(worktree.path, isCaseSensitive)
		);
		return lastVisitedAt !== undefined
			? { ...worktree, lastVisitedAt }
			: worktree;
	});
}

/**
 * Stores a visit timestamp for one worktree path.
 */
export function setStoredWorktreeVisited(
	project: StoredProjectRecord,
	worktreePath: string,
	lastVisitedAt: number,
	isCaseSensitive: boolean
): void {
	const visits = (project.worktreeVisits ?? []).filter(entry =>
		!projectManagerPathsEqual(entry.path, worktreePath, isCaseSensitive)
	);
	project.worktreeVisits = [
		...visits,
		{ path: worktreePath, lastVisitedAt },
	];
}

/**
 * Filters a stored per-worktree list down to entries whose worktree still
 * exists, collapsing to undefined once empty. An already-empty list is left
 * untouched. Shared by the pruneStored* helpers, which differ only in how an
 * item's path is read and which worktrees count as existing.
 */
function pruneStoredWorktreeList<T>(
	list: readonly T[] | undefined,
	getPath: (item: T) => string,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean,
	includeWorktree: (worktree: WorktreeRecord) => boolean = () => true
): readonly T[] | undefined {
	if (!list?.length) {
		return list;
	}

	const existingPaths = new Set(
		worktrees
			.filter(includeWorktree)
			.map(entry =>
				getProjectManagerPathComparisonKey(entry.path, isCaseSensitive)
			)
	);
	const pruned = list.filter(item =>
		existingPaths.has(
			getProjectManagerPathComparisonKey(getPath(item), isCaseSensitive)
		)
	);
	return pruned.length ? pruned : undefined;
}

/**
 * Drops persisted worktree ordering for worktrees that no longer exist.
 */
export function pruneStoredWorktreeOrder(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): void {
	project.worktreeOrder = pruneStoredWorktreeList(
		project.worktreeOrder,
		path => path,
		worktrees,
		isCaseSensitive,
		entry => !entry.isMain
	);
}

/**
 * Drops pinned worktree paths that no longer exist.
 */
export function pruneStoredPinnedWorktreePaths(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): void {
	project.pinnedWorktreePaths = pruneStoredWorktreeList(
		project.pinnedWorktreePaths,
		path => path,
		worktrees,
		isCaseSensitive
	);
}

/**
 * Drops custom worktree labels for worktrees that no longer exist.
 */
export function pruneStoredWorktreeLabels(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): void {
	project.worktreeLabels = pruneStoredWorktreeList(
		project.worktreeLabels,
		entry => entry.path,
		worktrees,
		isCaseSensitive
	);
}

/**
 * Drops worktree visit timestamps for worktrees that no longer exist.
 */
export function pruneStoredWorktreeVisits(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): void {
	project.worktreeVisits = pruneStoredWorktreeList(
		project.worktreeVisits,
		entry => entry.path,
		worktrees,
		isCaseSensitive
	);
}

/**
 * Copies the worktree fields common to every rebuilt record, excluding the
 * customLabel and pinned flags that individual callers re-derive.
 */
function copyWorktreeCoreFields(worktree: WorktreeRecord): WorktreeRecord {
	return {
		path: worktree.path,
		label: worktree.label,
		...(worktree.branch !== undefined
			? { branch: worktree.branch }
			: {}),
		isMain: worktree.isMain,
		isDetached: worktree.isDetached,
		...(worktree.lastVisitedAt !== undefined
			? { lastVisitedAt: worktree.lastVisitedAt }
			: {}),
	};
}

/**
 * Rebuilds a worktree record without its custom label, so callers re-deriving
 * labels start from a clean base while keeping any pinned flag.
 */
function toBaseWorktreeRecord(worktree: WorktreeRecord): WorktreeRecord {
	const core = copyWorktreeCoreFields(worktree);
	return worktree.pinned !== undefined
		? { ...core, pinned: worktree.pinned }
		: core;
}
