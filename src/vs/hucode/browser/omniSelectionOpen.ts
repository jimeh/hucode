/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../base/common/errors.js';
import { URI } from '../../base/common/uri.js';
import { INotificationService } from
	'../../platform/notification/common/notification.js';
import { IProjectManagerService } from
	'../../platform/projectManager/common/projectManager.js';
import { IHostService } from '../../workbench/services/host/browser/host.js';
import {
	IHucodeHostedWorkspaceState,
} from '../common/omniWindow.js';
import { IHucodeShellControllerService } from
	'../../platform/window/common/hucodeShellControllerService.js';
import { IProjectSwitcherSelectionTarget } from
	'../common/projectSwitcher/switchProjectWorktreeModel.js';
import { setLastActiveWorktreeBestEffort } from
	'./projectSwitcher/openProjectSwitcherTarget.js';

/**
 * Opens a selected worktree target inside an Omni hosted workspace.
 */
export async function openSelectionInOmniWindow(
	selection: IProjectSwitcherSelectionTarget | undefined,
	shellService: IHucodeShellControllerService,
	projectManagerService: IProjectManagerService,
	notificationService: INotificationService,
	noSelectionMessage: string
): Promise<IHucodeHostedWorkspaceState | undefined> {
	if (!selection) {
		notificationService.info(noSelectionMessage);
		return undefined;
	}

	await setLastActiveWorktreeBestEffort(
		projectManagerService,
		selection.projectId,
		selection.worktreePath
	);

	if (await focusNormalWindowByPathBestEffort(
		shellService,
		selection.worktreePath
	)) {
		return undefined;
	}

	return shellService.openWorkspace(
		selection.worktreePath,
		selection.projectId
	);
}

/**
 * Opens a selected worktree target in a standalone workbench window.
 */
export async function openSelectionInStandaloneWindow(
	selection: IProjectSwitcherSelectionTarget | undefined,
	hostService: IHostService,
	shellService: IHucodeShellControllerService,
	projectManagerService: IProjectManagerService,
	notificationService: INotificationService,
	noSelectionMessage: string,
	retainedWorkbench?: {
		readonly id: string;
	}
): Promise<void> {
	if (!selection) {
		notificationService.info(noSelectionMessage);
		return;
	}

	await setLastActiveWorktreeBestEffort(
		projectManagerService,
		selection.projectId,
		selection.worktreePath
	);
	if (!await shellService.prepareWorkspaceForStandaloneOpen({
		folderUri: URI.file(selection.worktreePath).toJSON(),
		retainedWorkbenchId: retainedWorkbench?.id,
	})) {
		return;
	}

	if (await focusNormalWindowByPathBestEffort(
		shellService,
		selection.worktreePath
	)) {
		return;
	}

	await hostService.openWindow(
		[{ folderUri: URI.file(selection.worktreePath) }],
		{ forceNewWindow: true }
	);
}

async function focusNormalWindowByPathBestEffort(
	shellService: IHucodeShellControllerService,
	worktreePath: string
): Promise<boolean> {
	try {
		return await shellService.focusNormalWindowByPath(worktreePath);
	} catch (error) {
		onUnexpectedError(error);
		return false;
	}
}
