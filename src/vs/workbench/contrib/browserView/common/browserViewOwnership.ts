/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IBrowserViewOwner } from '../../../../platform/browserView/common/browserView.js';
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
 * Creates the owner identity used to register a browser view.
 *
 * @param mainWindowId Main window that hosts the browser view.
 * @param environmentService Browser view ownership environment state.
 * @returns Owner identity for normal or hosted workbench browser views.
 */
export function getBrowserViewOwner(
	mainWindowId: number,
	environmentService: BrowserViewEnvironment
): IBrowserViewOwner {
	return {
		mainWindowId,
		hostedWebContentsId:
			getHostedBrowserViewWebContentsId(environmentService),
	};
}

/**
 * Checks whether a registered browser view belongs to the active workbench.
 *
 * @param owner Owner identity stored with the browser view.
 * @param mainWindowId Main window currently asking for the browser view.
 * @param environmentService Browser view ownership environment state.
 * @returns Whether the browser view is owned by the current workbench.
 */
export function ownsBrowserView(
	owner: IBrowserViewOwner,
	mainWindowId: number,
	environmentService: BrowserViewEnvironment
): boolean {
	if (owner.mainWindowId !== mainWindowId) {
		return false;
	}

	const hostedWebContentsId =
		getHostedBrowserViewWebContentsId(environmentService);
	if (typeof hostedWebContentsId === 'number') {
		return owner.hostedWebContentsId === hostedWebContentsId;
	}

	return owner.hostedWebContentsId === undefined;
}
