/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from
	'../../../base/common/errors.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IProjectManagerService } from
	'../../../platform/projectManager/common/projectManager.js';
import { IHostService } from
	'../../../workbench/services/host/browser/host.js';
import { IWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/common/environmentService.js';
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
	isHucodeHostedShellServiceAvailable,
} from '../../../platform/window/common/hucodeHostedShellService.js';
import { IHucodeShellControllerService } from
	'../../../platform/window/common/hucodeShellControllerService.js';
import {
	canonicalizeProjectSwitcherTarget,
	IProjectSwitcherSelectionTarget,
} from
	'../../common/projectSwitcher/switchProjectWorktreeModel.js';
import { pathsEqual } from './projectSwitcherCommon.js';

const hostedShellCapabilityUnavailable = localize(
	'hostedShellCapabilityUnavailable',
	'Hosted shell capability is unavailable.'
);
const hostedFolderNavigationUnsupported = localize(
	'hostedFolderNavigationUnsupported',
	'Hosted folder navigation is unsupported.'
);
const hostedFolderNavigationRejected = localize(
	'hostedFolderNavigationRejected',
	'The Omni shell rejected this workbench switch.'
);
const hostedFolderNavigationStale = localize(
	'hostedFolderNavigationStale',
	'This workbench is no longer connected to the current Omni shell instance.'
);
const omniShellControllerUnavailable = localize(
	'omniShellControllerUnavailable',
	'Omni shell controller is unavailable.'
);

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
	if (environmentService.isHostedOmniWorkspace) {
		if (!hostedShellService ||
			!isHucodeHostedShellServiceAvailable(hostedShellService)) {
			throw new Error(hostedShellCapabilityUnavailable);
		}
		const outcome = await hostedShellService.navigateToFolder({
			folderUri: URI.file(canonicalTarget.worktreePath).toJSON(),
		});
		switch (outcome) {
			case HucodeHostedShellOperationOutcome.Accepted:
			case HucodeHostedShellOperationOutcome.Superseded:
				return;
			case HucodeHostedShellOperationOutcome.Unsupported:
				throw new Error(hostedFolderNavigationUnsupported);
			case HucodeHostedShellOperationOutcome.Stale:
				throw new Error(hostedFolderNavigationStale);
			case HucodeHostedShellOperationOutcome.Rejected:
				throw new Error(hostedFolderNavigationRejected);
			case HucodeHostedShellOperationOutcome.Unavailable:
				throw new Error(hostedShellCapabilityUnavailable);
			default:
				throw new Error(localize(
					'hostedFolderNavigationUnknown',
					'The Omni shell returned an unrecognized workbench switch result.'
				));
		}
	}

	if (environmentService.isOmniWindow) {
		if (!shellService) {
			throw new Error(omniShellControllerUnavailable);
		}
		if (await focusNormalWindowByPathBestEffort(
			shellService,
			canonicalTarget.worktreePath
		)) {
			await setLastActiveWorktreeBestEffort(
				projectManagerService,
				canonicalTarget.projectId,
				canonicalTarget.worktreePath
			);
			return;
		}

		await shellService.openWorkspace(
			canonicalTarget.worktreePath,
			canonicalTarget.projectId
		);
		await focusWorkspaceBestEffort(shellService);
		await setLastActiveWorktreeBestEffort(
			projectManagerService,
			canonicalTarget.projectId,
			canonicalTarget.worktreePath
		);
		return;
	}

	await hostService.openWindow(
		[{ folderUri: URI.file(canonicalTarget.worktreePath) }],
		{ forceReuseWindow: true }
	);
	await setLastActiveWorktreeBestEffort(
		projectManagerService,
		canonicalTarget.projectId,
		canonicalTarget.worktreePath
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

/** Focuses the opened workspace without failing the completed navigation. */
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
