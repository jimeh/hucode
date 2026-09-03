/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IBrowserViewInfo } from '../../../../platform/browserView/common/browserView.js';
import type { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';

type BrowserViewEnvironment = Pick<
	IWorkbenchEnvironmentService,
	'isHostedOmniWorkspace' | 'hostedWebContentsId'
>;

/**
 * Returns the hosted workbench web contents ID that owns browser views.
 *
 * @param environmentService Browser view ownership environment state.
 * @returns The hosted web contents ID, or undefined for normal workbenches.
 */
export function getHostedBrowserViewWebContentsId(
	environmentService: BrowserViewEnvironment
): number | undefined {
	return environmentService.isHostedOmniWorkspace
		? environmentService.hostedWebContentsId
		: undefined;
}

/**
 * Checks whether a registered browser view belongs to the active workbench.
 *
 * @param info Lifecycle identity stored with the browser view.
 * @param mainWindowId Main window currently asking for the browser view.
 * @param environmentService Browser view ownership environment state.
 * @returns Whether the browser view is owned by the current workbench.
 */
export function ownsBrowserView(
	info: Pick<IBrowserViewInfo, 'hostWindowId' | 'hostedWebContentsId'>,
	mainWindowId: number,
	environmentService: BrowserViewEnvironment
): boolean {
	if (info.hostWindowId !== mainWindowId) {
		return false;
	}

	const hostedWebContentsId =
		getHostedBrowserViewWebContentsId(environmentService);
	if (typeof hostedWebContentsId === 'number') {
		return info.hostedWebContentsId === hostedWebContentsId;
	}

	return info.hostedWebContentsId === undefined;
}
