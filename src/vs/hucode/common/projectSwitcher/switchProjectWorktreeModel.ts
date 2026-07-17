/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMatch } from '../../../base/common/filters.js';
import {
	matchesFuzzyIconAware,
	parseLabelWithIcons,
} from '../../../base/common/iconLabels.js';
import { localize } from '../../../nls.js';
import {
	IQuickPickItem,
	IQuickPickItemHighlights,
	IQuickPickSeparator,
} from '../../../platform/quickinput/common/quickInput.js';
import { ProjectRecord, WorktreeRecord } from
	'../../../platform/projectManager/common/projectManager.js';

export interface IProjectSwitcherSelectionTarget {
	readonly projectId?: string;
	readonly worktreePath: string;
}

/** Timestamped project or arbitrary-workbench navigation target. */
export interface IProjectSwitcherNavigationHistoryEntry
	extends IProjectSwitcherSelectionTarget {
	readonly lastVisitedAt: number;
}

/** Globally orders mixed project and arbitrary-workbench history entries. */
export function sortProjectSwitcherNavigationHistory(
	entries: readonly IProjectSwitcherNavigationHistoryEntry[]
): IProjectSwitcherSelectionTarget[] {
	return [...entries]
		.sort((a, b) => a.lastVisitedAt - b.lastVisitedAt)
		.map(({ projectId, worktreePath }) => ({ projectId, worktreePath }));
}

export type SwitchWorktreeSearchField = {
	readonly target: keyof IQuickPickItemHighlights;
	readonly text: string;
};

export type SwitchWorktreeQuickPick = IQuickPickItem &
	IProjectSwitcherSelectionTarget & {
		readonly isCurrent: boolean;
		readonly isLoaded: boolean;
		readonly isDormant?: boolean;
		readonly lastVisitedAt?: number;
		readonly projectOrder: number;
		readonly worktreeOrder: number;
		readonly searchFields: readonly SwitchWorktreeSearchField[];
	};

export function filterSwitchWorktreePicks(
	picks: readonly SwitchWorktreeQuickPick[],
	query: string
): SwitchWorktreeQuickPick[] {
	const tokens = query.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length) {
		return picks.map(pick => ({ ...pick, highlights: undefined }));
	}

	const filteredPicks: SwitchWorktreeQuickPick[] = [];
	for (const pick of picks) {
		const highlights = getSwitchWorktreeHighlights(pick, tokens);
		if (highlights) {
			filteredPicks.push({ ...pick, highlights });
		}
	}

	return filteredPicks;
}

export function withSwitchWorktreeSeparators(
	picks: readonly SwitchWorktreeQuickPick[]
): ReadonlyArray<SwitchWorktreeQuickPick | IQuickPickSeparator> {
	const currentPicks = picks.filter(pick => pick.isCurrent);
	const loadedPicks = picks.filter(pick => pick.isLoaded && !pick.isCurrent);
	const dormantPicks = picks.filter(pick => pick.isDormant && !pick.isCurrent);
	const notLoadedPicks = picks.filter(pick =>
		!pick.isLoaded && !pick.isDormant
	);
	const items: Array<SwitchWorktreeQuickPick | IQuickPickSeparator> = [];

	if (currentPicks.length) {
		items.push({
			type: 'separator',
			label: localize('currentWorktrees', 'Current'),
		});
		items.push(...currentPicks);
	}

	if (loadedPicks.length) {
		items.push({
			type: 'separator',
			label: localize('loadedWorktrees', 'Loaded'),
		});
		items.push(...loadedPicks);
	}

	if (dormantPicks.length) {
		items.push({
			type: 'separator',
			label: localize('dormantWorkbenches', 'Dormant'),
		});
		items.push(...dormantPicks);
	}

	if (notLoadedPicks.length) {
		items.push({
			type: 'separator',
			label: localize('notLoadedWorktrees', 'Not Loaded'),
		});
		items.push(...notLoadedPicks);
	}

	return items;
}

