/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { INativeWorkbenchEnvironmentService } from '../services/environment/electron-browser/environmentService.js';

const HUCODE_SHELL_CHANNEL_NAME = 'hucodeShell';

export async function hucodeToggleHostedWorkspaceDevTools(
	accessor: ServicesAccessor,
	windowId: number
): Promise<boolean> {
	const environmentService = accessor.get(INativeWorkbenchEnvironmentService);
	if (!environmentService.isHostedOmniWorkspace) {
		return false;
	}

	return accessor.get(IMainProcessService)
		.getChannel(HUCODE_SHELL_CHANNEL_NAME)
		.call<boolean>('toggleWorkspaceDevTools', [windowId]);
}
