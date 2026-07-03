/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Hucode-specific configuration injected into server-web workbench pages.
 */
export interface IHucodeWebWorkbenchConfiguration {
	readonly hucodeOmniShell?: boolean;
	readonly hucodeHostedOmniWorkbench?: boolean;
	readonly hucodeOmniWorkbenchRoute?: string;
	readonly hucodeOmniHostedWorkbenchRoute?: string;
	readonly hucodeOmniProjectsApi?: string;
	readonly hucodeServerPathCaseSensitive?: boolean;
}

/**
 * Returns whether a server-web workbench should boot the Omni shell.
 */
export function isHucodeOmniWebConfiguration(
	config: object | undefined
): config is IHucodeWebWorkbenchConfiguration {
	return (config as IHucodeWebWorkbenchConfiguration | undefined)
		?.hucodeOmniShell === true;
}

/**
 * Returns whether a server-web workbench is hosted inside the Omni shell.
 */
export function isHucodeHostedOmniWebConfiguration(
	config: object | undefined
): config is IHucodeWebWorkbenchConfiguration {
	return (config as IHucodeWebWorkbenchConfiguration | undefined)
		?.hucodeHostedOmniWorkbench === true;
}

/**
 * Returns the configured Projects API endpoint for the Omni web shell.
 */
export function getHucodeOmniProjectsApi(
	config: object | undefined
): string {
	return (config as IHucodeWebWorkbenchConfiguration | undefined)
		?.hucodeOmniProjectsApi ?? '/_hucode/projects';
}

/**
 * Returns the configured regular workbench route for Omni web clients.
 */
export function getHucodeOmniWorkbenchRoute(
	config: object | undefined
): string {
	return (config as IHucodeWebWorkbenchConfiguration | undefined)
		?.hucodeOmniWorkbenchRoute ?? '/workbench';
}

/**
 * Returns the configured workbench route for hosted iframe workbenches.
 */
export function getHucodeOmniHostedWorkbenchRoute(
	config: object | undefined
): string {
	return (config as IHucodeWebWorkbenchConfiguration | undefined)
		?.hucodeOmniHostedWorkbenchRoute ?? '/omni/workbench';
}

/**
 * Returns whether paths should be compared using server filesystem semantics.
 */
export function getHucodeServerPathCaseSensitive(
	config: object | undefined
): boolean {
	return (config as IHucodeWebWorkbenchConfiguration | undefined)
		?.hucodeServerPathCaseSensitive ?? false;
}
