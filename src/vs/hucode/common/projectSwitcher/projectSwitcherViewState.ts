/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Current persisted Project Switcher view-state schema version. */
export const PROJECT_SWITCHER_VIEW_STATE_VERSION = 2;

/** Canonical Project Switcher expansion state. */
export interface IProjectSwitcherViewState {
	readonly version: typeof PROJECT_SWITCHER_VIEW_STATE_VERSION;
	readonly collapsedProjectIds: string[];
	readonly collapsedOmniSections: string[];
}

/** Parses current state and migrates the pre-section version 1 shape. */
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
			},
			migrated: true,
		};
	}
	if (value.version !== PROJECT_SWITCHER_VIEW_STATE_VERSION ||
		!Array.isArray(value.collapsedOmniSections) ||
		!value.collapsedOmniSections.every(id => typeof id === 'string')
	) {
		return undefined;
	}

	return {
		state: {
			version: PROJECT_SWITCHER_VIEW_STATE_VERSION,
			collapsedProjectIds: value.collapsedProjectIds,
			collapsedOmniSections: value.collapsedOmniSections,
		},
		migrated: false,
	};
}
