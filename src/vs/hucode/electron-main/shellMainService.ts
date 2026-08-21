/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { Emitter, Event } from '../../base/common/event.js';
import { isEqual } from '../../base/common/extpath.js';
import {
	Disposable,
	DisposableMap,
	DisposableStore,
	toDisposable,
} from '../../base/common/lifecycle.js';
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
import { IProjectManagerMainService } from
	'../../platform/projectManager/electron-main/projectManager.js';
import { isSingleFolderWorkspaceIdentifier } from
	'../../platform/workspace/common/workspace.js';
import { IThemeMainService } from
	'../../platform/theme/electron-main/themeMainService.js';
import { IUserDataProfilesMainService } from
	'../../platform/userDataProfile/electron-main/userDataProfile.js';
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
import {
	IHucodeHostedRestoreCandidate,
	ResidentHostedWorkspacesController,
} from './hostedWorkspacesController.js';
import { findHucodeProjectWorktreeByPath } from './omniWorkspaceOpen.js';
import {
	HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING,
	HucodeHostedWorkbenchRestorePolicy,
} from
	'../common/retainedWorkbench.js';
import { ShellControllerStore } from '../common/shellControllerStore.js';
import { createHucodeHostedNavigationSnapshotWithCatalog } from
	'../common/projectSwitcher/switchProjectWorktreeModel.js';
