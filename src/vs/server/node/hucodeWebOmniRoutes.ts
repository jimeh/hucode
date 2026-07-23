/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as url from 'url';
import { posix } from '../../base/common/path.js';

export const HUCODE_WEB_OMNI_ROOT_ARG = 'hucode-web-omni-root';
export const HUCODE_WEB_OMNI_PATH = '/omni';
export const HUCODE_WEB_WORKBENCH_PATH = '/workbench';
export const HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH = '/omni/workbench';

export type HucodeWebClientRoute =
	| { readonly type: 'workbench'; readonly routePath: '/' | typeof HUCODE_WEB_WORKBENCH_PATH }
	| { readonly type: 'omni'; readonly routePath: '/' | typeof HUCODE_WEB_OMNI_PATH }
	| { readonly type: 'hostedWorkbench'; readonly routePath: typeof HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH }
	| { readonly type: 'redirect'; readonly locationPath: typeof HUCODE_WEB_OMNI_PATH | typeof HUCODE_WEB_WORKBENCH_PATH | typeof HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH }
	| { readonly type: 'notFound' };

/**
 * Selects the Hucode web route for server-web requests.
 *
 * All Hucode-specific routes are gated on the `--hucode-web-omni-root`
 * server argument. Without it, serve-web keeps upstream behavior: the
 * regular workbench at the root URL and nothing else.
 */
export function getHucodeWebClientRoute(
	pathname: string,
	omniEnabled: boolean
): HucodeWebClientRoute {
	if (!omniEnabled) {
		return pathname === '/'
			? { type: 'workbench', routePath: '/' }
			: { type: 'notFound' };
	}

	switch (pathname) {
		case '/':
			return { type: 'omni', routePath: '/' };
		case HUCODE_WEB_OMNI_PATH:
			return { type: 'omni', routePath: HUCODE_WEB_OMNI_PATH };
		case HUCODE_WEB_WORKBENCH_PATH:
			return { type: 'workbench', routePath: HUCODE_WEB_WORKBENCH_PATH };
		case HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH:
			return {
				type: 'hostedWorkbench',
				routePath: HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH,
			};
		case `${HUCODE_WEB_OMNI_PATH}/`:
			return { type: 'redirect', locationPath: HUCODE_WEB_OMNI_PATH };
		case `${HUCODE_WEB_WORKBENCH_PATH}/`:
			return { type: 'redirect', locationPath: HUCODE_WEB_WORKBENCH_PATH };
		case `${HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH}/`:
			return {
				type: 'redirect',
				locationPath: HUCODE_WEB_OMNI_HOSTED_WORKBENCH_PATH,
			};
		default:
			return { type: 'notFound' };
	}
}

/**
 * Builds a redirect location under the client-facing base path.
 */
export function toHucodeWebRouteLocation(
	basePath: string,
	routePath: string,
	query: url.UrlWithParsedQuery['query']
): string {
	const pathname = routePath === '/'
		? (basePath || '/')
		: posix.join(basePath || '/', routePath);
	return url.format({ pathname, query });
}
