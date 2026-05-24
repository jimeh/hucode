/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { isEqual } from '../../../../base/common/extpath.js';
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
import { IWorkbenchEnvironmentService } from
	'../../environment/common/environmentService.js';

export interface IHucodeOmniOpenShellService {
	focusNormalWindowByPath(worktreePath: string): Promise<boolean>;
	openWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<unknown>;
	focusWorkspace(windowId: number): Promise<void>;
}

export async function tryOpenHucodeOmniWindow(
	toOpen: IWindowOpenable[],
	options: IOpenWindowOptions | undefined,
	nativeHostService: INativeHostService,
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeOmniOpenShellService,
	projectManagerService: IProjectManagerService
): Promise<boolean> {
	if (
		!environmentService.isOmniWindow &&
		!environmentService.isHostedOmniWorkspace
	) {
		return false;
	}

	if (
		options?.forceNewWindow ||
		options?.addMode ||
		options?.removeMode ||
		options?.diffMode ||
		options?.mergeMode ||
		options?.gotoLineMode ||
		options?.waitMarkerFileURI
	) {
		return false;
	}

	if (toOpen.length !== 1) {
		return false;
	}

	const openable = toOpen[0];
	if (isFolderToOpen(openable)) {
		const target = await getProjectWorktreeTarget(
			projectManagerService,
			openable.folderUri.fsPath
		);
		if (target) {
			if (await focusNormalWindowByPathBestEffort(
				shellService,
				target.worktreePath
			)) {
				return true;
			}
			await setLastActiveWorktreeBestEffort(
				projectManagerService,
				target.projectId,
				target.worktreePath
			);
			await shellService.openWorkspace(
				nativeHostService.windowId,
				target.worktreePath,
				target.projectId
			);
			await focusWorkspaceBestEffort(
				shellService,
				nativeHostService.windowId
			);
			return true;
		}
	}

	if (isFolderToOpen(openable) || isWorkspaceToOpen(openable)) {
		await nativeHostService.openWindow(
			toOpen,
			toOmniFallbackOpenOptions(options)
		);
		return true;
	}

	return false;
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
	shellService: IHucodeOmniOpenShellService,
	windowId: number
): Promise<void> {
	try {
		await shellService.focusWorkspace(windowId);
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
