/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IHucodeShellService } from '../../common/omniWindow.js';

/**
 * Forwards a rename command from native Omni to its hosted workbench. Web Omni
 * keeps interactive rename commands in the shell because hosted command
 * forwarding has a bounded response timeout.
 */
export async function tryForwardShellRenameCommand(
	isOmniWindow: boolean,
	isWebClient: boolean,
	shellService: Pick<IHucodeShellService, 'runActionInWorkspace'>,
	windowId: number,
	commandId: string,
	handle?: unknown
): Promise<boolean> {
	if (!isOmniWindow || isWebClient) {
		return false;
	}

	return shellService.runActionInWorkspace(windowId, {
		id: commandId,
		from: 'mouse',
		args: handle !== undefined ? [handle] : undefined,
	});
}
