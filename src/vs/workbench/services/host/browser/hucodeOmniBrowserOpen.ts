/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from
	'../../../../platform/instantiation/common/instantiation.js';
import { getHucodeServerPathCaseSensitive } from
	'../../../../platform/environment/common/hucodeWebConfiguration.js';
import { getProjectManagerPathComparisonKey } from
	'../../../../platform/projectManager/common/projectManagerState.js';
import {
	IOpenWindowOptions,
	IWindowOpenable,
	isFolderToOpen,
} from '../../../../platform/window/common/window.js';
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
} from '../../../../platform/window/common/hucodeHostedShellService.js';

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
	openAndFocusWorkspace(
		windowId: number,
		path: string,
		projectId?: string
	): Promise<unknown>;
	focusWorkspace(windowId: number): Promise<void>;
}

/** Environment fields used by browser-local Omni folder routing. */
export interface IHucodeOmniBrowserEnvironment {
	readonly isOmniWindow?: boolean;
	readonly isHostedOmniWorkspace?: boolean;
	readonly extensionDevelopmentLocationURI?: readonly URI[];
	readonly remoteAuthority?: string;
	readonly options?: object;
}

/** Project-manager operations used by browser-local Omni folder routing. */
export interface IHucodeOmniBrowserProjectManager {
	getProjects(): Promise<readonly {
		readonly id: string;
		readonly worktrees: readonly { readonly path: string }[];
	}[]>;
	setLastActiveWorktree(
		projectId: string,
		worktreePath: string
	): Promise<void>;
}

/** Browser-local view of the Hucode shell service. */
export const IHucodeBrowserOmniShellService =
	createDecorator<IHucodeBrowserOmniShellService>('hucodeShellService');

/** Routes ordinary folder opens from serve-web Omni into hosted workbenches. */
export async function tryOpenHucodeOmniBrowserWindow(
	toOpen: IWindowOpenable[],
	options: IOpenWindowOptions | undefined,
	environmentService: IHucodeOmniBrowserEnvironment,
	shellService: IHucodeBrowserOmniShellService,
	projectManagerService: IHucodeOmniBrowserProjectManager
): Promise<boolean> {
	if (!environmentService.isOmniWindow ||
		environmentService.extensionDevelopmentLocationURI ||
		options?.forceNewWindow || options?.addMode || options?.removeMode ||
		options?.diffMode || options?.mergeMode || options?.gotoLineMode ||
		options?.waitMarkerFileURI || options?.forceProfile ||
		options?.forceTempProfile || options?.chatSessionToOpen ||
		toOpen.length !== 1 ||
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
	const windowId = getWindowId(mainWindow);
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

	await shellService.openWorkspace(windowId, worktreePath, projectId);
	await shellService.focusWorkspace(windowId);
	return true;
}

/** Routes a hosted web workbench folder open through its bound capability. */
export async function tryNavigateHucodeHostedBrowserWindow(
	toOpen: IWindowOpenable[],
	options: IOpenWindowOptions | undefined,
	environmentService: IHucodeOmniBrowserEnvironment,
	hostedShellService: IHucodeHostedShellService
): Promise<boolean> {
	if (!environmentService.isHostedOmniWorkspace ||
		environmentService.extensionDevelopmentLocationURI ||
		options?.forceNewWindow || options?.addMode || options?.removeMode ||
		options?.diffMode || options?.mergeMode || options?.gotoLineMode ||
		options?.waitMarkerFileURI || options?.forceProfile ||
		options?.forceTempProfile || options?.chatSessionToOpen ||
		toOpen.length !== 1 || !isFolderToOpen(toOpen[0])) {
		return false;
	}

	const result = await hostedShellService.navigateToFolder({
		folderUri: toOpen[0].folderUri.toJSON(),
	});
	return result !== HucodeHostedShellOperationOutcome.Unsupported;
}
