/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../platform/instantiation/common/instantiation.js';
import { IHucodeShellService } from '../common/omniWindow.js';

export const IHucodeShellMainService = refineServiceDecorator<
	IHucodeShellService,
	IHucodeShellMainService
>(IHucodeShellService);

/**
 * Main-process Omni-window lifecycle and hosted-workspace service.
 */
export interface IHucodeShellMainService extends IHucodeShellService {
	/**
	 * Returns whether a request came from a trusted Omni hosted-workspace
	 * renderer.
	 */
	isTrustedHostedWorkspaceRequest(
		processId: number,
		webContentsId?: number
	): boolean;
}
