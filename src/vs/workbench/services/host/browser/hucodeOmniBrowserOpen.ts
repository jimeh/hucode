/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { createDecorator } from
	'../../../../platform/instantiation/common/instantiation.js';
import { getHucodeServerPathCaseSensitive } from
	'../../../../platform/environment/common/hucodeWebConfiguration.js';
import { IProjectManagerService } from
	'../../../../platform/projectManager/common/projectManager.js';
import { getProjectManagerPathComparisonKey } from
	'../../../../platform/projectManager/common/projectManagerState.js';
import {
	IOpenWindowOptions,
	IWindowOpenable,
	isFolderToOpen,
} from '../../../../platform/window/common/window.js';
import { IBrowserWorkbenchEnvironmentService } from
	'../../environment/browser/environmentService.js';

interface IHucodeBrowserOmniShellService {
	readonly _serviceBrand: undefined;
	focusHostedWorkspaceByPath(
		path: string,
		projectId?: string
	): Promise<boolean>;
	focusNormalWindowByPath(path: string): Promise<boolean>;
	openWorkspace(
		windowId: number,
		path: string,
		projectId?: string
	): Promise<unknown>;
	focusWorkspace(windowId: number): Promise<void>;
}

/** Browser-local view of the Hucode shell service. */
export const IHucodeBrowserOmniShellService =
	createDecorator<IHucodeBrowserOmniShellService>('hucodeShellService');

/** Routes ordinary folder opens from serve-web Omni into hosted workbenches. */
export async function tryOpenHucodeOmniBrowserWindow(
	toOpen: IWindowOpenable[],
	options: IOpenWindowOptions | undefined,
	environmentService: IBrowserWorkbenchEnvironmentService,
	shellService: IHucodeBrowserOmniShellService,
	projectManagerService: IProjectManagerService
): Promise<boolean> {
	if ((!environmentService.isOmniWindow &&
		!environmentService.isHostedOmniWorkspace) ||
		options?.forceNewWindow || options?.addMode || options?.removeMode ||
		options?.diffMode || options?.mergeMode || options?.gotoLineMode ||
		options?.waitMarkerFileURI || toOpen.length !== 1 ||
		!isFolderToOpen(toOpen[0])
	) {
		return false;
	}

	const folderUri = toOpen[0].folderUri;
	if (
		folderUri.scheme !== Schemas.file &&
		(folderUri.scheme !== Schemas.vscodeRemote ||
			!environmentService.remoteAuthority ||
			folderUri.authority !== environmentService.remoteAuthority)
	) {
		return false;
	}

	const path = folderUri.fsPath;
	let worktreePath = path;
	let projectId: string | undefined;
	const pathKey = getProjectManagerPathComparisonKey(
		path,
		getHucodeServerPathCaseSensitive(environmentService.options)
	);
	try {
		for (const project of await projectManagerService.getProjects()) {
			const worktree = project.worktrees.find(candidate =>
				getProjectManagerPathComparisonKey(
					candidate.path,
					getHucodeServerPathCaseSensitive(environmentService.options)
				) === pathKey
			);
			if (worktree) {
				projectId = project.id;
				worktreePath = worktree.path;
				try {
					await projectManagerService.setLastActiveWorktree(
						project.id,
						worktree.path
					);
				} catch (error) {
					onUnexpectedError(error);
				}
				break;
			}
		}
	} catch (error) {
		onUnexpectedError(error);
	}
	try {
		if (await shellService.focusHostedWorkspaceByPath(
			worktreePath,
			projectId
		)) {
			return true;
		}
	} catch (error) {
		onUnexpectedError(error);
	}
	try {
		if (await shellService.focusNormalWindowByPath(worktreePath)) {
			return true;
		}
	} catch (error) {
		onUnexpectedError(error);
	}

	const windowId = getWindowId(mainWindow);
	await shellService.openWorkspace(windowId, worktreePath, projectId);
	await shellService.focusWorkspace(windowId);
	return true;
}
