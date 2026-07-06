/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../base/common/errors.js';
import { Schemas } from '../../base/common/network.js';
import { extUriBiasedIgnorePathCase } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { IProjectManagerMainService } from '../../platform/projectManager/electron-main/projectManager.js';
import { ProjectRecord, WorktreeRecord } from '../../platform/projectManager/common/projectManager.js';
import { INativeOpenFileRequest, IPath } from '../../platform/window/common/window.js';
import { ICodeWindow } from '../../platform/window/electron-main/window.js';
import { IHucodeShellMainService } from './omniWindow.js';

/**
 * File-open payload shape used by the main-process Hucode Omni router.
 */
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
 * Known Hucode worktree target for a set of files.
 */
export interface IHucodeProjectWorktreeTarget {
	readonly projectId: string;
	readonly worktreePath: string;
}

/**
 * Routes plain file opens to an Omni hosted workbench when possible.
 */
export async function tryOpenFilesInHucodeOmniWindow(
	accessor: ServicesAccessor,
	windows: readonly ICodeWindow[],
	filesToOpen: IHucodeFilesToOpen,
	termProgram: string | undefined
): Promise<ICodeWindow | undefined> {
	const omniWindow = getLastActiveHucodeOmniWindow(windows);
	if (!omniWindow) {
		return undefined;
	}

	const fileUris = getPlainFileOpenUris(filesToOpen);
	if (!fileUris.length) {
		return undefined;
	}

	try {
		const projectManagerService = accessor.get(IProjectManagerMainService);
		const shellService = accessor.get(IHucodeShellMainService);
		const target = findHucodeProjectWorktreeForFiles(
			await projectManagerService.getProjects(),
			fileUris
		);
		const request: INativeOpenFileRequest = {
			filesToOpenOrCreate: filesToOpen.filesToOpenOrCreate,
			filesToWait: filesToOpen.filesToWait,
			termProgram,
		};

		if (!target) {
			const opened = await shellService.openFilesInActiveWorkspace(
				omniWindow.id,
				request
			);

			return opened ? omniWindow : undefined;
		}

		try {
			await projectManagerService.setLastActiveWorktree(
				target.projectId,
				target.worktreePath
			);
		} catch (error) {
			onUnexpectedError(error);
		}

		const opened = await shellService.openFilesInWorkspace(
			omniWindow.id,
			target.worktreePath,
			request,
			target.projectId
		);

		return opened ? omniWindow : undefined;
	} catch (error) {
		onUnexpectedError(error);
		return undefined;
	}
}

/**
 * Finds the most specific known project worktree that contains all file URIs.
 */
export function findHucodeProjectWorktreeForFiles(
	projects: readonly ProjectRecord[],
	fileUris: readonly URI[]
): IHucodeProjectWorktreeTarget | undefined {
	let bestMatch:
		| {
			readonly projectId: string;
			readonly worktree: WorktreeRecord;
		}
		| undefined;

	for (const project of projects) {
		for (const worktree of project.worktrees) {
			const worktreeUri = URI.file(worktree.path);
			if (!fileUris.every(uri =>
				extUriBiasedIgnorePathCase.isEqualOrParent(uri, worktreeUri)
			)) {
				continue;
			}

			if (!bestMatch || worktree.path.length > bestMatch.worktree.path.length) {
				bestMatch = { projectId: project.id, worktree };
			}
		}
	}

	if (!bestMatch) {
		return undefined;
	}

	return {
		projectId: bestMatch.projectId,
		worktreePath: bestMatch.worktree.path,
	};
}

/**
 * Returns the most recently focused Omni shell window.
 */
export function getLastActiveHucodeOmniWindow(
	windows: readonly ICodeWindow[]
): ICodeWindow | undefined {
	return windows
		.filter(window => window.isOmniWindow)
		.toSorted((a, b) => b.lastFocusTime - a.lastFocusTime)[0];
}

/**
 * Identifies Omni shell windows so regular file-open fallback can ignore them.
 */
export function isHucodeOmniWindow(window: ICodeWindow): boolean {
	return window.isOmniWindow;
}

function getPlainFileOpenUris(filesToOpen: IHucodeFilesToOpen): URI[] {
	if (filesToOpen.filesToDiff.length || filesToOpen.filesToMerge.length) {
		return [];
	}

	return filesToOpen.filesToOpenOrCreate
		.map(path => path.fileUri)
		.filter((uri): uri is URI => uri?.scheme === Schemas.file);
}
