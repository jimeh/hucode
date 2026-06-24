/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as url from 'url';
import { hasKey } from '../../base/common/types.js';
import {
	HUCODE_WEB_WORKBENCH_PATH,
	toHucodeWebRouteLocation,
} from './hucodeWebOmniRoutes.js';
import { HUCODE_WEB_PROJECTS_API_PATH } from
	'./hucodeWebProjectManagerServer.js';

const HUCODE_WEB_OMNI_INITIAL_INSTANCE_ID = 'initial';

/**
 * Builds the hosted workbench URL used by the Hucode Omni web shell.
 */
export function getHucodeWebOmniWorkbenchSrc(
	basePath: string,
	query: url.UrlWithParsedQuery['query'],
	instanceId: string = HUCODE_WEB_OMNI_INITIAL_INSTANCE_ID
): string {
	const nextQuery = { ...query };
	if (!hasKey(nextQuery, { folder: true }) &&
		!hasKey(nextQuery, { workspace: true }) &&
		!hasKey(nextQuery, { ew: true })) {
		nextQuery.ew = 'true';
	}
	nextQuery.payload = JSON.stringify([
		['isHostedOmniWorkspace', 'true'],
		['hostedInstanceId', instanceId],
	]);
	return toHucodeWebRouteLocation(
		basePath,
		HUCODE_WEB_WORKBENCH_PATH,
		nextQuery
	);
}

/**
 * Builds the canonical workbench route used by browser-hosted iframes.
 */
export function getHucodeWebOmniWorkbenchBase(basePath: string): string {
	return toHucodeWebRouteLocation(basePath, HUCODE_WEB_WORKBENCH_PATH, {});
}

/**
 * Builds the project API route used by the Hucode Omni web shell.
 */
export function getHucodeWebOmniProjectsApi(basePath: string): string {
	return toHucodeWebRouteLocation(basePath, HUCODE_WEB_PROJECTS_API_PATH, {});
}
