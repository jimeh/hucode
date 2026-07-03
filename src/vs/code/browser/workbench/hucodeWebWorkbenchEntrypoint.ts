/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
 * the Hucode Omni modules.
 */
export async function resolveHucodeWebWorkbenchCreate(
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
