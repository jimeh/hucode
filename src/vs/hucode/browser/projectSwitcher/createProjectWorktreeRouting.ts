/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IHucodeShellControllerService } from
	'../../../platform/window/common/hucodeShellControllerService.js';
import { CREATE_WORKTREE_COMMAND_ID } from './projectSwitcherCommon.js';

/**
 * Forwards Create Worktree from native Omni to its hosted workbench. Web Omni
 * keeps the interactive flow in the shell because hosted command forwarding
 * has a bounded response timeout.
 */
export async function tryForwardShellCreateWorktreeCommand(
	routing: {
		readonly isOmniWindow: boolean;
		readonly isWebClient: boolean;
	},
	shellService: Pick<IHucodeShellControllerService, 'runActionInWorkspace'>,
	handle?: unknown
): Promise<boolean> {
	if (!routing.isOmniWindow || routing.isWebClient) {
		return false;
	}

	return shellService.runActionInWorkspace({
		id: CREATE_WORKTREE_COMMAND_ID,
		from: 'mouse',
		args: handle !== undefined ? [handle] : undefined,
	});
}
