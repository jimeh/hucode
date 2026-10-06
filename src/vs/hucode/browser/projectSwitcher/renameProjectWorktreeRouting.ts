/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IHucodeShellControllerService } from
	'../../../platform/window/common/hucodeShellControllerService.js';

/**
 * Forwards a rename command from native Omni to its hosted workbench. Web Omni
 * keeps interactive rename commands in the shell because hosted command
 * forwarding has a bounded response timeout.
 */
export async function tryForwardShellRenameCommand(
	routing: {
		readonly isOmniWindow: boolean;
		readonly isWebClient: boolean;
	},
	shellService: Pick<IHucodeShellControllerService, 'runActionInWorkspace'>,
	commandId: string,
	handle?: unknown
): Promise<boolean> {
	if (!routing.isOmniWindow || routing.isWebClient) {
		return false;
	}

	return shellService.runActionInWorkspace({
		id: commandId,
		from: 'mouse',
		args: handle !== undefined ? [handle] : undefined,
	});
}
