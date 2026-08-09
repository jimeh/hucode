/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createDecorator, IInstantiationService } from
	'../../../../platform/instantiation/common/instantiation.js';
import { getHucodeServerPathCaseSensitive } from
	'../../../../platform/environment/common/hucodeWebConfiguration.js';
import { getProjectManagerPathComparisonKey } from
	'../../../../platform/projectManager/common/projectManagerState.js';
import { IProjectManagerService } from
	'../../../../platform/projectManager/common/projectManager.js';
import {
	IOpenWindowOptions,
	IWindowOpenable,
	isFolderToOpen,
} from '../../../../platform/window/common/window.js';
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
	isHucodeHostedShellServiceAvailable,
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

/** Selects the browser-local Omni routing capability for the current window. */
export async function dispatchHucodeOmniBrowserOpen(
	toOpen: IWindowOpenable[],
	options: IOpenWindowOptions | undefined,
	environmentService: IHucodeOmniBrowserEnvironment,
	instantiationService: IInstantiationService
): Promise<boolean> {
	return instantiationService.invokeFunction(accessor => {
		if (environmentService.isHostedOmniWorkspace) {
			return tryNavigateHucodeHostedBrowserWindow(
				toOpen,
				options,
				environmentService,
				accessor.get(IHucodeHostedShellService)
			);
		}
		if (environmentService.isOmniWindow) {
			return tryOpenHucodeOmniBrowserWindow(
				toOpen,
				options,
				environmentService,
				accessor.get(IHucodeBrowserOmniShellService),
				accessor.get(IProjectManagerService)
			);
		}

		return false;
	});
}

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
			await setLastActiveWorktreeBestEffort(
				projectManagerService, projectId, worktreePath);
			return true;
		}
	} catch (error) {
		onUnexpectedError(error);
	}
	try {
		if (await shellService.focusNormalWindowByPath(worktreePath)) {
			await setLastActiveWorktreeBestEffort(
				projectManagerService, projectId, worktreePath);
			return true;
		}
	} catch (error) {
		onUnexpectedError(error);
	}

	await shellService.openWorkspace(windowId, worktreePath, projectId);
	await shellService.focusWorkspace(windowId);
	await setLastActiveWorktreeBestEffort(
		projectManagerService, projectId, worktreePath);
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
	if (!isHucodeHostedShellServiceAvailable(hostedShellService)) {
		onUnexpectedError(new Error(localize(
			'hostedOmniFolderNavigationUnavailable',
			'Hosted Omni folder navigation is unavailable.'
		)));
		return true;
	}

	const result = await hostedShellService.navigateToFolder({
		folderUri: toOpen[0].folderUri.toJSON(),
	});
	switch (result) {
		case HucodeHostedShellOperationOutcome.Unsupported:
			return false;
		case HucodeHostedShellOperationOutcome.Accepted:
		case HucodeHostedShellOperationOutcome.Superseded:
			return true;
		case HucodeHostedShellOperationOutcome.Rejected:
		case HucodeHostedShellOperationOutcome.Stale:
		case HucodeHostedShellOperationOutcome.Unavailable:
		default:
			onUnexpectedError(new Error(localize(
				'hostedOmniFolderNavigationNotAccepted',
				'Hosted Omni folder navigation was not accepted for {0}: {1}.',
				toOpen[0].folderUri.toString(true),
				result
			)));
			return true;
	}
}

async function setLastActiveWorktreeBestEffort(
	projectManagerService: IHucodeOmniBrowserProjectManager,
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
