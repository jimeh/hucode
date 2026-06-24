/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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

	return state.projects.map(project => ({ ...project }));
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
		const unpinnedWorktree: WorktreeRecord = {
			path: worktree.path,
			label: worktree.label,
			...(worktree.customLabel !== undefined
				? { customLabel: worktree.customLabel }
				: {}),
			...(worktree.branch !== undefined
				? { branch: worktree.branch }
				: {}),
			isMain: worktree.isMain,
			isDetached: worktree.isDetached,
			...(worktree.lastVisitedAt !== undefined
				? { lastVisitedAt: worktree.lastVisitedAt }
				: {}),
		};
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
 * Drops persisted worktree ordering for worktrees that no longer exist.
 */
export function pruneStoredWorktreeOrder(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): void {
	if (!project.worktreeOrder?.length) {
		return;
	}

	const existingPaths = new Set(
		worktrees
			.filter(entry => !entry.isMain)
			.map(entry =>
				getProjectManagerPathComparisonKey(entry.path, isCaseSensitive)
			)
	);
	const worktreeOrder = project.worktreeOrder.filter(path =>
		existingPaths.has(
			getProjectManagerPathComparisonKey(path, isCaseSensitive)
		)
	);
	project.worktreeOrder = worktreeOrder.length
		? worktreeOrder
		: undefined;
}

/**
 * Drops pinned worktree paths that no longer exist.
 */
export function pruneStoredPinnedWorktreePaths(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): void {
	if (!project.pinnedWorktreePaths?.length) {
		return;
	}

	const existingPaths = new Set(
		worktrees.map(entry =>
			getProjectManagerPathComparisonKey(entry.path, isCaseSensitive)
		)
	);
	const pinnedWorktreePaths = project.pinnedWorktreePaths.filter(path =>
		existingPaths.has(
			getProjectManagerPathComparisonKey(path, isCaseSensitive)
		)
	);
	project.pinnedWorktreePaths = pinnedWorktreePaths.length
		? pinnedWorktreePaths
		: undefined;
}

/**
 * Drops custom worktree labels for worktrees that no longer exist.
 */
export function pruneStoredWorktreeLabels(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): void {
	if (!project.worktreeLabels?.length) {
		return;
	}

	const existingPaths = new Set(
		worktrees.map(entry =>
			getProjectManagerPathComparisonKey(entry.path, isCaseSensitive)
		)
	);
	const worktreeLabels = project.worktreeLabels.filter(entry =>
		existingPaths.has(
			getProjectManagerPathComparisonKey(entry.path, isCaseSensitive)
		)
	);
	project.worktreeLabels = worktreeLabels.length
		? worktreeLabels
		: undefined;
}

/**
 * Drops worktree visit timestamps for worktrees that no longer exist.
 */
export function pruneStoredWorktreeVisits(
	project: StoredProjectRecord,
	worktrees: readonly WorktreeRecord[],
	isCaseSensitive: boolean
): void {
	if (!project.worktreeVisits?.length) {
		return;
	}

	const existingPaths = new Set(
		worktrees.map(entry =>
			getProjectManagerPathComparisonKey(entry.path, isCaseSensitive)
		)
	);
	const worktreeVisits = project.worktreeVisits.filter(entry =>
		existingPaths.has(
			getProjectManagerPathComparisonKey(entry.path, isCaseSensitive)
		)
	);
	project.worktreeVisits = worktreeVisits.length
		? worktreeVisits
		: undefined;
}

function toBaseWorktreeRecord(worktree: WorktreeRecord): WorktreeRecord {
	return {
		path: worktree.path,
		label: worktree.label,
		...(worktree.branch !== undefined
			? { branch: worktree.branch }
			: {}),
		isMain: worktree.isMain,
		isDetached: worktree.isDetached,
		...(worktree.pinned !== undefined
			? { pinned: worktree.pinned }
			: {}),
		...(worktree.lastVisitedAt !== undefined
			? { lastVisitedAt: worktree.lastVisitedAt }
			: {}),
	};
}
