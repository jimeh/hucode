/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Current persisted Project Switcher view-state schema version. */
export const PROJECT_SWITCHER_VIEW_STATE_VERSION = 3;

/** Persisted identifier for a top-level Omni Project Switcher section. */
export type ProjectSwitcherOmniSection = 'workbenches' | 'projects';

/** Default top-level Omni section order. */
export const DEFAULT_PROJECT_SWITCHER_OMNI_SECTION_ORDER:
	readonly ProjectSwitcherOmniSection[] = ['workbenches', 'projects'];

/** Canonical Project Switcher expansion state. */
export interface IProjectSwitcherViewState {
	readonly version: typeof PROJECT_SWITCHER_VIEW_STATE_VERSION;
	readonly collapsedProjectIds: string[];
	readonly collapsedOmniSections: string[];
	readonly omniSectionOrder: ProjectSwitcherOmniSection[];
}

/** Moves one Omni section to the position occupied by another section. */
export function reorderProjectSwitcherOmniSections(
	order: readonly ProjectSwitcherOmniSection[],
	source: ProjectSwitcherOmniSection,
	target: ProjectSwitcherOmniSection
): ProjectSwitcherOmniSection[] {
	if (source === target || !order.includes(source) || !order.includes(target)) {
		return [...order];
	}

	return order.map(section => section === source
		? target
		: section === target ? source : section);
}

/** Parses current state and migrates earlier schema versions. */
export function parseProjectSwitcherViewState(
	rawState: string | undefined
): { readonly state: IProjectSwitcherViewState; readonly migrated: boolean } |
	undefined {
	if (!rawState) {
		return undefined;
	}

	let value: {
		readonly version?: number;
		readonly collapsedProjectIds?: unknown;
		readonly collapsedOmniSections?: unknown;
		readonly omniSectionOrder?: unknown;
	} | null;
	try {
		value = JSON.parse(rawState);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object' ||
		!Array.isArray(value.collapsedProjectIds) ||
		!value.collapsedProjectIds.every(id => typeof id === 'string')
	) {
		return undefined;
	}
	if (value.version === 1) {
		return {
			state: {
				version: PROJECT_SWITCHER_VIEW_STATE_VERSION,
				collapsedProjectIds: value.collapsedProjectIds,
				collapsedOmniSections: [],
				omniSectionOrder: [
					...DEFAULT_PROJECT_SWITCHER_OMNI_SECTION_ORDER,
				],
			},
			migrated: true,
		};
	}
	if (value.version === 2) {
		if (!Array.isArray(value.collapsedOmniSections) ||
			!value.collapsedOmniSections.every(id => typeof id === 'string')
		) {
			return undefined;
		}
		return {
			state: {
				version: PROJECT_SWITCHER_VIEW_STATE_VERSION,
				collapsedProjectIds: value.collapsedProjectIds,
				collapsedOmniSections: value.collapsedOmniSections,
				omniSectionOrder: [
					...DEFAULT_PROJECT_SWITCHER_OMNI_SECTION_ORDER,
				],
			},
			migrated: true,
		};
	}
	if (value.version !== PROJECT_SWITCHER_VIEW_STATE_VERSION ||
		!Array.isArray(value.collapsedOmniSections) ||
		!value.collapsedOmniSections.every(id => typeof id === 'string') ||
		!isProjectSwitcherOmniSectionOrder(value.omniSectionOrder)
	) {
		return undefined;
	}

	return {
		state: {
			version: PROJECT_SWITCHER_VIEW_STATE_VERSION,
			collapsedProjectIds: value.collapsedProjectIds,
			collapsedOmniSections: value.collapsedOmniSections,
			omniSectionOrder: value.omniSectionOrder,
		},
		migrated: false,
	};
}

/** Checks that an IPC or persisted value contains both Omni sections once. */
export function isProjectSwitcherOmniSectionOrder(
	value: unknown
): value is ProjectSwitcherOmniSection[] {
	return Array.isArray(value) && value.length === 2 &&
		value[0] !== value[1] &&
		value.every(section => section === 'workbenches' || section === 'projects');
}
