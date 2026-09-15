/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import { IHucodeShellService } from '../common/omniWindow.js';
import { ICodeWindow } from '../../platform/window/electron-main/window.js';
import { IUserDataProfile } from '../../platform/userDataProfile/common/userDataProfile.js';
import { INativeOpenFileRequest } from '../../platform/window/common/window.js';
import {
	type HucodeRegularWorkbenchAdmissionOutcome,
	type HucodeRegularWorkbenchOpenAttempt,
} from './desktopWorkbenchOwnership.js';

export const IHucodeShellMainService = createDecorator<IHucodeShellMainService>(
	'hucodeShellMainService'
);

/**
 * Main-process Omni-window lifecycle and hosted-workspace service.
 */
export interface IHucodeShellMainService extends IHucodeShellService {
	/** Returns the profile of the active hosted workbench, if one is loaded. */
	getActiveHostedWorkspaceProfile(windowId: number): IUserDataProfile | undefined;
	/** Serializes a regular desktop open against hosted and regular owners. */
	openRegularWorkbenchWithAdmission(
		workbenchPath: string,
		request: {
			readonly filesToOpen?: INativeOpenFileRequest;
			readonly forceStandalone?: boolean;
			openRegularWindow(): Promise<
				HucodeRegularWorkbenchOpenAttempt<ICodeWindow>
			>;
		}
	): Promise<HucodeRegularWorkbenchAdmissionOutcome<ICodeWindow>>;
	/**
	 * Returns whether a request came from a trusted Omni hosted-workspace
	 * renderer.
	 */
	isTrustedHostedWorkspaceRequest(
		processId: number,
		webContentsId?: number
	): boolean;
}
