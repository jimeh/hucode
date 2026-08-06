/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { isEqual } from '../../../../base/common/extpath.js';
import { Schemas } from '../../../../base/common/network.js';
import { isLinux } from '../../../../base/common/platform.js';
import { INativeHostService } from
	'../../../../platform/native/common/native.js';
import { IProjectManagerService } from
	'../../../../platform/projectManager/common/projectManager.js';
import {
	IOpenWindowOptions,
	IWindowOpenable,
	isFolderToOpen,
	isWorkspaceToOpen,
} from '../../../../platform/window/common/window.js';
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
} from '../../../../platform/window/common/hucodeHostedShellService.js';
import { IWorkbenchEnvironmentService } from
	'../../environment/common/environmentService.js';

export interface IHucodeOmniOpenShellService {
	focusHostedWorkspaceByPath(
		worktreePath: string,
		projectId?: string
	): Promise<boolean>;
	focusNormalWindowByPath(worktreePath: string): Promise<boolean>;
	openWorkspace(
		worktreePath: string,
		projectId?: string
	): Promise<unknown>;
	focusWorkspace(): Promise<void>;
}

export async function tryOpenHucodeOmniWindow(
	toOpen: IWindowOpenable[],
	options: IOpenWindowOptions | undefined,
	nativeHostService: INativeHostService,
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeOmniOpenShellService,
	hostedShellService: IHucodeHostedShellService,
	projectManagerService: IProjectManagerService
): Promise<boolean> {
	if (
		!environmentService.isOmniWindow &&
		!environmentService.isHostedOmniWorkspace
	) {
		return false;
	}

	if (
		environmentService.extensionDevelopmentLocationURI ||
		options?.forceNewWindow ||
		options?.addMode ||
		options?.removeMode ||
		options?.diffMode ||
		options?.mergeMode ||
		options?.gotoLineMode ||
		options?.waitMarkerFileURI ||
		options?.forceProfile ||
		options?.forceTempProfile ||
		options?.chatSessionToOpen
	) {
		return false;
	}

	if (toOpen.length !== 1) {
		return false;
	}

	const openable = toOpen[0];
	if (isFolderToOpen(openable)) {
		if (openable.folderUri.scheme !== Schemas.file) {
			return false;
		}
		if (environmentService.isHostedOmniWorkspace) {
			const outcome = await hostedShellService.navigateToFolder({
				folderUri: openable.folderUri.toJSON(),
			});
			if (outcome !== HucodeHostedShellOperationOutcome.Accepted &&
				outcome !== HucodeHostedShellOperationOutcome.Unsupported &&
				outcome !== HucodeHostedShellOperationOutcome.Superseded) {
				onUnexpectedError(new Error(
					'Hosted Omni folder navigation was not accepted for ' +
					`${openable.folderUri.toString(true)}: ${outcome}.`
				));
			}
			return outcome !== HucodeHostedShellOperationOutcome.Unsupported;
		}
		const target = await getProjectWorktreeTarget(
			projectManagerService,
			openable.folderUri.fsPath
		);
		const worktreePath = target?.worktreePath ?? openable.folderUri.fsPath;
		if (target) {
			await setLastActiveWorktreeBestEffort(
				projectManagerService,
				target.projectId,
				target.worktreePath
			);
		}
		if (await focusHostedWorkspaceByPathBestEffort(
			shellService,
			worktreePath,
			target?.projectId
		)) {
			return true;
		}
		if (await focusNormalWindowByPathBestEffort(
			shellService,
			worktreePath
		)) {
			return true;
		}
		await shellService.openWorkspace(
			worktreePath,
			target?.projectId
		);
		await focusWorkspaceBestEffort(shellService);
		return true;
	}

	if (isWorkspaceToOpen(openable)) {
		await nativeHostService.openWindow(
			toOpen,
			toOmniFallbackOpenOptions(options)
		);
		return true;
	}

	return false;
}

async function focusHostedWorkspaceByPathBestEffort(
	shellService: IHucodeOmniOpenShellService,
	worktreePath: string,
	projectId?: string
): Promise<boolean> {
	try {
		return await shellService.focusHostedWorkspaceByPath(
			worktreePath,
			projectId
		);
	} catch (error) {
		onUnexpectedError(error);
		return false;
	}
}

async function getProjectWorktreeTarget(
	projectManagerService: IProjectManagerService,
	path: string
): Promise<{ readonly projectId: string; readonly worktreePath: string } | undefined> {
	try {
		for (const project of await projectManagerService.getProjects()) {
			const worktree = project.worktrees.find(candidate =>
				isEqual(candidate.path, path, !isLinux)
			);
			if (worktree) {
				return {
					projectId: project.id,
					worktreePath: worktree.path,
				};
			}
		}
	} catch (error) {
		onUnexpectedError(error);
	}

	return undefined;
}

async function focusNormalWindowByPathBestEffort(
	shellService: IHucodeOmniOpenShellService,
	worktreePath: string
): Promise<boolean> {
	try {
		return await shellService.focusNormalWindowByPath(worktreePath);
	} catch (error) {
		onUnexpectedError(error);
		return false;
	}
}

async function setLastActiveWorktreeBestEffort(
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

async function focusWorkspaceBestEffort(
	shellService: IHucodeOmniOpenShellService
): Promise<void> {
	try {
		await shellService.focusWorkspace();
	} catch (error) {
		onUnexpectedError(error);
	}
}

function toOmniFallbackOpenOptions(
	options?: IOpenWindowOptions
): IOpenWindowOptions {
	const { forceReuseWindow, ...fallbackOptions } = options ?? {};
	return {
		...fallbackOptions,
		forceNewWindow: true,
	};
}
