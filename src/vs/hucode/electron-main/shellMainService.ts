/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { isEqual } from '../../base/common/extpath.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { isLinux } from '../../base/common/platform.js';
import { URI, UriComponents } from '../../base/common/uri.js';
import { IEnvironmentMainService } from
	'../../platform/environment/electron-main/environmentMainService.js';
import { IConfigurationService } from
	'../../platform/configuration/common/configuration.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IProtocolMainService } from
	'../../platform/protocol/electron-main/protocol.js';
import { IThemeMainService } from
	'../../platform/theme/electron-main/themeMainService.js';
import { UnloadReason } from '../../platform/window/electron-main/window.js';
import {
	INativeOpenFileRequest,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
	IRectangle,
} from '../../platform/window/common/window.js';
import { IWindowsMainService, OpenContext } from
	'../../platform/windows/electron-main/windows.js';
import {
	IHucodeCompleteProjectCatalogEntry,
	IHucodeHostedWorkspaceState,
	IHucodeHostedWorkspaceOwner,
	IHucodeProjectFolderPromotion,
	IHucodeShellWindowStateChange,
} from '../common/omniWindow.js';
import { ProjectSwitcherOmniSection } from
	'../common/projectSwitcher/projectSwitcherViewState.js';
import { IHucodeShellMainService } from './omniWindow.js';
import { findWindowOnWorkspaceOrFolder } from
	'../../platform/windows/electron-main/windowsFinder.js';
import { ShutdownReason } from '../../workbench/services/lifecycle/common/lifecycle.js';
import { IBrowserViewMainService } from
	'../../platform/browserView/electron-main/browserViewMainService.js';
import { ResidentHostedWorkspacesController } from './hostedWorkspacesController.js';
import { reopenHucodeHostedWorkspaceInNormalWindow } from
	'./omniWorkspaceReopen.js';
import { isHostedWorkspaceRestorable } from
	'../common/hostedWorkspaceState.js';
import {
	HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING,
	HucodeHostedWorkbenchRestorePolicy,
} from
	'../common/retainedWorkbench.js';
import { ShellControllerStore } from '../common/shellControllerStore.js';

/**
 * Main-process hosted workspace controller for Hucode Omni-windows.
 */
