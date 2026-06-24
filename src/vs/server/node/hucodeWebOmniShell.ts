/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as url from 'url';
import {
	HUCODE_WEB_WORKBENCH_PATH,
	toHucodeWebRouteLocation,
} from './hucodeWebOmniRoutes.js';

/**
 * Builds the hosted workbench URL used by the Hucode Omni web shell.
 */
export function getHucodeWebOmniWorkbenchSrc(
	basePath: string,
	query: url.UrlWithParsedQuery['query']
): string {
	return toHucodeWebRouteLocation(basePath, HUCODE_WEB_WORKBENCH_PATH, query);
}

/**
 * Renders the first-pass Hucode Omni web shell.
 */
export function renderHucodeWebOmniShell(workbenchSrc: string): string {
	const src = escapeAttribute(workbenchSrc);
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Hucode Omni</title>
	<style>
		html,
		body {
			width: 100%;
			height: 100%;
			margin: 0;
			overflow: hidden;
			background: #181818;
			color: #cccccc;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}

		.hucode-omni-shell {
			display: grid;
			grid-template-columns: 280px minmax(0, 1fr);
			width: 100%;
			height: 100%;
		}

		.hucode-omni-projects {
			box-sizing: border-box;
			border-right: 1px solid #2d2d2d;
			background: #202020;
			min-width: 0;
			padding: 16px;
		}

		.hucode-omni-title {
			margin: 0 0 16px;
			font-size: 13px;
			font-weight: 600;
			letter-spacing: 0;
			color: #f0f0f0;
		}

		.hucode-omni-empty {
			margin: 0;
			font-size: 12px;
			color: #8f8f8f;
		}

		.hucode-omni-host {
			position: relative;
			min-width: 0;
			min-height: 0;
			background: #1e1e1e;
		}

		.hucode-omni-workbench {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
			border: 0;
			background: #1e1e1e;
		}
	</style>
</head>
<body>
	<main class="hucode-omni-shell">
		<aside class="hucode-omni-projects" aria-label="Projects">
			<h1 class="hucode-omni-title">Projects</h1>
			<p class="hucode-omni-empty">No projects</p>
		</aside>
		<section class="hucode-omni-host" aria-label="Workbench">
			<iframe
				class="hucode-omni-workbench"
				title="Workbench"
				src="${src}"
			></iframe>
		</section>
	</main>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
	return value.replace(/[&"]/g, character =>
		character === '&' ? '&amp;' : '&quot;'
	);
}
