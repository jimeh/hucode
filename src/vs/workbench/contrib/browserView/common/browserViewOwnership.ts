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

export function getHostedBrowserViewWebContentsId(
	environmentService: BrowserViewEnvironment
): number | undefined {
	return environmentService.isHostedOmniWorkspace
		? environmentService.hostedWebContentsId
		: undefined;
}

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
