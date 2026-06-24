/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Hucode-specific configuration injected into server-web workbench pages.
 */
export interface IHucodeWebWorkbenchConfiguration {
	readonly hucodeOmniShell?: boolean;
	readonly hucodeOmniWorkbenchRoute?: string;
	readonly hucodeOmniProjectsApi?: string;
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
 * Returns the configured Projects API endpoint for the Omni web shell.
 */
export function getHucodeOmniProjectsApi(
	config: object | undefined
): string {
	return (config as IHucodeWebWorkbenchConfiguration | undefined)
		?.hucodeOmniProjectsApi ?? '/_hucode/projects';
}

/**
 * Returns the configured workbench route for hosted iframe workbenches.
 */
export function getHucodeOmniWorkbenchRoute(
	config: object | undefined
): string {
	return (config as IHucodeWebWorkbenchConfiguration | undefined)
		?.hucodeOmniWorkbenchRoute ?? '/workbench';
}