export function getDefaultSwitchWorktreeActivePick(
	picks: readonly SwitchWorktreeQuickPick[]
): SwitchWorktreeQuickPick | undefined {
	return picks.find(pick => !pick.isCurrent) ?? picks[0];
}

export function getLoadedSwitchWorktreePicks(
	picks: readonly SwitchWorktreeQuickPick[]
): SwitchWorktreeQuickPick[] {
	return picks.filter(pick => pick.isLoaded);
}

export function getVisualProjectWorktreeTargets(
	projects: readonly ProjectRecord[]
): IProjectSwitcherSelectionTarget[] {
	const pinnedTargets: IProjectSwitcherSelectionTarget[] = [];
	const unpinnedTargets: IProjectSwitcherSelectionTarget[] = [];

	for (const project of projects) {
		if (project.pinned) {
			pinnedTargets.push(
				...getProjectWorktreeTargets(project, project.worktrees)
			);
			continue;
		}

		pinnedTargets.push(
			...getProjectWorktreeTargets(
				project,
				project.worktrees.filter(worktree => worktree.pinned)
			)
		);
		unpinnedTargets.push(
			...getProjectWorktreeTargets(
				project,
				project.worktrees.filter(worktree => !worktree.pinned)
			)
		);
	}

	return [...pinnedTargets, ...unpinnedTargets];
}

export function getLoadedProjectWorktreeTargets(
	targets: readonly IProjectSwitcherSelectionTarget[],
	loadedWorktreePaths: readonly string[],
	pathsEqual: (pathA: string, pathB: string) => boolean
): IProjectSwitcherSelectionTarget[] {
	return targets.filter(target =>
		loadedWorktreePaths.some(loadedWorktreePath =>
			pathsEqual(target.worktreePath, loadedWorktreePath)
		)
	);
}

export function getAdjacentProjectWorktreeTarget(
	targets: readonly IProjectSwitcherSelectionTarget[],
	activeWorktreePath: string | undefined,
	direction: -1 | 1,
	pathsEqual: (pathA: string, pathB: string) => boolean
): IProjectSwitcherSelectionTarget | undefined {
	if (!targets.length) {
		return undefined;
	}

	const activeIndex = activeWorktreePath === undefined
		? -1
		: targets.findIndex(target =>
			pathsEqual(target.worktreePath, activeWorktreePath)
		);
	if (activeIndex < 0) {
		return direction > 0 ? targets[0] : targets[targets.length - 1];
	}

	const targetIndex = (activeIndex + direction + targets.length) %
		targets.length;
	return targets[targetIndex];
}

function getProjectWorktreeTargets(
	project: ProjectRecord,
	worktrees: readonly WorktreeRecord[]
): IProjectSwitcherSelectionTarget[] {
	return worktrees.map(worktree => ({
		projectId: project.id,
		worktreePath: worktree.path,
	}));
}

function getSwitchWorktreeHighlights(
	pick: SwitchWorktreeQuickPick,
	tokens: readonly string[]
): IQuickPickItemHighlights | undefined {
	const highlights: IQuickPickItemHighlights = {};
	for (const token of tokens) {
		let didMatchToken = false;
		for (const field of pick.searchFields) {
			const matches = matchesFuzzyIconAware(
				token,
				parseLabelWithIcons(field.text)
			);
			if (!matches) {
				continue;
			}

			didMatchToken = true;
			highlights[field.target] = mergeMatches(
				highlights[field.target],
				matches
			);
		}

		if (!didMatchToken) {
			return undefined;
		}
	}

	return highlights;
}

function mergeMatches(
	existing: readonly IMatch[] | undefined,
	next: readonly IMatch[]
): IMatch[] {
	const matches = [...existing ?? [], ...next].sort((a, b) =>
		a.start - b.start || a.end - b.end
	);
	const merged: IMatch[] = [];
	for (const match of matches) {
		const previous = merged[merged.length - 1];
		if (previous && match.start <= previous.end) {
			previous.end = Math.max(previous.end, match.end);
		} else {
			merged.push({ start: match.start, end: match.end });
		}
	}

	return merged;
}
