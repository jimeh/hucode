/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
} from '../../../platform/window/common/hucodeHostedShellService.js';
import { IHucodeShellControllerService } from
	'../../../platform/window/common/hucodeShellControllerService.js';
import {
	canonicalizeProjectSwitcherTarget,
	IProjectSwitcherSelectionTarget,
} from
	'../../common/projectSwitcher/switchProjectWorktreeModel.js';
import { pathsEqual } from './projectSwitcherCommon.js';

/**
 * Opens a project switcher target in the current workbench context.
 */
export async function openProjectSwitcherTargetInWindow(
	target: IProjectSwitcherSelectionTarget,
	projectManagerService: IProjectManagerService,
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeShellControllerService | undefined,
	hostService: IHostService,
	hostedShellService?: IHucodeHostedShellService
): Promise<void> {
	let canonicalTarget = target;
	try {
		canonicalTarget = canonicalizeProjectSwitcherTarget(
			target,
			await projectManagerService.getProjects(),
			pathsEqual
		);
	} catch (error) {
		onUnexpectedError(error);
	}
	await setLastActiveWorktreeBestEffort(
		projectManagerService,
		canonicalTarget.projectId,
		canonicalTarget.worktreePath
	);

	if (environmentService.isHostedOmniWorkspace) {
		if (!hostedShellService) {
			throw new Error('Hosted shell capability is unavailable.');
		}
		const outcome = await hostedShellService.navigateToFolder({
			folderUri: URI.file(canonicalTarget.worktreePath).toJSON(),
		});
		if (outcome === HucodeHostedShellOperationOutcome.Unsupported) {
			throw new Error('Hosted folder navigation is unsupported.');
		}
		return;
	}

	if (environmentService.isOmniWindow) {
		if (!shellService) {
			throw new Error('Omni shell controller is unavailable.');
		}
		if (await focusNormalWindowByPathBestEffort(
			shellService,
			canonicalTarget.worktreePath
		)) {
			return;
		}

		await shellService.openWorkspace(
			canonicalTarget.worktreePath,
			canonicalTarget.projectId
		);
		await focusWorkspaceBestEffort(shellService);
		return;
	}

	await hostService.openWindow(
		[{ folderUri: URI.file(canonicalTarget.worktreePath) }],
		{ forceReuseWindow: true }
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

async function focusWorkspaceBestEffort(
	shellService: IHucodeShellControllerService
): Promise<void> {
	try {
		await shellService.focusWorkspace();
	} catch (error) {
		onUnexpectedError(error);
	}
}

/**
 * Persists the worktree target without blocking the caller's open request.
 */
export async function setLastActiveWorktreeBestEffort(
	projectManagerService: IProjectManagerService,
	projectId: string | undefined,
	worktreePath: string
): Promise<void> {
	if (!projectId) {
		return;
	}
	try {
		await projectManagerService.setLastActiveWorktree(
			projectId,
			worktreePath
		);
	} catch (error) {
		onUnexpectedError(error);
	}
}
