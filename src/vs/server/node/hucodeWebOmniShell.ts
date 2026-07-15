/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH,
	HUCODE_WEB_WORKBENCH_PATH,
	toHucodeWebRouteLocation,
} from './hucodeWebOmniRoutes.js';
import { HUCODE_WEB_PROJECTS_API_PATH } from
	'./hucodeWebProjectManagerServer.js';

/**
 * Builds the canonical regular workbench route for Omni web clients.
 */
export function getHucodeWebOmniWorkbenchBase(basePath: string): string {
	return toHucodeWebRouteLocation(basePath, HUCODE_WEB_WORKBENCH_PATH, {});
}

/**
 * Builds the hosted workbench route used by browser-hosted iframes.
 */
export function getHucodeWebOmniHostedWorkbenchBase(basePath: string): string {
	return toHucodeWebRouteLocation(
		basePath,
		HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH,
		{}
	);
}

/**
 * Builds the project API route used by the Hucode Omni web shell.
 */
export function getHucodeWebOmniProjectsApi(basePath: string): string {
	return toHucodeWebRouteLocation(basePath, HUCODE_WEB_PROJECTS_API_PATH, {});
}