export class HucodeShellMainService extends Disposable
	implements IHucodeShellMainService {

	declare readonly _serviceBrand: undefined;
	readonly supportsWorkspaceScreenshotOverlay = true;

	private readonly _onDidChangeWindowState =
		this._register(new Emitter<IHucodeShellWindowStateChange>());
	readonly onDidChangeWindowState = this._onDidChangeWindowState.event;

	private readonly controllers = this._register(
		new ShellControllerStore(windowId => this.createController(windowId))
	);
	private readonly trustedHostedWorkspaceProcessIds = new Map<number, number>();
	private readonly trustedHostedWorkspaceWebContentsIds =
		new Map<number, number>();

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IProtocolMainService
		private readonly protocolMainService: IProtocolMainService,
		@IEnvironmentMainService
		private readonly environmentMainService: IEnvironmentMainService,
		@IThemeMainService
		private readonly themeMainService: IThemeMainService,
		@ILogService
		private readonly logService: ILogService,
		@IBrowserViewMainService
		private readonly browserViewMainService: IBrowserViewMainService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
	) {
		super();

		this._register(this.windowsMainService.onDidDestroyWindow(window => {
			this.controllers.deleteAndDispose(window.id);
		}));
	}

	isTrustedHostedWorkspaceRequest(
		processId: number,
		webContentsId?: number
	): boolean {
		return this.trustedHostedWorkspaceProcessIds.has(processId) ||
			(typeof webContentsId === 'number' &&
				this.trustedHostedWorkspaceWebContentsIds.has(webContentsId));
	}

	async getWindowState(windowId: number): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.ensureRestored();
		return controller.getState();
	}

	async findHostedWorkspaceByPath(
		worktreePath: string
	): Promise<IHucodeHostedWorkspaceOwner | undefined> {
		const omniWindows = this.windowsMainService.getWindows()
			.filter(window => window.isOmniWindow)
			.toSorted((a, b) => b.lastFocusTime - a.lastFocusTime);

		for (const window of omniWindows) {
			const controller = this.getOrCreateController(window.id);
			await controller.ensureRestored();
			const instance = controller.getState().instances.find(candidate =>
				isHostedWorkspaceRestorable(candidate) &&
				isEqual(candidate.worktreePath, worktreePath, !isLinux)
			);
			if (instance) {
				return {
					windowId: window.id,
					instanceId: instance.instanceId,
					projectId: instance.projectId,
					worktreePath: instance.worktreePath,
				};
			}
		}

		return undefined;
	}

	async focusHostedWorkspaceByPath(
		worktreePath: string,
		projectId?: string
	): Promise<boolean> {
		const owner = await this.findHostedWorkspaceByPath(worktreePath);
		if (!owner) {
			return false;
		}

		const window = this.windowsMainService.getWindowById(owner.windowId);
		if (!window?.isOmniWindow) {
			return false;
		}

		window.focus();
		await this.openWorkspace(
			owner.windowId,
			owner.worktreePath,
			projectId ?? owner.projectId
		);
		await this.focusWorkspace(owner.windowId);
		return true;
	}

	async focusNormalWindowByPath(worktreePath: string): Promise<boolean> {
		const window = findWindowOnWorkspaceOrFolder(
			this.windowsMainService.getWindows()
				.filter(window => !window.isOmniWindow),
			URI.file(worktreePath)
		);
		if (!window) {
			return false;
		}

		window.focus();
		return true;
	}

	async openWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.openWorkspace(worktreePath, projectId);
		return controller.getState();
	}

	async suspendWorkspace(
		windowId: number,
		instanceId: string,
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.suspendWorkspace(instanceId);
		return controller.getState();
	}

	async retainAndOpenWorkbench(
		windowId: number,
		folderUri: UriComponents
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.retainAndOpenWorkbench(URI.revive(folderUri));
		return controller.getState();
	}

	async unloadRetainedWorkbench(
		windowId: number,
		workbenchId: string
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.unloadRetainedWorkbench(workbenchId);
		return controller.getState();
	}

	async dismissRetainedWorkbench(
		windowId: number,
		workbenchId: string
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.dismissRetainedWorkbench(workbenchId);
		return controller.getState();
	}

	async reorderRetainedWorkbenches(
		windowId: number,
		orderedWorkbenchIds: readonly string[]
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		controller.reorderRetainedWorkbenches(orderedWorkbenchIds);
		return controller.getState();
	}

	/**
	 * Updates or resets a retained workbench label and returns the resulting
	 * Omni workspace state.
	 */
	async setRetainedWorkbenchLabel(
		windowId: number,
		workbenchId: string,
		label: string | undefined,
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		controller.setRetainedWorkbenchLabel(workbenchId, label);
		return controller.getState();
	}

	async reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
		windowId: number,
		projects: readonly IHucodeCompleteProjectCatalogEntry[]
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
			projects.map(project => ({
				projectId: project.projectId,
				folderUris: project.folderUris.map(folderUri =>
					URI.revive(folderUri)!
				),
			}))
		);
		return controller.getState();
	}

	async promoteRetainedWorkbenchProjectFolders(
		windowId: number,
		projectFolders: readonly IHucodeProjectFolderPromotion[]
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.promoteRetainedWorkbenchProjectFolders(
			projectFolders.map(folder => ({
				projectId: folder.projectId,
				folderUri: URI.revive(folder.folderUri),
			}))
		);
		return controller.getState();
	}

	async setHostedWorkbenchRestorePolicy(
		windowId: number,
		policy: HucodeHostedWorkbenchRestorePolicy
	): Promise<void> {
		this.getOrCreateController(windowId).setRestorePolicy(policy);
	}

	/**
	 * Opens files in a hosted workspace owned by an Omni shell window.
	 */
	async openFilesInWorkspace(
		windowId: number,
		worktreePath: string,
		request: INativeOpenFileRequest,
		projectId?: string
	): Promise<boolean> {
		return this.getOrCreateController(windowId).openFilesInWorkspace(
			worktreePath,
			request,
			projectId
		);
	}

	/**
	 * Opens files in the active hosted workspace owned by an Omni shell window.
	 */
	async openFilesInActiveWorkspace(
		windowId: number,
		request: INativeOpenFileRequest
	): Promise<boolean> {
		return this.getOrCreateController(windowId).openFilesInActiveWorkspace(
			request
		);
	}

	async closeWorkspace(
		windowId: number,
		instanceId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.closeWorkspace(instanceId);
		return controller.getState();
	}

	async reopenWorkspaceInNormalWindow(
		windowId: number,
		instanceId: string
	): Promise<boolean> {
		const controller = this.getOrCreateController(windowId);
		await controller.ensureRestored();
		return reopenHucodeHostedWorkspaceInNormalWindow({
			getState: () => controller.getState(),
			closeWorkspace: async targetInstanceId => {
				await controller.closeWorkspace(targetInstanceId);
			},
			focusNormalWindowByPath: worktreePath =>
				this.focusNormalWindowByPath(worktreePath),
			openNormalWindow: async worktreePath => {
				await this.windowsMainService.open({
					context: OpenContext.API,
					cli: {
						...this.environmentMainService.args,
						_: [],
					},
					urisToOpen: [{ folderUri: URI.file(worktreePath) }],
					forceNewWindow: true,
				});
			},
		}, instanceId);
	}

	async notifyHostedWorkspaceReady(
		windowId: number,
		instanceId: string
	): Promise<void> {
		this.controllers.get(windowId)?.notifyHostedWorkspaceReady(instanceId);
	}

	async focusWorkspace(windowId: number): Promise<void> {
		this.getOrCreateController(windowId).focusWorkspace();
	}

	async focusShell(windowId: number): Promise<void> {
		this.getOrCreateController(windowId).focusShell();
	}

	async setProjectsSidebarVisible(
		windowId: number,
		visible: boolean
	): Promise<void> {
		this.getOrCreateController(windowId)
			.setProjectsSidebarVisible(visible);
	}

	async setProjectSwitcherNavigationState(
		windowId: number,
		canGoBack: boolean,
		canGoForward: boolean
	): Promise<void> {
		this.getOrCreateController(windowId)
			.setProjectSwitcherNavigationState(canGoBack, canGoForward);
	}

	async setProjectSwitcherSectionOrder(
		windowId: number,
		order: readonly ProjectSwitcherOmniSection[]
	): Promise<void> {
		this.getOrCreateController(windowId)
			.setProjectSwitcherSectionOrder(order);
	}

	async runActionInShell(
		windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		return this.getOrCreateController(windowId).runActionInShell(request);
	}

	async reloadWorkspace(windowId: number): Promise<void> {
		this.getOrCreateController(windowId).reloadWorkspace();
	}

	async toggleWorkspaceDevTools(windowId: number): Promise<boolean> {
		return this.getOrCreateController(windowId).toggleWorkspaceDevTools();
	}

	async runActionInWorkspace(
		windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		return this.getOrCreateController(windowId).runActionInWorkspace(request);
	}

	async runKeybindingInWorkspace(
		windowId: number,
		request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		return this.getOrCreateController(windowId)
			.runKeybindingInWorkspace(request);
	}

	async triggerPasteInWorkspace(windowId: number): Promise<boolean> {
		return this.getOrCreateController(windowId).triggerPasteInWorkspace();
	}

	async layoutWorkspace(windowId: number, bounds: IRectangle): Promise<void> {
		this.getOrCreateController(windowId).layout(bounds);
	}

	async captureWorkspaceScreenshot(
		windowId: number,
		rect?: IRectangle,
		quality?: number
	): Promise<VSBuffer | undefined> {
		return this.getOrCreateController(windowId)
			.captureWorkspaceScreenshot(rect, quality);
	}

	async setWorkspaceOverlayOcclusion(
		windowId: number,
		occluded: boolean
	): Promise<void> {
		this.getOrCreateController(windowId)
			.setWorkspaceOverlayOcclusion(occluded);
	}

	async shutdownWindowWorkspaces(
		windowId: number,
		reason: ShutdownReason
	): Promise<void> {
		const controller = this.controllers.get(windowId);
		if (!controller) {
			return;
		}

		await controller.shutdownAllWorkspaces(
			this.toUnloadReason(reason)
		);
	}

	private toUnloadReason(reason: ShutdownReason): UnloadReason {
		switch (reason) {
			case ShutdownReason.QUIT:
				return UnloadReason.QUIT;
			case ShutdownReason.RELOAD:
				return UnloadReason.RELOAD;
			case ShutdownReason.LOAD:
				return UnloadReason.LOAD;
			case ShutdownReason.CLOSE:
			default:
				return UnloadReason.CLOSE;
		}
	}

	private getOrCreateController(
		windowId: number
	): ResidentHostedWorkspacesController {
		return this.controllers.getOrCreate(windowId);
	}

	private createController(
		windowId: number
	): ResidentHostedWorkspacesController {
		const window = this.windowsMainService.getWindowById(windowId);
		if (!window?.isOmniWindow) {
			throw new Error(`Window ${windowId} is not a Hucode Omni-window.`);
		}

		const controller =
			new ResidentHostedWorkspacesController(
				this.protocolMainService,
				this.environmentMainService,
				this.themeMainService,
				this.logService,
				this.browserViewMainService,
				window,
				processId => this.trackTrust(
					this.trustedHostedWorkspaceProcessIds,
					processId,
					1
				),
				processId => this.trackTrust(
					this.trustedHostedWorkspaceProcessIds,
					processId,
					-1
				),
				webContentsId => this.trackTrust(
					this.trustedHostedWorkspaceWebContentsIds,
					webContentsId,
					1
				),
				webContentsId => this.trackTrust(
					this.trustedHostedWorkspaceWebContentsIds,
					webContentsId,
					-1
				),
				(state: IHucodeHostedWorkspaceState) =>
					this._onDidChangeWindowState.fire({ windowId, state }),
				{
					restorePolicy: this.configurationService.getValue<
						HucodeHostedWorkbenchRestorePolicy
					>(HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING) ??
						'active',
				}
			);
		return controller;
	}

	private trackTrust(
		store: Map<number, number>,
		id: number,
		delta: 1 | -1
	): void {
		const nextValue = (store.get(id) ?? 0) + delta;
		if (nextValue <= 0) {
			store.delete(id);
			return;
		}

		store.set(id, nextValue);
	}
}
