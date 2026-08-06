/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter, Event } from '../../base/common/event.js';
import { isEqual } from '../../base/common/extpath.js';
import {
	Disposable,
	DisposableMap,
	DisposableStore,
	toDisposable,
} from '../../base/common/lifecycle.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { Client as MessagePortClient } from
	'../../base/parts/ipc/electron-main/ipc.mp.js';
import { validatedIpcMain } from
	'../../base/parts/ipc/electron-main/ipcMain.js';
import { MessageChannelMain } from 'electron';
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
import {
	ICodeWindow,
	UnloadReason,
} from '../../platform/window/electron-main/window.js';
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
import {
	createBoundHucodeHostedShellFacade,
	HUCODE_HOSTED_SHELL_CHANNEL,
	HUCODE_HOSTED_SHELL_PORT_REQUEST_CHANNEL,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellBinding,
	IHucodeHostedShellDelegate,
	IHucodeHostedShellService,
} from '../../platform/window/common/hucodeHostedShellService.js';
import {
	acceptHucodeHostedShellPortRequest,
	IHucodeHostedShellPortConnection,
} from './hostedShellPortAcceptor.js';
import {
	HUCODE_SHELL_CONTROLLER_CHANNEL,
	HUCODE_SHELL_CONTROLLER_PORT_REQUEST_CHANNEL,
	IHucodeShellControllerService,
	IHucodeStandaloneWorkspaceRequest,
} from '../../platform/window/common/hucodeShellControllerService.js';
import {
	acceptHucodeShellControllerPortRequest,
	IHucodeShellControllerPortConnection,
	IHucodeShellControllerPortOwner,
	registerHucodeShellControllerOwnerLifecycle,
} from './shellControllerPortAcceptor.js';

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

	private readonly controllers: ShellControllerStore<
		ICodeWindow,
		ResidentHostedWorkspacesController
	>;
	private readonly trustedHostedWorkspaceProcessIds = new Map<number, number>();
	private readonly trustedHostedWorkspaceWebContentsIds =
		new Map<number, number>();
	private readonly hostedWorkspaceOwnersByWebContentsId = new Map<
		number,
		{ readonly windowId: number; readonly instanceId: string }
	>();
	private readonly hostedShellConnections = this._register(
		new DisposableMap<number>()
	);
	private readonly shellControllerConnections = this._register(
		new DisposableMap<number>()
	);

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

		this.controllers = this._register(new ShellControllerStore(
			windowId => this.windowsMainService.getWindowById(windowId),
			(windowId, window) => this.createController(windowId, window),
			Event.map(
				this.windowsMainService.onDidDestroyWindow,
				window => window.id
			)
		));

		const onHostedShellPortRequest = (
			event: Electron.IpcMainEvent,
			nonce: unknown
		) => this.acceptHostedShellPort(event, nonce);
		validatedIpcMain.on(
			HUCODE_HOSTED_SHELL_PORT_REQUEST_CHANNEL,
			onHostedShellPortRequest
		);
		this._register(toDisposable(() => validatedIpcMain.removeListener(
			HUCODE_HOSTED_SHELL_PORT_REQUEST_CHANNEL,
			onHostedShellPortRequest
		)));

		const onShellControllerPortRequest = (
			event: Electron.IpcMainEvent,
			nonce: unknown
		) => this.acceptShellControllerPort(event, nonce);
		validatedIpcMain.on(
			HUCODE_SHELL_CONTROLLER_PORT_REQUEST_CHANNEL,
			onShellControllerPortRequest
		);
		this._register(toDisposable(() => validatedIpcMain.removeListener(
			HUCODE_SHELL_CONTROLLER_PORT_REQUEST_CHANNEL,
			onShellControllerPortRequest
		)));
		this._register(this.windowsMainService.onDidDestroyWindow(window =>
			this.shellControllerConnections.deleteAndDispose(window.id)
		));
	}

	isTrustedHostedWorkspaceRequest(
		processId: number,
		webContentsId?: number
	): boolean {
		return this.trustedHostedWorkspaceProcessIds.has(processId) ||
			(typeof webContentsId === 'number' &&
				this.trustedHostedWorkspaceWebContentsIds.has(webContentsId));
	}

	/** Accepts a sender-derived hosted-shell capability request. */
	private acceptHostedShellPort(
		event: Electron.IpcMainEvent,
		nonce: unknown
	): void {
		acceptHucodeHostedShellPortRequest({
			ownersByWebContentsId:
				this.hostedWorkspaceOwnersByWebContentsId,
			getController: windowId => this.controllers.get(windowId),
			connections: this.hostedShellConnections,
			createConnection: (controller, binding) =>
				this.createHostedShellPortConnection(controller, binding),
			logRefusal: reason => this.logService.debug(
				'[HucodeShellMainService] Refused hosted shell port: ' + reason
			),
			logFailure: error => this.logService.warn(
				'[HucodeShellMainService] Failed to transfer hosted shell port: ' +
				`${error}`
			),
		}, event, nonce);
	}

	/** Creates and owns the MessagePort connection for one bound instance. */
	private createHostedShellPortConnection(
		controller: ResidentHostedWorkspacesController,
		binding: IHucodeHostedShellBinding
	): IHucodeHostedShellPortConnection {
		const connection = new DisposableStore();
		const { port1, port2 } = new MessageChannelMain();
		let portTransferred = false;
		connection.add(toDisposable(() => {
			if (!portTransferred) {
				port2.close();
			}
		}));
		const client = connection.add(new MessagePortClient(
			port1,
			`hucodeHostedDesktop:${binding.instanceId}`
		));
		client.registerChannel(
			HUCODE_HOSTED_SHELL_CHANNEL,
			ProxyChannel.fromService(
				this.createHostedShellFacade(controller, binding),
				connection
			)
		);
		return Object.assign(connection, {
			transferPort: port2,
			markTransferred: () => portTransferred = true,
		});
	}

	/** Exposes only operations scoped to the supplied hosted-shell binding. */
	private createHostedShellFacade(
		controller: ResidentHostedWorkspacesController,
		binding: IHucodeHostedShellBinding
	): IHucodeHostedShellService {
		const delegate: IHucodeHostedShellDelegate = {
			onDidChangeState: Event.map(
				Event.filter(this.onDidChangeWindowState, change =>
					change.windowId === binding.windowId),
				() => controller.getHostedShellAuthorityState(binding)
			),
			getState: async () =>
				controller.getHostedShellAuthorityState(binding),
			notifyReady: async current => {
				controller.notifyHostedShellReady(current);
			},
			closeSelf: current => controller.closeHostedShellSelf(current),
			reopenSelfInNormalWindow: current =>
				this.reopenHostedShellSelf(controller, current),
			reloadSelf: async current =>
				controller.reloadHostedShellSelf(current),
			focusSelf: async current =>
				controller.focusHostedShellSelf(current),
			focusShell: async current =>
				controller.focusShellFromHosted(current),
			requestShellAction: async (current, action) =>
				controller.runHostedShellAction(current, action),
			navigateToFolder: (current, request, authorization) =>
				controller.navigateHostedShellToFolder(
					current,
					request,
					authorization
				),
			triggerPasteInSelf: async current =>
				controller.triggerPasteInHostedShellSelf(current),
			captureSelfScreenshot: (current, rect, quality) =>
				controller.captureHostedShellSelfScreenshot(
					current,
					rect,
					quality
				),
		};
		return createBoundHucodeHostedShellFacade(binding, delegate);
	}

	/** Reopens only the workspace identified by the bound capability. */
	private async reopenHostedShellSelf(
		controller: ResidentHostedWorkspacesController,
		binding: IHucodeHostedShellBinding
	): Promise<boolean> {
		if (controller.getHostedShellAuthorityState(binding).disposed) {
			return false;
		}
		return reopenHucodeHostedWorkspaceInNormalWindow({
			getState: () => controller.getState(),
			closeWorkspace: async targetInstanceId => {
				if (targetInstanceId === binding.instanceId) {
					await controller.closeHostedShellSelf(binding);
				}
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
		}, binding.instanceId);
	}

	/** Accepts a privileged port only from an Omni shell's owner renderer. */
	private acceptShellControllerPort(
		event: Electron.IpcMainEvent,
		nonce: unknown
	): void {
		acceptHucodeShellControllerPortRequest({
			resolveOwner: sender => this.resolveShellControllerPortOwner(sender),
			connections: this.shellControllerConnections,
			createConnection: owner =>
				this.createShellControllerPortConnection(owner),
			logRefusal: reason => this.logService.debug(
				'[HucodeShellMainService] Refused shell controller port: ' +
				reason
			),
			logFailure: error => this.logService.warn(
				'[HucodeShellMainService] Failed to transfer shell controller ' +
				`port: ${error}`
			),
		}, event, nonce);
	}

	private resolveShellControllerPortOwner(
		sender: Electron.WebContents
	): IHucodeShellControllerPortOwner | undefined {
		const window = this.windowsMainService.getWindowByWebContents(sender);
		if (!window?.isOmniWindow ||
			window.win?.webContents.id !== sender.id) {
			return undefined;
		}
		return { windowId: window.id, webContentsId: sender.id };
	}

	/** Creates one owner-bound privileged port and its reload/crash cleanup. */
	private createShellControllerPortConnection(
		owner: IHucodeShellControllerPortOwner
	): IHucodeShellControllerPortConnection {
		const window = this.windowsMainService.getWindowById(owner.windowId);
		const webContents = window?.win?.webContents;
		if (!window?.isOmniWindow || !webContents ||
			webContents.id !== owner.webContentsId || webContents.isDestroyed()) {
			throw new Error('Omni shell owner is no longer available.');
		}

		const connection = new DisposableStore();
		const disposeConnection = () =>
			this.shellControllerConnections.deleteAndDispose(owner.windowId);
		connection.add(registerHucodeShellControllerOwnerLifecycle(
			webContents,
			disposeConnection
		));

		const { port1, port2 } = new MessageChannelMain();
		let portTransferred = false;
		connection.add(toDisposable(() => {
			if (!portTransferred) {
				port2.close();
			}
		}));
		const client = connection.add(new MessagePortClient(
			port1,
			`hucodeShellController:${owner.windowId}`
		));
		client.registerChannel(
			HUCODE_SHELL_CONTROLLER_CHANNEL,
			ProxyChannel.fromService(
				this.createShellControllerFacade(owner.windowId),
				connection
			)
		);
		return Object.assign(connection, {
			transferPort: port2,
			markTransferred: () => portTransferred = true,
		});
	}

	/** Maps the no-identity wire contract onto one authoritative shell window. */
	private createShellControllerFacade(
		windowId: number
	): IHucodeShellControllerService {
		return {
			_serviceBrand: undefined,
			supportsWorkspaceScreenshotOverlay: true,
			onDidChangeState: Event.map(
				Event.filter(this.onDidChangeWindowState, change =>
					change.windowId === windowId),
				change => change.state
			),
			getState: () => this.getWindowState(windowId),
			// These searches intentionally span windows so existing workbenches are
			// reused instead of duplicated in the requesting shell.
			focusHostedWorkspaceByPath: (path, projectId) =>
				this.focusHostedWorkspaceByPath(path, projectId),
			focusNormalWindowByPath: path =>
				this.focusNormalWindowByPath(path),
			openWorkspace: (path, projectId) =>
				this.openWorkspace(windowId, path, projectId),
			openAndFocusWorkspace: (path, projectId) =>
				this.openAndFocusWorkspace(windowId, path, projectId),
			suspendWorkspace: instanceId =>
				this.suspendWorkspace(windowId, instanceId),
			retainAndOpenWorkbench: folderUri =>
				this.retainAndOpenWorkbench(windowId, folderUri),
			unloadRetainedWorkbench: workbenchId =>
				this.unloadRetainedWorkbench(windowId, workbenchId),
			dismissRetainedWorkbench: workbenchId =>
				this.dismissRetainedWorkbench(windowId, workbenchId),
			reorderRetainedWorkbenches: ids =>
				this.reorderRetainedWorkbenches(windowId, ids),
			setRetainedWorkbenchLabel: (workbenchId, label) =>
				this.setRetainedWorkbenchLabel(windowId, workbenchId, label),
			reconcileRetainedWorkbenchesWithCompleteProjectCatalog: projects =>
				this.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
					windowId,
					projects
				),
			promoteRetainedWorkbenchProjectFolders: projectFolders =>
				this.promoteRetainedWorkbenchProjectFolders(
					windowId,
					projectFolders
				),
			setHostedWorkbenchRestorePolicy: policy =>
				this.setHostedWorkbenchRestorePolicy(windowId, policy),
			openFilesInWorkspace: (path, request, projectId) =>
				this.openFilesInWorkspace(windowId, path, request, projectId),
			openFilesInActiveWorkspace: request =>
				this.openFilesInActiveWorkspace(windowId, request),
			closeWorkspace: instanceId =>
				this.closeWorkspace(windowId, instanceId),
			reopenWorkspaceInNormalWindow: instanceId =>
				this.reopenWorkspaceInNormalWindow(windowId, instanceId),
			prepareWorkspaceForStandaloneOpen: request =>
				this.prepareWorkspaceForStandaloneOpen(windowId, request),
			focusWorkspace: () => this.focusWorkspace(windowId),
			focusShell: () => this.focusShell(windowId),
			setProjectsSidebarVisible: visible =>
				this.setProjectsSidebarVisible(windowId, visible),
			setProjectSwitcherNavigationState: (canGoBack, canGoForward) =>
				this.setProjectSwitcherNavigationState(
					windowId,
					canGoBack,
					canGoForward
				),
			setProjectSwitcherSectionOrder: order =>
				this.setProjectSwitcherSectionOrder(windowId, order),
			runActionInWorkspace: request =>
				this.runActionInWorkspace(windowId, request),
			runKeybindingInWorkspace: request =>
				this.runKeybindingInWorkspace(windowId, request),
			triggerPasteInWorkspace: () =>
				this.triggerPasteInWorkspace(windowId),
			reloadWorkspace: () => this.reloadWorkspace(windowId),
			toggleWorkspaceDevTools: () =>
				this.toggleWorkspaceDevTools(windowId),
			layoutWorkspace: bounds => this.layoutWorkspace(windowId, bounds),
			captureWorkspaceScreenshot: (rect, quality) =>
				this.captureWorkspaceScreenshot(windowId, rect, quality),
			setWorkspaceOverlayOcclusion: occluded =>
				this.setWorkspaceOverlayOcclusion(windowId, occluded),
			shutdownWindowWorkspaces: reason =>
				this.shutdownWindowWorkspaces(windowId, reason),
		};
	}

	/** Releases any hosted owner before the shell opens a path standalone. */
	private async prepareWorkspaceForStandaloneOpen(
		windowId: number,
		request: IHucodeStandaloneWorkspaceRequest
	): Promise<boolean> {
		const folderUri = URI.revive(request.folderUri);
		if (!folderUri || folderUri.scheme !== 'file') {
			return false;
		}
		if (request.retainedWorkbenchId) {
			const state = await this.unloadRetainedWorkbench(
				windowId,
				request.retainedWorkbenchId
			);
			const retained = state.retainedWorkbenches?.find(record =>
				record.id === request.retainedWorkbenchId
			);
			if (retained && retained.desiredState !== 'unloaded') {
				return false;
			}
		}

		const owner = await this.findHostedWorkspaceByPath(folderUri.fsPath);
		if (!owner) {
			return true;
		}
		const state = await this.closeWorkspace(
			owner.windowId,
			owner.instanceId
		);
		return !state.instances.some(instance =>
			instance.instanceId === owner.instanceId
		);
	}

	async getWindowState(windowId: number): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.ensureRestored();
		return controller.getState();
	}

	async findHostedWorkspaceByPath(
		worktreePath: string
	): Promise<IHucodeHostedWorkspaceOwner | undefined> {
		return this.findHostedWorkspaceByPathInWindows(worktreePath);
	}

	private async findHostedWorkspaceByPathInWindows(
		worktreePath: string,
		excludedWindowId?: number
	): Promise<IHucodeHostedWorkspaceOwner | undefined> {
		const omniWindows = this.windowsMainService.getWindows()
			.filter(window => window.isOmniWindow &&
				window.id !== excludedWindowId)
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
		return await this.focusHostedWorkspaceByPathWithContinuation(
			worktreePath,
			projectId,
			() => true
		) === HucodeHostedShellOperationOutcome.Accepted;
	}

	private async focusHostedWorkspaceByPathWithContinuation(
		worktreePath: string,
		projectId: string | undefined,
		canApply: () => boolean,
		excludedWindowId?: number
	): Promise<HucodeHostedShellOperationOutcome> {
		const owner = await this.findHostedWorkspaceByPathInWindows(
			worktreePath,
			excludedWindowId
		);
		if (!owner) {
			return HucodeHostedShellOperationOutcome.Unavailable;
		}
		if (!canApply()) {
			return HucodeHostedShellOperationOutcome.Superseded;
		}

		const window = this.windowsMainService.getWindowById(owner.windowId);
		if (!window?.isOmniWindow) {
			return HucodeHostedShellOperationOutcome.Superseded;
		}

		const controller = this.getOrCreateController(owner.windowId);
		await controller.openWorkspace(
			owner.worktreePath,
			projectId ?? owner.projectId,
			canApply,
			canApply
		);
		if (!canApply() ||
			controller.getState().activeInstanceId !== owner.instanceId) {
			return HucodeHostedShellOperationOutcome.Superseded;
		}

		window.focus();
		controller.focusWorkspace();
		return HucodeHostedShellOperationOutcome.Accepted;
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

	async openAndFocusWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.openWorkspace(worktreePath, projectId);
		const state = controller.getState();
		const active = state.instances.find(instance =>
			instance.instanceId === state.activeInstanceId
		);
		if (
			active &&
			isEqual(active.worktreePath, worktreePath, !isLinux)
		) {
			controller.focusWorkspace();
		}
		return state;
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
		windowId: number,
		window: ICodeWindow
	): ResidentHostedWorkspacesController {
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
				(webContentsId, instanceId) => {
					this.trackTrust(
						this.trustedHostedWorkspaceWebContentsIds,
						webContentsId,
						1
					);
					this.hostedWorkspaceOwnersByWebContentsId.set(
						webContentsId,
						{ windowId, instanceId }
					);
				},
				(webContentsId, instanceId) => {
					this.trackTrust(
						this.trustedHostedWorkspaceWebContentsIds,
						webContentsId,
						-1
					);
					const owner =
						this.hostedWorkspaceOwnersByWebContentsId.get(
							webContentsId
						);
					if (owner?.windowId === windowId &&
						owner.instanceId === instanceId) {
						this.hostedWorkspaceOwnersByWebContentsId.delete(
							webContentsId
						);
					}
					this.hostedShellConnections.deleteAndDispose(
						webContentsId
					);
				},
				webContentsId => this.hostedShellConnections.deleteAndDispose(
					webContentsId
				),
				(worktreePath, canApply) =>
					this.focusHostedWorkspaceByPathWithContinuation(
						worktreePath,
						undefined,
						canApply,
						windowId
					),
				worktreePath => this.focusNormalWindowByPath(worktreePath),
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
