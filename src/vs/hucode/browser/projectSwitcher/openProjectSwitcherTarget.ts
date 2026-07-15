/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from
	'../../../base/common/errors.js';
import { URI } from '../../../base/common/uri.js';
import { IProjectManagerService } from
	'../../../platform/projectManager/common/projectManager.js';
import { IHostService } from
	'../../../workbench/services/host/browser/host.js';
import { IWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/common/environmentService.js';
import { IHucodeShellService } from '../../common/omniWindow.js';
import { focusWorkspaceBestEffort } from
	'../../common/omniWindowFocus.js';
import { IProjectSwitcherSelectionTarget } from
	'../../common/projectSwitcher/switchProjectWorktreeModel.js';

/**
 * Opens a project switcher target in the current workbench context.
 */
export async function openProjectSwitcherTargetInWindow(
	target: IProjectSwitcherSelectionTarget,
	windowId: number,
	projectManagerService: IProjectManagerService,
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeShellService,
	hostService: IHostService
): Promise<void> {
	await setLastActiveWorktreeBestEffort(
		projectManagerService,
		target.projectId,
		target.worktreePath
	);

	if (
		environmentService.isOmniWindow ||
		environmentService.isHostedOmniWorkspace
	) {
		if (await focusNormalWindowByPathBestEffort(
			shellService,
			target.worktreePath
		)) {
			return;
		}

		await shellService.openWorkspace(
			windowId,
			target.worktreePath,
			target.projectId
		);
		await focusWorkspaceBestEffort(shellService, windowId);
		return;
	}

	await hostService.openWindow(
		[{ folderUri: URI.file(target.worktreePath) }],
		{ forceReuseWindow: true }
	);
}

async function focusNormalWindowByPathBestEffort(
	shellService: IHucodeShellService,
	worktreePath: string
): Promise<boolean> {
	try {
		return await shellService.focusNormalWindowByPath(worktreePath);
	} catch (error) {
		onUnexpectedError(error);
		return false;
	}
}

/**
 * Persists the worktree target without blocking the caller's open request.
 */
export async function setLastActiveWorktreeBestEffort(
	projectManagerService: IProjectManagerService,
	projectId: string,
	worktreePath: string
): Promise<void> {
	try {
		await projectManagerService.setLastActiveWorktree(
			projectId,
			worktreePath
		);
	} catch (error) {
		onUnexpectedError(error);
	}
}