import {
	createBoundHucodeHostedShellFacade,
	createHucodeHostedShellServerChannel,
	HUCODE_HOSTED_SHELL_CHANNEL,
	HUCODE_HOSTED_SHELL_PORT_REQUEST_CHANNEL,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellBinding,
	IHucodeHostedShellDelegate,
	IHucodeHostedShellService,
} from '../../platform/window/common/hucodeHostedShellService.js';
import {
	acceptHucodeHostedShellPortRequest,
	bindHucodeHostedShellPortLifetime,
	IHucodeHostedShellPortConnection,
} from './hostedShellPortAcceptor.js';
import {
	createHucodeShellControllerServerChannel,
	HUCODE_SHELL_CONTROLLER_CHANNEL,
	HUCODE_SHELL_CONTROLLER_PORT_REQUEST_CHANNEL,
	IHucodeShellControllerService,
	IHucodeStandaloneWorkspaceRequest,
	type HucodeStandaloneWorkspaceOpenDisposition,
} from '../../platform/window/common/hucodeShellControllerService.js';
import {
	acceptHucodeShellControllerPortRequest,
	IHucodeShellControllerPortConnection,
	IHucodeShellControllerPortOwner,
	registerHucodeShellControllerOwnerLifecycle,
} from './shellControllerPortAcceptor.js';
import {
	canonicalizeDesktopWorkbenchPath,
	createHucodeDesktopRestoreCandidates,
	createHucodeDesktopOwnershipState,
	HucodeDesktopWorkbenchOwnershipCoordinator,
	type HucodeDesktopWorkbenchRouteOutcome,
	type IHucodeDesktopWorkbenchOwnership,
	selectHucodeDesktopRestoreWinners,
	transferHucodeDesktopWorkbenchToRegularWindow,
	validateHucodeDesktopHostedOwnership,
} from './desktopWorkbenchOwnership.js';

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
	private readonly ownershipCoordinator:
		HucodeDesktopWorkbenchOwnershipCoordinator;
	private regularAdmissionId = 0;
	private ownershipBroadcastPending = false;

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IProtocolMainService
		private readonly protocolMainService: IProtocolMainService,
		@IEnvironmentMainService
		private readonly environmentMainService: IEnvironmentMainService,
		@IUserDataProfilesMainService
		private readonly userDataProfilesMainService:
			IUserDataProfilesMainService,
		@IThemeMainService
		private readonly themeMainService: IThemeMainService,
		@ILogService
		private readonly logService: ILogService,
		@IBrowserViewMainService
		private readonly browserViewMainService: IBrowserViewMainService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@IProjectManagerMainService
		private readonly projectManagerMainService: IProjectManagerMainService,
	) {
		super();
		this.ownershipCoordinator =
			new HucodeDesktopWorkbenchOwnershipCoordinator({
				onDidChange: () => this.scheduleOwnershipBroadcast(),
			});

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
		for (const window of this.windowsMainService.getWindows()) {
			this.reconcileRegularWindowOwnership(window);
		}
		this._register(this.windowsMainService.onDidSignalReadyWindow(window =>
			this.reconcileRegularWindowOwnership(window)
		));
		this._register(this.windowsMainService.onDidDestroyWindow(window =>
			this.ownershipCoordinator.releaseOwners(owner =>
				owner.windowId === window.id
			)
		));
	}

	private reconcileRegularWindowOwnership(window: ICodeWindow): void {
		if (window.isOmniWindow) {
			return;
		}
		const workspace = window.openedWorkspace;
		const resource = isSingleFolderWorkspaceIdentifier(workspace)
			? workspace.uri
			: workspace?.configPath;
		const claims = resource?.scheme === 'file'
			? [{
				path: resource.fsPath,
				owner: {
					kind: 'regular' as const,
					windowId: window.id,
				},
			}]
			: [];
		this.ownershipCoordinator.reconcile(
			owner => owner.kind === 'regular' && owner.windowId === window.id,
			claims
		);
	}

	isTrustedHostedWorkspaceRequest(
		processId: number,
		webContentsId?: number
	): boolean {
		return this.trustedHostedWorkspaceProcessIds.has(processId) ||
			(typeof webContentsId === 'number' &&
				this.trustedHostedWorkspaceWebContentsIds.has(webContentsId));
	}

	async openRegularWorkbenchWithAdmission(
		workbenchPath: string,
		openRegularWindow: () => Promise<ICodeWindow>
	): Promise<ICodeWindow> {
		for (const window of this.windowsMainService.getWindows()) {
			this.reconcileRegularWindowOwnership(window);
		}
		for (const window of this.windowsMainService.getWindows()
			.filter(candidate => candidate.isOmniWindow)) {
			await this.getOrCreateController(window.id).ensureRestored();
		}
		const pendingOwner = {
			kind: 'regular' as const,
			windowId: -(++this.regularAdmissionId),
		};
		while (true) {
			const admission = this.ownershipCoordinator.reserve(
				workbenchPath,
				pendingOwner
			);
			if (admission.kind === 'reserved-conflict') {
				await admission.settled;
				continue;
			}
			if (admission.kind === 'current-owner') {
				const owner = admission.ownership.owner;
				const window = this.windowsMainService.getWindowById(owner.windowId);
				if (owner.kind === 'regular' && window && !window.isOmniWindow) {
					window.focus();
					return window;
				}
				if (owner.kind === 'hosted') {
					const outcome = await this.routeWorkspaceOpen(
						owner.windowId,
						workbenchPath
					);
					if (outcome.kind === 'focused-hosted' ||
						outcome.kind === 'opened-hosted') {
						const omniWindow = this.windowsMainService.getWindowById(
							outcome.ownership.owner.windowId
						);
						if (omniWindow) {
							return omniWindow;
						}
					}
				}
				throw new Error(
					`Desktop workbench ownership for ${workbenchPath} is stale.`
				);
			}

			try {
				const window = await openRegularWindow();
				const reassigned = this.ownershipCoordinator.reassign(
					admission.reservation,
					{ kind: 'regular', windowId: window.id }
				);
				if (reassigned.kind !== 'reassigned' ||
					this.ownershipCoordinator.publish(
						reassigned.reservation
					).kind !== 'published') {
					throw new Error(
						`Desktop workbench open for ${workbenchPath} was superseded.`
					);
				}
				return window;
			} catch (error) {
				this.ownershipCoordinator.release(admission.reservation);
				throw error;
			}
		}
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
		connection.add(bindHucodeHostedShellPortLifetime(
			port1,
			() => controller.releaseHostedShellBinding(binding)
		));
		const client = connection.add(new MessagePortClient(
			port1,
			`hucodeHostedDesktop:${binding.instanceId}`
		));
		client.registerChannel(
			HUCODE_HOSTED_SHELL_CHANNEL,
			createHucodeHostedShellServerChannel(
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
			getNavigationSnapshot: async () =>
				createHucodeHostedNavigationSnapshotWithCatalog(
					() => controller.getState(),
					() => this.projectManagerMainService.getProjects(),
					error => this.logService.warn(
						'[hucode] Hosted navigation catalog is unavailable; ' +
						`using lifecycle-only state: ${String(error)}`
					)
				),
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
		return this.transferHostedWorkspaceToRegular(
			controller,
			binding.instanceId,
			() => controller.closeHostedShellSelf(binding)
		);
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
			createHucodeShellControllerServerChannel(
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
	): Promise<HucodeStandaloneWorkspaceOpenDisposition> {
		const folderUri = URI.revive(request.folderUri);
		if (!folderUri || folderUri.scheme !== 'file') {
			return 'failed';
		}
		const owner = await this.findHostedWorkspaceByPath(folderUri.fsPath);
		if (owner) {
			const controller = this.controllers.get(owner.windowId);
			if (!controller) {
				return 'failed';
			}
			return await this.transferHostedWorkspaceToRegular(
				controller,
				owner.instanceId,
				() => controller.closeWorkspace(owner.instanceId)
			) ? 'opened' : 'failed';
		}
		if (await this.focusNormalWindowByPath(folderUri.fsPath)) {
			return 'opened';
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
				return 'failed';
			}
		}
		return 'open-by-caller';
	}

	private scheduleOwnershipBroadcast(): void {
		if (this.ownershipBroadcastPending) {
			return;
		}
		this.ownershipBroadcastPending = true;
		queueMicrotask(() => {
			this.ownershipBroadcastPending = false;
			for (const window of this.windowsMainService.getWindows()) {
				const controller = this.controllers.get(window.id);
				if (window.isOmniWindow && controller) {
					this.fireWindowState(window.id, controller.getState());
				}
			}
		});
	}

	private fireWindowState(
		windowId: number,
		state: IHucodeHostedWorkspaceState
	): void {
		this._onDidChangeWindowState.fire({
			windowId,
			state: this.withDesktopOwnershipState(windowId, state),
		});
	}

	private withDesktopOwnershipState(
		windowId: number,
		state: IHucodeHostedWorkspaceState
	): IHucodeHostedWorkspaceState {
		return {
			...state,
			desktopOwnerships: createHucodeDesktopOwnershipState(
				windowId,
				this.ownershipCoordinator.snapshot()
			),
		};
	}

	async getWindowState(windowId: number): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.ensureRestored();
		return this.withDesktopOwnershipState(windowId, controller.getState());
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
		for (const window of this.windowsMainService.getWindows()) {
			this.reconcileRegularWindowOwnership(window);
		}
		const omniWindows = this.windowsMainService.getWindows()
			.filter(window => window.isOmniWindow)
			.toSorted((a, b) => b.lastFocusTime - a.lastFocusTime);
		for (const window of omniWindows) {
			const controller = this.getOrCreateController(window.id);
			await controller.ensureRestored();
		}

		const lookup = this.ownershipCoordinator.lookup(worktreePath);
		if (lookup.kind === 'absent' ||
			lookup.ownership.owner.kind !== 'hosted' ||
			lookup.ownership.owner.windowId === excludedWindowId) {
			return undefined;
		}
		const owner = lookup.ownership.owner;
		const controller = this.controllers.get(owner.windowId);
		const instance = validateHucodeDesktopHostedOwnership(
			this.ownershipCoordinator,
			lookup.ownership,
			controller?.getState().instances ?? []
		);
		if (!instance) {
			return undefined;
		}

		return {
			windowId: owner.windowId,
			instanceId: owner.instanceId,
			projectId: instance.projectId,
			worktreePath: instance.worktreePath,
		};
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

	private async routeWorkspaceOpen(
		windowId: number,
		worktreePath: string,
		projectId?: string,
		canApply: () => boolean = () => true
	): Promise<HucodeDesktopWorkbenchRouteOutcome> {
		try {
			for (const candidate of this.windowsMainService.getWindows()) {
				this.reconcileRegularWindowOwnership(candidate);
			}
			for (const window of this.windowsMainService.getWindows()
				.filter(candidate => candidate.isOmniWindow)) {
				await this.getOrCreateController(window.id).ensureRestored();
			}
			if (!canApply()) {
				return { kind: 'superseded' };
			}

			for (let attempt = 0; attempt < 4; attempt++) {
				const lookup = this.ownershipCoordinator.lookup(worktreePath);
				if (lookup.kind === 'absent') {
					const controller = this.getOrCreateController(windowId);
					await controller.openAdmittedWorkspace(
						worktreePath,
						projectId,
						canApply,
						canApply
					);
					if (!canApply()) {
						return { kind: 'superseded' };
					}
					const opened = this.ownershipCoordinator.lookup(worktreePath);
					if (opened.kind === 'absent') {
						return { kind: 'failed' };
					}
					if (opened.ownership.owner.kind === 'hosted' &&
						opened.ownership.owner.windowId === windowId) {
						this.focusHostedOwnership(opened.ownership);
						return {
							kind: 'opened-hosted',
							ownership: opened.ownership,
						};
					}
					continue;
				}
				if (lookup.ownership.phase === 'reserved' ||
					lookup.ownership.phase === 'transferring') {
					const pending = this.ownershipCoordinator.reserve(
						worktreePath,
						{
							kind: 'hosted',
							windowId,
							instanceId: `route:${windowId}`,
						}
					);
					if (pending.kind === 'reserved-conflict') {
						await pending.settled;
						continue;
					}
				}

				const owner = lookup.ownership.owner;
				if (owner.kind === 'regular') {
					const window = this.windowsMainService.getWindowById(
						owner.windowId
					);
					if (!window || window.isOmniWindow) {
						this.ownershipCoordinator.release({
							canonicalPath: lookup.ownership.canonicalPath,
							owner,
							generation: lookup.ownership.generation,
						});
						continue;
					}
					window.focus();
					return {
						kind: 'focused-regular',
						ownership: lookup.ownership,
					};
				}

				const controller = this.controllers.get(owner.windowId);
				const instance = validateHucodeDesktopHostedOwnership(
					this.ownershipCoordinator,
					lookup.ownership,
					controller?.getState().instances ?? []
				);
				if (!controller || !instance) {
					continue;
				}
				await controller.openAdmittedWorkspace(
					instance.worktreePath,
					projectId ?? instance.projectId,
					canApply,
					canApply
				);
				if (!canApply()) {
					return { kind: 'superseded' };
				}
				const current = this.ownershipCoordinator.lookup(worktreePath);
				if (current.kind === 'current-owner' &&
					current.ownership.owner.kind === 'hosted' &&
					current.ownership.owner.windowId === owner.windowId) {
					this.focusHostedOwnership(current.ownership);
					return {
						kind: 'focused-hosted',
						ownership: current.ownership,
					};
				}
			}
			return { kind: 'superseded' };
		} catch (error) {
			return { kind: 'failed', error };
		}
	}

	private focusHostedOwnership(
		ownership: IHucodeDesktopWorkbenchOwnership
	): void {
		if (ownership.owner.kind !== 'hosted') {
			return;
		}
		const window = this.windowsMainService.getWindowById(
			ownership.owner.windowId
		);
		const controller = this.controllers.get(ownership.owner.windowId);
		if (!window?.isOmniWindow || !controller) {
			return;
		}
		window.focus();
		controller.focusWorkspace();
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
		const outcome = await this.routeWorkspaceOpen(
			owner.windowId,
			owner.worktreePath,
			projectId ?? owner.projectId,
			canApply
		);
		if (outcome.kind === 'superseded') {
			return HucodeHostedShellOperationOutcome.Superseded;
		}
		return outcome.kind === 'failed'
			? HucodeHostedShellOperationOutcome.Rejected
			: HucodeHostedShellOperationOutcome.Accepted;
	}

	async focusNormalWindowByPath(worktreePath: string): Promise<boolean> {
		for (const candidate of this.windowsMainService.getWindows()) {
			this.reconcileRegularWindowOwnership(candidate);
		}
		const lookup = this.ownershipCoordinator.lookup(worktreePath);
		const owner = lookup.kind === 'current-owner' &&
			lookup.ownership.owner.kind === 'regular'
			? lookup.ownership.owner
			: undefined;
		const window = owner
			? this.windowsMainService.getWindowById(owner.windowId)
			: findWindowOnWorkspaceOrFolder(
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
		await this.routeWorkspaceOpen(windowId, worktreePath, projectId);
		return this.withDesktopOwnershipState(
			windowId,
			this.getOrCreateController(windowId).getState()
		);
	}

	async openAndFocusWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		await this.routeWorkspaceOpen(windowId, worktreePath, projectId);
		return this.withDesktopOwnershipState(
			windowId,
			this.getOrCreateController(windowId).getState()
		);
	}

	async suspendWorkspace(
		windowId: number,
		instanceId: string,
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.suspendWorkspace(instanceId);
		return this.withDesktopOwnershipState(windowId, controller.getState());
	}

	async retainAndOpenWorkbench(
		windowId: number,
		folderUri: UriComponents
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		controller.retainWorkbench(URI.revive(folderUri));
		await this.routeWorkspaceOpen(windowId, URI.revive(folderUri).fsPath);
		return this.withDesktopOwnershipState(windowId, controller.getState());
	}

	async unloadRetainedWorkbench(
		windowId: number,
		workbenchId: string
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.unloadRetainedWorkbench(workbenchId);
		return this.withDesktopOwnershipState(windowId, controller.getState());
	}

	async dismissRetainedWorkbench(
		windowId: number,
		workbenchId: string
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.dismissRetainedWorkbench(workbenchId);
		return this.withDesktopOwnershipState(windowId, controller.getState());
	}

	async reorderRetainedWorkbenches(
		windowId: number,
		orderedWorkbenchIds: readonly string[]
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		controller.reorderRetainedWorkbenches(orderedWorkbenchIds);
		return this.withDesktopOwnershipState(windowId, controller.getState());
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
		return this.withDesktopOwnershipState(windowId, controller.getState());
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
		return this.withDesktopOwnershipState(windowId, controller.getState());
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
		return this.withDesktopOwnershipState(windowId, controller.getState());
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
		const outcome = await this.routeWorkspaceOpen(
			windowId,
			worktreePath,
			projectId
		);
		if (outcome.kind === 'failed' || outcome.kind === 'superseded') {
			return false;
		}
		if (outcome.kind === 'focused-regular') {
			const window = this.windowsMainService.getWindowById(
				outcome.ownership.owner.windowId
			);
			if (!window || window.isOmniWindow) {
				return false;
			}
			window.sendWhenReady(
				'vscode:openFiles',
				CancellationToken.None,
				request
			);
			return true;
		}
		return this.getOrCreateController(
			outcome.ownership.owner.windowId
		).openFilesInAdmittedWorkspace(
			outcome.ownership.displayPath,
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
		return this.withDesktopOwnershipState(windowId, controller.getState());
	}

	async reopenWorkspaceInNormalWindow(
		windowId: number,
		instanceId: string
	): Promise<boolean> {
		const controller = this.getOrCreateController(windowId);
		await controller.ensureRestored();
		return this.transferHostedWorkspaceToRegular(
			controller,
			instanceId,
			() => controller.closeWorkspace(instanceId)
		);
	}

	private async transferHostedWorkspaceToRegular(
		controller: ResidentHostedWorkspacesController,
		instanceId: string,
		closeHostedOwner: () => Promise<boolean>
	): Promise<boolean> {
		const instance = controller.getState().instances.find(candidate =>
			candidate.instanceId === instanceId &&
			candidate.state !== 'crashed' &&
			candidate.state !== 'unloaded'
		);
		if (!instance) {
			return false;
		}
		const lookup = this.ownershipCoordinator.lookup(instance.worktreePath);
		if (lookup.kind !== 'current-owner' ||
			lookup.ownership.owner.kind !== 'hosted' ||
			lookup.ownership.owner.instanceId !== instanceId) {
			return false;
		}
		const outcome = await transferHucodeDesktopWorkbenchToRegularWindow({
			coordinator: this.ownershipCoordinator,
			ownership: lookup.ownership,
			closeHostedOwner,
			openRegularWindow: async () => {
				const [window] = await this.windowsMainService.open({
					context: OpenContext.API,
					cli: {
						...this.environmentMainService.args,
						_: [],
					},
					urisToOpen: [{
						folderUri: URI.file(instance.worktreePath),
					}],
					forceNewWindow: true,
					hucodeDesktopOwnershipAlreadyReserved: true,
				});
				if (!window) {
					throw new Error('Regular workbench window did not open.');
				}
				return window.id;
			},
		});
		return outcome.kind === 'transferred';
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
				this.userDataProfilesMainService,
				this.themeMainService,
				this.logService,
				this.browserViewMainService,
				window,
				this.ownershipCoordinator,
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
				async (worktreePath, canApply) => {
					const outcome = await this.routeWorkspaceOpen(
						windowId,
						worktreePath,
						undefined,
						canApply
					);
					if (outcome.kind === 'superseded') {
						return HucodeHostedShellOperationOutcome.Superseded;
					}
					return outcome.kind === 'failed'
						? HucodeHostedShellOperationOutcome.Rejected
						: HucodeHostedShellOperationOutcome.Accepted;
				},
				worktreePath => this.focusNormalWindowByPath(worktreePath),
				worktreePath =>
					this.recordLastActiveWorktreeByPath(worktreePath),
				(state: IHucodeHostedWorkspaceState) =>
					this.fireWindowState(windowId, state),
				{
					restorePolicy: this.configurationService.getValue<
						HucodeHostedWorkbenchRestorePolicy
					>(HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING) ??
						'active',
					shouldRestoreCandidate: candidate =>
						this.isRestoreCandidateWinner(windowId, candidate),
				}
			);
		return controller;
	}

	private async recordLastActiveWorktreeByPath(
		worktreePath: string
	): Promise<void> {
		const target = findHucodeProjectWorktreeByPath(
			await this.projectManagerMainService.getProjects(),
			worktreePath
		);
		if (target) {
			await this.projectManagerMainService.setLastActiveWorktree(
				target.projectId,
				target.worktreePath
			);
		}
	}

	private isRestoreCandidateWinner(
		windowId: number,
		candidate: IHucodeHostedRestoreCandidate
	): boolean {
		const candidates = this.windowsMainService.getWindows()
			.filter(window => window.isOmniWindow)
			.flatMap(window => createHucodeDesktopRestoreCandidates({
				windowId: window.id,
				windowLastFocusTime: window.lastFocusTime,
				activeWorktreePath: window.config?.omniActiveWorktreePath,
				residentWorkspaces: (
					window.config?.omniResidentWorkspaces ?? []
				).map(entry => ({
					path: entry.worktreePath,
					projectId: entry.projectId,
					lastActiveAt: entry.lastActiveAt,
				})),
				retainedWorkbenches: (
					window.config?.omniRetainedWorkbenches ?? []
				).map(record => ({
					path: URI.revive(record.folderUri).fsPath,
					id: record.id,
					desiredState: record.desiredState,
					lastActiveAt: record.lastActiveAt,
				})),
			}, (left, right) => isEqual(left, right, !isLinux)));
		const winner = Array.from(
			selectHucodeDesktopRestoreWinners(candidates).values()
		).find(entry => isEqual(
			canonicalizeDesktopWorkbenchPath(entry.path),
			canonicalizeDesktopWorkbenchPath(candidate.path),
			!isLinux
		));
		return winner?.windowId === windowId &&
			winner.stableInstanceId === candidate.stableInstanceId;
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
