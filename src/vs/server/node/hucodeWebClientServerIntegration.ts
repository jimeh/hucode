/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as url from 'url';
import { IHucodeWebWorkbenchConfiguration } from
	'../../platform/environment/common/hucodeWebConfiguration.js';
import {
	getHucodeWebClientRoute,
	HUCODE_WEB_OMNI_ROOT_ARG,
	HUCODE_WEB_OMNI_PATH,
	HUCODE_WEB_WORKBENCH_PATH,
	toHucodeWebRouteLocation,
} from './hucodeWebOmniRoutes.js';
import {
	getHucodeWebOmniProjectsApi,
	getHucodeWebOmniWorkbenchBase,
} from './hucodeWebOmniShell.js';

export { HUCODE_WEB_OMNI_ROOT_ARG, toHucodeWebRouteLocation };

export type HucodeWebClientRouteAction =
	| {
		readonly type: 'workbench';
		readonly routePath:
		| '/'
		| typeof HUCODE_WEB_OMNI_PATH
		| typeof HUCODE_WEB_WORKBENCH_PATH;
		readonly hucodeOmniShell?: boolean;
	}
	| { readonly type: 'redirect'; readonly location: string }
	| { readonly type: 'notFound' };

/**
 * Resolves Hucode-specific server-web routing into a server action.
 */
export function getHucodeWebClientRouteAction(
	pathname: string,
	options: {
		readonly basePath: string;
		readonly query: url.UrlWithParsedQuery['query'];
		readonly omniRoot: boolean;
	}
): HucodeWebClientRouteAction {
	const route = getHucodeWebClientRoute(pathname, options.omniRoot);
	switch (route.type) {
		case 'workbench':
			return { type: 'workbench', routePath: route.routePath };
		case 'omni':
			return {
				type: 'workbench',
				routePath: route.routePath,
				hucodeOmniShell: true,
			};
		case 'redirect':
			return {
				type: 'redirect',
				location: toHucodeWebRouteLocation(
					options.basePath,
					route.locationPath,
					options.query
				),
			};
		case 'notFound':
			return { type: 'notFound' };
	}
}

/**
 * Builds Hucode-specific configuration injected into server-web workbenches.
 */
export function getHucodeWebWorkbenchConfiguration(
	basePath: string,
	options: {
		readonly hucodeOmniShell?: boolean;
		readonly serverPathCaseSensitive: boolean;
	}
): IHucodeWebWorkbenchConfiguration {
	return {
		hucodeOmniShell: options.hucodeOmniShell,
		hucodeOmniWorkbenchRoute: getHucodeWebOmniWorkbenchBase(basePath),
		hucodeOmniProjectsApi: getHucodeWebOmniProjectsApi(basePath),
		hucodeServerPathCaseSensitive: options.serverPathCaseSensitive,
	};
}
