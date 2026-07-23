/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../base/browser/window.js';
import {
	isHucodeHostedOmniWebConfiguration,
	isHucodeOmniWebConfiguration,
} from '../../../platform/environment/common/hucodeWebConfiguration.js';
import type { IWorkbenchConstructionOptions } from
	'../../../workbench/browser/web.api.js';

type CreateWorkbench = typeof import(
	'../../../workbench/workbench.web.main.internal.js'
).create;

/**
 * Returns the workbench entrypoint that should boot for a Hucode web page.
 *
 * The server injects the Omni shell and hosted-workbench markers into the
 * workbench configuration per route, so regular workbench pages never load
 * the Hucode Omni modules. Every entrypoint boots with Hucode-normalized
 * workbench options.
 */
export async function resolveHucodeWebWorkbenchCreate(
	config: IWorkbenchConstructionOptions,
	defaultCreate: CreateWorkbench
): Promise<CreateWorkbench> {
	const create = await resolveCreate(config, defaultCreate);
	return (domElement, options) => create(
		domElement,
		toHucodeWebWorkbenchOptions(options, mainWindow.location.href)
	);
}

async function resolveCreate(
	config: IWorkbenchConstructionOptions,
	defaultCreate: CreateWorkbench
): Promise<CreateWorkbench> {
	if (isHucodeOmniWebConfiguration(config)) {
		return (await import('../../../hucode/browser/omni.web.main.js')).create;
	}

	if (isHucodeHostedOmniWebConfiguration(config)) {
		return (await import('../../../hucode/browser/hostedOmniWeb.main.js')).create;
	}

	return defaultCreate;
}

/**
 * Normalizes server-injected workbench options for a Hucode web page.
 *
 * The server sends `webviewEndpoint` as a server-relative path because it
 * cannot reliably know its public scheme and host behind proxies, but the
 * webview element derives its message-origin check from the endpoint URL, so
 * a relative endpoint silently breaks the webview handshake. Resolve it
 * against the page location before the workbench boots.
 */
export function toHucodeWebWorkbenchOptions(
	options: IWorkbenchConstructionOptions,
	locationHref: string
): IWorkbenchConstructionOptions {
	if (!options.webviewEndpoint || !options.webviewEndpoint.startsWith('/')) {
		return options;
	}

	return {
		...options,
		webviewEndpoint:
			new URL(options.webviewEndpoint, locationHref).toString(),
	};
}
