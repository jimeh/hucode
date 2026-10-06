/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { INativeWorkbenchEnvironmentService } from '../services/environment/electron-browser/environmentService.js';

export async function hucodeToggleHostedWorkspaceDevTools(
	accessor: ServicesAccessor,
	_windowId: number
): Promise<boolean> {
	const environmentService = accessor.get(INativeWorkbenchEnvironmentService);
	if (!environmentService.isHostedOmniWorkspace) {
		return false;
	}

	ipcRenderer.send('vscode:toggleDevTools');
	return true;
}
