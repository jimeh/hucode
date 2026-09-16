/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { UriComponents } from '../../../base/common/uri.js';

export type HucodeWebUserDataStorage = 'browser' | 'server';

/**
 * Hucode-specific configuration injected into server-web workbench pages.
 *
 * `webviewEndpoint` is the upstream workbench option of the same name: it
 * points webviews at the server's own static route so self-hosted deployments
 * never load webview bootstrap assets from the upstream public CDN.
 */
export interface IHucodeWebWorkbenchConfiguration {
	readonly hucodeOmniShell?: boolean;
	readonly hucodeHostedOmniWorkbench?: boolean;
	readonly hucodeOmniWorkbenchRoute?: string;
	readonly hucodeOmniHostedWorkbenchRoute?: string;
	readonly hucodeOmniProjectsApi?: string;
	readonly hucodeServerPathCaseSensitive?: boolean;
	readonly hucodeWebUserDataStorage?: HucodeWebUserDataStorage;
	readonly hucodeWebUserDataApi?: string;
	readonly hucodeWebUserDataHome?: UriComponents;
	readonly webviewEndpoint?: string;
}

/**
 * Returns the trusted serve-web user-data mode injected by the server.
 */
export function getHucodeWebUserDataStorage(
	config: object | undefined
): HucodeWebUserDataStorage {
	return (config as IHucodeWebWorkbenchConfiguration | undefined)
		?.hucodeWebUserDataStorage === 'server' ? 'server' : 'browser';
}

/**
 * Returns whether the server selected server-authoritative web user data.
 */
export function isHucodeServerUserDataConfiguration(
	config: object | undefined
): config is IHucodeWebWorkbenchConfiguration {
	return getHucodeWebUserDataStorage(config) === 'server';
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
