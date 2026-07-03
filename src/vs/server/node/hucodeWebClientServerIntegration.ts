/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as url from 'url';
import type { IncomingHttpHeaders } from 'http';
import type { IProductConfiguration } from
	'../../base/common/product.js';
import type { Mutable } from
	'../../base/common/types.js';
import type { IHucodeWebWorkbenchConfiguration } from
	'../../platform/environment/common/hucodeWebConfiguration.js';
import type { IProductService } from
	'../../platform/product/common/productService.js';
import {
	getHucodeWebClientRoute,
	HUCODE_WEB_OMNI_ROOT_ARG,
	HUCODE_WEB_OMNI_PATH,
	HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH,
	HUCODE_WEB_WORKBENCH_PATH,
	toHucodeWebRouteLocation,
} from './hucodeWebOmniRoutes.js';
import {
	getHucodeWebOmniHostedWorkbenchBase,
	getHucodeWebOmniProjectsApi,
	getHucodeWebOmniWorkbenchBase,
} from './hucodeWebOmniShell.js';

export { HUCODE_WEB_OMNI_ROOT_ARG, toHucodeWebRouteLocation };

export type HucodeWebWorkbenchRoutePath =
	| '/'
	| typeof HUCODE_WEB_OMNI_PATH
	| typeof HUCODE_WEB_WORKBENCH_PATH
	| typeof HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH;

/**
 * Hucode-specific options for a served workbench document.
 */
export interface IHucodeWebWorkbenchRouteOptions {
	readonly hucodeOmniShell?: boolean;
	readonly hucodeHostedOmniWorkbench?: boolean;
}

export type HucodeWebClientRouteAction =
	| ({
		readonly type: 'workbench';
		readonly routePath: HucodeWebWorkbenchRoutePath;
	} & IHucodeWebWorkbenchRouteOptions)
	| { readonly type: 'redirect'; readonly location: string }
	| { readonly type: 'notFound' };

/**
 * Resolves the client-visible base path for Hucode serve-web routes.
 */
export function getHucodeWebClientBasePath(
	headers: IncomingHttpHeaders,
	defaultBasePath: string
): string {
	const forwardedPrefix = headers['x-forwarded-prefix'];
	return (Array.isArray(forwardedPrefix)
		? forwardedPrefix[0]
		: forwardedPrefix) || defaultBasePath;
}

/**
 * Resolves Hucode-specific server-web routing into a server action.
 */
export function getHucodeWebClientRouteAction(
	pathname: string,
	options: {
		readonly basePath: string;
		readonly query: url.UrlWithParsedQuery['query'];
		readonly omniEnabled: boolean;
	}
): HucodeWebClientRouteAction {
	const route = getHucodeWebClientRoute(pathname, options.omniEnabled);
	switch (route.type) {
		case 'workbench':
			return { type: 'workbench', routePath: route.routePath };
		case 'omni':
			return {
				type: 'workbench',
				routePath: route.routePath,
				hucodeOmniShell: true,
			};
		case 'hostedWorkbench':
			return {
				type: 'workbench',
				routePath: route.routePath,
				hucodeHostedOmniWorkbench: true,
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
	routeOptions: IHucodeWebWorkbenchRouteOptions,
	env: { readonly serverPathCaseSensitive: boolean }
): IHucodeWebWorkbenchConfiguration {
	return {
		hucodeOmniShell: routeOptions.hucodeOmniShell,
		hucodeHostedOmniWorkbench: routeOptions.hucodeHostedOmniWorkbench,
		hucodeOmniWorkbenchRoute: getHucodeWebOmniWorkbenchBase(basePath),
		hucodeOmniHostedWorkbenchRoute:
			getHucodeWebOmniHostedWorkbenchBase(basePath),
		hucodeOmniProjectsApi: getHucodeWebOmniProjectsApi(basePath),
		hucodeServerPathCaseSensitive: env.serverPathCaseSensitive,
	};
}

/**
 * Builds Hucode-specific product configuration required by serve-web clients.
 */
export function getHucodeWebProductConfiguration(
	productService: IProductService
): Partial<Mutable<IProductConfiguration>> {
	return {
		quality: productService.quality,
		commit: productService.commit,
	};
}
