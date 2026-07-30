/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
import {
	DEFAULT_PROJECT_SWITCHER_OMNI_SECTION_ORDER,
	ProjectSwitcherOmniSection,
} from './projectSwitcherViewState.js';

export interface IProjectSwitcherSelectionTarget {
	readonly projectId?: string;
	readonly worktreePath: string;
}

/** Timestamped project or arbitrary-workbench navigation target. */
export interface IProjectSwitcherNavigationHistoryEntry
	extends IProjectSwitcherSelectionTarget {
	readonly lastVisitedAt: number;
}

/** Globally orders history and keeps the most recent equivalent target. */
export function sortProjectSwitcherNavigationHistory(
	entries: readonly IProjectSwitcherNavigationHistoryEntry[],
	targetsEqual: (
		a: IProjectSwitcherSelectionTarget,
		b: IProjectSwitcherSelectionTarget
	) => boolean = (a, b) => a.projectId === b.projectId &&
		a.worktreePath === b.worktreePath
): IProjectSwitcherSelectionTarget[] {
	const sorted = [...entries]
		.sort((a, b) => a.lastVisitedAt - b.lastVisitedAt);
	return sorted
		.filter((entry, index) => !sorted.slice(index + 1).some(candidate =>
			targetsEqual(entry, candidate)
		))
		.map(({ projectId, worktreePath }) => ({ projectId, worktreePath }));
}

/** Searchable quick-pick text with an optional visible highlight target. */
export type SwitchWorktreeSearchField = {
	readonly target?: keyof IQuickPickItemHighlights;
	readonly text: string;
};

export type SwitchWorktreeQuickPick = IQuickPickItem &
	IProjectSwitcherSelectionTarget & {
		readonly isCurrent: boolean;
		readonly isLoaded: boolean;
		readonly isDormant?: boolean;
		readonly lastVisitedAt?: number;
		readonly logicalOrder: number;
		readonly projectOrder: number;
		readonly worktreeOrder: number;
		readonly searchFields: readonly SwitchWorktreeSearchField[];
	};

/** Builds two-line text and search fields for a retained-workbench pick. */
export function getRetainedWorkbenchQuickPickPresentation(
	label: string,
	pathLabel: string,
	path: string
): Pick<
	SwitchWorktreeQuickPick,
	'label' | 'detail' | 'tooltip' | 'searchFields'
> {
	return {
		label,
		detail: pathLabel,
		tooltip: path,
		searchFields: [
			{ target: 'label', text: label },
			{ target: 'detail', text: pathLabel },
			...(pathLabel === path ? [] : [{ text: path }]),
		],
	};
}

/** Returns the most recently visited non-current workbench, if any. */
export function getLastActiveSwitchWorkbenchPick(
	picks: readonly SwitchWorktreeQuickPick[]
): SwitchWorktreeQuickPick | undefined {
	return [...picks]
		.filter(candidate =>
			!candidate.isCurrent &&
			candidate.lastVisitedAt !== undefined
		)
		.sort((a, b) =>
			(b.lastVisitedAt ?? 0) - (a.lastVisitedAt ?? 0)
		)[0];
}

/** Orders lifecycle-grouped quick-pick rows by MRU, then logical order. */
export function compareSwitchWorktreePicks(
	a: SwitchWorktreeQuickPick,
	b: SwitchWorktreeQuickPick,
	sectionOrder?: readonly ProjectSwitcherOmniSection[]
): number {
	const sectionRank = (pick: SwitchWorktreeQuickPick) => {
		const rank = sectionOrder?.indexOf(
			pick.projectId ? 'projects' : 'workbenches'
		);
		return rank === undefined || rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
	};
	return Number(b.isCurrent) - Number(a.isCurrent) ||
		Number(b.isLoaded) - Number(a.isLoaded) ||
		Number(!!b.isDormant) - Number(!!a.isDormant) ||
		(b.lastVisitedAt ?? 0) - (a.lastVisitedAt ?? 0) ||
		(sectionOrder ? sectionRank(a) - sectionRank(b) : 0) ||
		a.logicalOrder - b.logicalOrder ||
		a.projectOrder - b.projectOrder ||
		a.worktreeOrder - b.worktreeOrder ||
		a.label.localeCompare(b.label) ||
		a.worktreePath.localeCompare(b.worktreePath);
}

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
		!pick.isLoaded && !pick.isDormant && !pick.isCurrent
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

/**
 * Combines retained and project targets while keeping project ownership
 * authoritative for paths that have been promoted.
 */
export function combineProjectSwitcherTargets<
	T extends IProjectSwitcherSelectionTarget
>(
	retainedTargets: readonly T[],
	projectTargets: readonly T[],
	pathsEqual: (pathA: string, pathB: string) => boolean,
	sectionOrder: readonly ProjectSwitcherOmniSection[] =
		DEFAULT_PROJECT_SWITCHER_OMNI_SECTION_ORDER
): T[] {
	const retained = retainedTargets.filter(candidate =>
		!projectTargets.some(project =>
			pathsEqual(candidate.worktreePath, project.worktreePath)
		)
	);
	return sectionOrder[0] === 'projects'
		? [...projectTargets, ...retained]
		: [...retained, ...projectTargets];
}

/** Resolves a path-only target to its current project-owned identity. */
export function canonicalizeProjectSwitcherTarget(
	target: IProjectSwitcherSelectionTarget,
	projects: readonly ProjectRecord[],
	pathsEqual: (pathA: string, pathB: string) => boolean
): IProjectSwitcherSelectionTarget {
	for (const project of projects) {
		const worktree = project.worktrees.find(candidate =>
			pathsEqual(candidate.path, target.worktreePath)
		);
		if (worktree) {
			return { projectId: project.id, worktreePath: worktree.path };
		}
	}

	return target;
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
			if (field.target) {
				highlights[field.target] = mergeMatches(
					highlights[field.target],
					matches
				);
			}
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
