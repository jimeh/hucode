/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
	IHucodeShellService,
} from '../common/omniWindow.js';
import { IProjectSwitcherSelectionTarget } from
	'../common/projectSwitcher/switchProjectWorktreeModel.js';
import { setLastActiveWorktreeBestEffort } from
	'./projectSwitcher/openProjectSwitcherTarget.js';

/**
 * Opens a selected worktree target inside an Omni hosted workspace.
 */
export async function openSelectionInOmniWindow(
	selection: IProjectSwitcherSelectionTarget | undefined,
	windowId: number,
	shellService: IHucodeShellService,
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
		windowId,
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
	shellService: IHucodeShellService,
	projectManagerService: IProjectManagerService,
	notificationService: INotificationService,
	noSelectionMessage: string,
	retainedWorkbench?: {
		readonly windowId: number;
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
	if (retainedWorkbench) {
		const state = await shellService.unloadRetainedWorkbench(
			retainedWorkbench.windowId,
			retainedWorkbench.id
		);
		const retained = state.retainedWorkbenches?.find(record =>
			record.id === retainedWorkbench.id
		);
		if (retained?.desiredState !== 'unloaded') {
			return;
		}
	}

	const owner = await shellService.findHostedWorkspaceByPath(
		selection.worktreePath
	);
	if (owner) {
		const state = await shellService.closeWorkspace(
			owner.windowId,
			owner.instanceId
		);
		const closed = !state.instances.some(instance =>
			instance.instanceId === owner.instanceId
		);
		if (!closed) {
			return;
		}
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
