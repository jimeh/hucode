/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse } from '../../../base/common/marshalling.js';
import { isHucodeOmniWebConfiguration } from
	'../../../platform/environment/common/hucodeWebConfiguration.js';
import type { IWorkbenchConstructionOptions } from
	'../../../workbench/browser/web.api.js';

type CreateWorkbench = typeof import(
	'../../../workbench/workbench.web.main.internal.js'
).create;

/**
 * Returns the workbench entrypoint that should boot for a Hucode web page.
 */
export async function resolveHucodeWebWorkbenchCreate(
	config: IWorkbenchConstructionOptions,
	locationHref: string,
	defaultCreate: CreateWorkbench
): Promise<CreateWorkbench> {
	if (isHucodeOmniWebConfiguration(config)) {
		return (await import('../../../hucode/browser/omni.web.main.js')).create;
	}

	if (isHucodeHostedOmniWebPayload(locationHref)) {
		return (await import('../../../hucode/browser/hostedOmniWeb.main.js')).create;
	}

	return defaultCreate;
}

/**
 * Returns whether the current workbench URL carries a hosted Omni payload.
 */
export function isHucodeHostedOmniWebPayload(locationHref: string): boolean {
	const payload = new URL(locationHref).searchParams.get('payload');
	if (!payload) {
		return false;
	}

	try {
		const value = parse(payload);
		return Array.isArray(value) &&
			value.some(entry =>
				Array.isArray(entry) &&
				entry[0] === 'isHostedOmniWorkspace' &&
				entry[1] === 'true'
			);
	} catch {
		return false;
	}
}
