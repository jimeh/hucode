/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../base/common/errors.js';
import { isEqual } from '../../base/common/extpath.js';
import { Schemas } from '../../base/common/network.js';
import { isLinux } from '../../base/common/platform.js';
import { URI } from '../../base/common/uri.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { ProjectRecord } from '../../platform/projectManager/common/projectManager.js';
import { IProjectManagerMainService } from '../../platform/projectManager/electron-main/projectManager.js';
import { INativeOpenFileRequest, IPath } from '../../platform/window/common/window.js';
import { ICodeWindow } from '../../platform/window/electron-main/window.js';
import { IHucodeShellMainService } from './omniWindow.js';

interface IHucodeFilesToOpen {
	filesToOpenOrCreate: IPath[];
	filesToDiff: IPath[];
	filesToMerge: IPath[];
	filesToWait?: {
		paths: IPath[];
		waitMarkerFileUri: URI;
	};
}

/**
 * Result of routing a folder open into an existing Omni hosted workbench.
 */
export interface IHucodeHostedFolderOpenResult {
	readonly window: ICodeWindow;
	readonly openedFiles: boolean;
}

/**
 * Focuses an existing hosted Omni workbench for a folder open request.
 */
export async function tryOpenFolderInHucodeHostedWorkspace(
	accessor: ServicesAccessor,
	windows: readonly ICodeWindow[],
	folderUri: URI,
	filesToOpen: IHucodeFilesToOpen | undefined,
	termProgram: string | undefined
): Promise<IHucodeHostedFolderOpenResult | undefined> {
	if (folderUri.scheme !== Schemas.file) {
		return undefined;
	}

	try {
		const shellService = accessor.get(IHucodeShellMainService);
		const projectManagerService = accessor.get(IProjectManagerMainService);
		const owner = await shellService.findHostedWorkspaceByPath(
			folderUri.fsPath
		);
		if (!owner) {
			return undefined;
		}

		const window = windows.find(candidate => candidate.id === owner.windowId);
		if (!window?.isOmniWindow) {
			return undefined;
		}

		const target = findHucodeProjectWorktreeByPath(
			await projectManagerService.getProjects(),
			owner.worktreePath
		);
		const projectId = target?.projectId ?? owner.projectId;
		if (projectId) {
			try {
				await projectManagerService.setLastActiveWorktree(
					projectId,
					owner.worktreePath
				);
			} catch (error) {
				onUnexpectedError(error);
			}
		}

		if (filesToOpen) {
			const openedFiles = await shellService.openFilesInWorkspace(
				owner.windowId,
				owner.worktreePath,
				toNativeOpenFileRequest(filesToOpen, termProgram),
				projectId
			);
			if (!openedFiles) {
				await shellService.focusHostedWorkspaceByPath(
					owner.worktreePath,
					projectId
				);
			}
			return { window, openedFiles };
		}

		await shellService.focusHostedWorkspaceByPath(
			owner.worktreePath,
			projectId
		);
		return { window, openedFiles: false };
	} catch (error) {
		onUnexpectedError(error);
		return undefined;
	}
}

function findHucodeProjectWorktreeByPath(
	projects: readonly ProjectRecord[],
	worktreePath: string
): { readonly projectId: string; readonly worktreePath: string } | undefined {
	for (const project of projects) {
		const worktree = project.worktrees.find(candidate =>
			isEqual(candidate.path, worktreePath, !isLinux)
		);
		if (worktree) {
			return {
				projectId: project.id,
				worktreePath: worktree.path,
			};
		}
	}

	return undefined;
}

function toNativeOpenFileRequest(
	filesToOpen: IHucodeFilesToOpen,
	termProgram: string | undefined
): INativeOpenFileRequest {
	return {
		filesToOpenOrCreate: filesToOpen.filesToOpenOrCreate,
		filesToDiff: filesToOpen.filesToDiff,
		filesToMerge: filesToOpen.filesToMerge,
		filesToWait: filesToOpen.filesToWait,
		termProgram,
	};
}
