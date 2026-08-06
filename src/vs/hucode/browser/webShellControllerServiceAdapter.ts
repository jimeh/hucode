/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { Event } from '../../base/common/event.js';
import { URI } from '../../base/common/uri.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import { IHucodeShellService } from '../common/omniWindow.js';
import { IHucodeShellControllerService } from
	'../../platform/window/common/hucodeShellControllerService.js';

/** Local owner-bound controller used by the serve-web Omni shell. */
export class WebShellControllerServiceAdapter
	implements IHucodeShellControllerService {

	declare readonly _serviceBrand: undefined;
	readonly supportsWorkspaceScreenshotOverlay: boolean;
	readonly onDidChangeState: IHucodeShellControllerService['onDidChangeState'];

	private readonly windowId = dom.getWindowId(mainWindow);

	constructor(
		@IHucodeShellService private readonly shell: IHucodeShellService
	) {
		this.supportsWorkspaceScreenshotOverlay =
			shell.supportsWorkspaceScreenshotOverlay;
		this.onDidChangeState = Event.map(
			Event.filter(shell.onDidChangeWindowState,
				change => change.windowId === this.windowId),
			change => change.state
		);
	}

	getState() { return this.shell.getWindowState(this.windowId); }
	focusHostedWorkspaceByPath(path: string, projectId?: string) {
		return this.shell.focusHostedWorkspaceByPath(path, projectId);
	}
	focusNormalWindowByPath(path: string) {
		return this.shell.focusNormalWindowByPath(path);
	}
	openWorkspace(path: string, projectId?: string) {
		return this.shell.openWorkspace(this.windowId, path, projectId);
	}
	openAndFocusWorkspace(path: string, projectId?: string) {
		return this.shell.openAndFocusWorkspace(this.windowId, path, projectId);
	}
	suspendWorkspace(instanceId: string) {
		return this.shell.suspendWorkspace(this.windowId, instanceId);
	}
	retainAndOpenWorkbench(folderUri: Parameters<
		IHucodeShellControllerService['retainAndOpenWorkbench']
	>[0]) {
		return this.shell.retainAndOpenWorkbench(this.windowId, folderUri);
	}
	unloadRetainedWorkbench(id: string) {
		return this.shell.unloadRetainedWorkbench(this.windowId, id);
	}
	dismissRetainedWorkbench(id: string) {
		return this.shell.dismissRetainedWorkbench(this.windowId, id);
	}
	reorderRetainedWorkbenches(ids: readonly string[]) {
		return this.shell.reorderRetainedWorkbenches(this.windowId, ids);
	}
	setRetainedWorkbenchLabel(id: string, label: string | undefined) {
		return this.shell.setRetainedWorkbenchLabel(this.windowId, id, label);
	}
	reconcileRetainedWorkbenchesWithCompleteProjectCatalog(projects: Parameters<
		IHucodeShellControllerService[
		'reconcileRetainedWorkbenchesWithCompleteProjectCatalog'
		]
	>[0]) {
		return this.shell.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
			this.windowId,
			projects
		);
	}
	promoteRetainedWorkbenchProjectFolders(folders: Parameters<
		IHucodeShellControllerService['promoteRetainedWorkbenchProjectFolders']
	>[0]) {
		return this.shell.promoteRetainedWorkbenchProjectFolders(
			this.windowId,
			folders
		);
	}
	setHostedWorkbenchRestorePolicy(policy: Parameters<
		IHucodeShellControllerService['setHostedWorkbenchRestorePolicy']
	>[0]) {
		return this.shell.setHostedWorkbenchRestorePolicy(this.windowId, policy);
	}
	openFilesInWorkspace(path: string, request: Parameters<
		IHucodeShellControllerService['openFilesInWorkspace']
	>[1], projectId?: string) {
		return this.shell.openFilesInWorkspace(
			this.windowId,
			path,
			request,
			projectId
		);
	}
	openFilesInActiveWorkspace(request: Parameters<
		IHucodeShellControllerService['openFilesInActiveWorkspace']
	>[0]) {
		return this.shell.openFilesInActiveWorkspace(this.windowId, request);
	}
	closeWorkspace(instanceId?: string) {
		return this.shell.closeWorkspace(this.windowId, instanceId);
	}
	reopenWorkspaceInNormalWindow(instanceId: string) {
		return this.shell.reopenWorkspaceInNormalWindow(
			this.windowId,
			instanceId
		);
	}
	async prepareWorkspaceForStandaloneOpen(request: Parameters<
		IHucodeShellControllerService['prepareWorkspaceForStandaloneOpen']
	>[0]): Promise<boolean> {
		if (request.retainedWorkbenchId) {
			const state = await this.unloadRetainedWorkbench(
				request.retainedWorkbenchId
			);
			const retained = state.retainedWorkbenches?.find(record =>
				record.id === request.retainedWorkbenchId);
			if (retained && retained.desiredState !== 'unloaded') {
				return false;
			}
		}
		const path = URI.revive(request.folderUri).fsPath;
		const owner = await this.shell.findHostedWorkspaceByPath(path);
		if (!owner) {
			return true;
		}
		const state = await this.shell.closeWorkspace(
			owner.windowId,
			owner.instanceId
		);
		return !state.instances.some(instance =>
			instance.instanceId === owner.instanceId);
	}
	focusWorkspace() { return this.shell.focusWorkspace(this.windowId); }
	focusShell() { return this.shell.focusShell(this.windowId); }
	setProjectsSidebarVisible(visible: boolean) {
		return this.shell.setProjectsSidebarVisible(this.windowId, visible);
	}
	setProjectSwitcherNavigationState(back: boolean, forward: boolean) {
		return this.shell.setProjectSwitcherNavigationState(
			this.windowId,
			back,
			forward
		);
	}
	setProjectSwitcherSectionOrder(order: Parameters<
		IHucodeShellControllerService['setProjectSwitcherSectionOrder']
	>[0]) {
		return this.shell.setProjectSwitcherSectionOrder(this.windowId, order);
	}
	runActionInWorkspace(request: Parameters<
		IHucodeShellControllerService['runActionInWorkspace']
	>[0]) {
		return this.shell.runActionInWorkspace(this.windowId, request);
	}
	runKeybindingInWorkspace(request: Parameters<
		IHucodeShellControllerService['runKeybindingInWorkspace']
	>[0]) {
		return this.shell.runKeybindingInWorkspace(this.windowId, request);
	}
	triggerPasteInWorkspace() {
		return this.shell.triggerPasteInWorkspace(this.windowId);
	}
	reloadWorkspace() { return this.shell.reloadWorkspace(this.windowId); }
	toggleWorkspaceDevTools() {
		return this.shell.toggleWorkspaceDevTools(this.windowId);
	}
	layoutWorkspace(bounds: Parameters<
		IHucodeShellControllerService['layoutWorkspace']
	>[0]) {
		return this.shell.layoutWorkspace(this.windowId, bounds);
	}
	captureWorkspaceScreenshot(rect?: Parameters<
		IHucodeShellControllerService['captureWorkspaceScreenshot']
	>[0], quality?: number) {
		return this.shell.captureWorkspaceScreenshot(
			this.windowId,
			rect,
			quality
		);
	}
	setWorkspaceOverlayOcclusion(occluded: boolean) {
		return this.shell.setWorkspaceOverlayOcclusion(
			this.windowId,
			occluded
		);
	}
	shutdownWindowWorkspaces(reason: Parameters<
		IHucodeShellControllerService['shutdownWindowWorkspaces']
	>[0]) {
		return this.shell.shutdownWindowWorkspaces(this.windowId, reason);
	}
}

registerSingleton(
	IHucodeShellControllerService,
	WebShellControllerServiceAdapter,
	InstantiationType.Delayed
);
