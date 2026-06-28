/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { generateUuid } from '../../base/common/uuid.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import {
	INativeOpenFileRequest,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
	IRectangle,
} from '../../platform/window/common/window.js';
import {
	CLOSE_WORKSPACE_COMMAND_ID,
	FOCUS_PROJECT_PANE_COMMAND_ID,
	FOCUS_WORKSPACE_COMMAND_ID,
	RELOAD_WORKSPACE_COMMAND_ID,
	UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import { ShutdownReason } from
	'../../workbench/services/lifecycle/common/lifecycle.js';
import { IBrowserWorkbenchEnvironmentService } from
	'../../workbench/services/environment/browser/environmentService.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeHostedWorkspaceOwner,
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
	IHucodeShellWindowStateChange,
} from '../common/omniWindow.js';
import {
	getMostRecentHostedWorkspace,
	hasLoadedHostedWorkspace,
	HostedWorkspaceStateModel,
	isHostedWorkspaceAvailable,
	waitForHostedWorkspaceReady,
} from '../common/hostedWorkspaceState.js';
import { reopenHucodeHostedWorkspaceInNormalWindow } from
	'../common/omniWorkspaceReopen.js';
import {
	HucodeOmniWebChildMessage,
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
	IHucodeOmniWebShellRequestMessage,
} from '../../platform/window/common/hucodeOmniWebMessages.js';
import {
	getHucodeOmniWorkbenchRoute,
	getHucodeServerPathCaseSensitive,
} from '../../platform/environment/common/hucodeWebConfiguration.js';
import { getProjectManagerPathComparisonKey } from
	'../../platform/projectManager/common/projectManagerState.js';
import { IHucodeWebOmniHostSurfaceService } from
	'./webOmniHostSurfaceService.js';

interface IHostedIframeInstance {
	instanceId: string;
	projectId?: string;
	worktreePath: string;
	state: HucodeHostedWorkbenchLifecycleState;
	iframe: HTMLIFrameElement;
	visible: boolean;
	focused: boolean;
	lastActiveAt?: number;
}

/**
 * Browser implementation of the Hucode Omni shell service.
 */
export class WebHucodeShellService extends Disposable
	implements IHucodeShellService {

	declare readonly _serviceBrand: undefined;
	readonly supportsWorkspaceScreenshotOverlay = false;
	private static readonly READY_TIMEOUT_MS = 30000;

	private readonly windowId = getWindowId(mainWindow);
	private readonly workbenchRoute: string;
	private readonly serverPathCaseSensitive: boolean;
	private readonly hostedWorkspaces: HostedWorkspaceStateModel<
		IHostedIframeInstance
	>;
	private readonly pendingUnload = new Map<string, () => void>();
	private readonly pendingCommands = new Map<string, (ok: boolean) => void>();

	private readonly _onDidChangeWindowState =
		this._register(new Emitter<IHucodeShellWindowStateChange>());
	readonly onDidChangeWindowState = this._onDidChangeWindowState.event;

	constructor(
		@IBrowserWorkbenchEnvironmentService
		environmentService: IBrowserWorkbenchEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
		@IHucodeWebOmniHostSurfaceService
		private readonly hostSurfaceService: IHucodeWebOmniHostSurfaceService,
	) {
		super();

		this.workbenchRoute = getHucodeOmniWorkbenchRoute(
			environmentService.options
		);
		this.serverPathCaseSensitive = getHucodeServerPathCaseSensitive(
			environmentService.options
		);
		this.hostedWorkspaces = new HostedWorkspaceStateModel(
			path => this.toPathKey(path)
		);
		this._register(this.hostSurfaceService.onDidChangeSurface(surface => {
			if (surface) {
				this.attachIframes(surface);
			}
		}));
		this._register(toDisposable(() => {
			mainWindow.removeEventListener('message', this.onMessage);
		}));
		mainWindow.addEventListener('message', this.onMessage);
	}

	async getWindowState(
		windowId: number
	): Promise<IHucodeHostedWorkspaceState> {
		return windowId === this.windowId ? this.getState() : emptyState();
	}

	async findHostedWorkspaceByPath(
		worktreePath: string
	): Promise<IHucodeHostedWorkspaceOwner | undefined> {
		const instance = this.getAvailableInstanceByPath(worktreePath);
		return instance
			? {
				windowId: this.windowId,
				instanceId: instance.instanceId,
				projectId: instance.projectId,
				worktreePath: instance.worktreePath,
			}
			: undefined;
	}

	async focusHostedWorkspaceByPath(
		worktreePath: string,
		projectId?: string
	): Promise<boolean> {
		const instance = this.getAvailableInstanceByPath(worktreePath);
		if (!instance) {
			return false;
		}

		instance.projectId = projectId ?? instance.projectId;
		this.activateInstance(instance);
		this.focusIframe(instance);
		return true;
	}

	async focusNormalWindowByPath(_worktreePath: string): Promise<boolean> {
		return false;
	}

	async openWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		if (windowId !== this.windowId) {
			return this.getState();
		}

		const existing = this.getInstanceByPath(worktreePath);
		if (existing) {
			if (isHostedWorkspaceAvailable(existing)) {
				existing.projectId = projectId ?? existing.projectId;
				this.activateInstance(existing);
				return this.getState();
			}

			this.removeInstance(existing);
		}

		const instance = this.createInstance(worktreePath, projectId);
		this.hostedWorkspaces.addInstance(instance);
		this.attachIframe(instance);
		this.activateInstance(instance);
		return this.getState();
	}

	async openFilesInWorkspace(
		windowId: number,
		worktreePath: string,
		request: INativeOpenFileRequest,
		projectId?: string
	): Promise<boolean> {
		if (windowId !== this.windowId) {
			return false;
		}

		await this.openWorkspace(windowId, worktreePath, projectId);

		const instance = this.getAvailableInstanceByPath(worktreePath);
		if (!instance || instance.instanceId !== this.activeInstanceId) {
			return false;
		}

		return this.openFilesInInstance(instance, request);
	}

	async openFilesInActiveWorkspace(
		windowId: number,
		request: INativeOpenFileRequest
	): Promise<boolean> {
		if (windowId !== this.windowId) {
			return false;
		}

		const instance = this.getAvailableActiveInstance();
		return instance
			? this.openFilesInInstance(instance, request)
			: false;
	}

	async closeWorkspace(
		windowId: number,
		instanceId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		if (windowId !== this.windowId) {
			return this.getState();
		}

		const instance = instanceId
			? this.instancesById.get(instanceId)
			: this.getActiveInstance();
		if (!instance) {
			return this.getState();
		}

		await this.requestUnload(instance);
		this.removeInstance(instance);
		return this.getState();
	}

	async reopenWorkspaceInNormalWindow(
		windowId: number,
		instanceId: string
	): Promise<boolean> {
		if (windowId !== this.windowId) {
			return false;
		}

		return reopenHucodeHostedWorkspaceInNormalWindow({
			getState: () => this.getState(),
			closeWorkspace: targetInstanceId =>
				this.closeWorkspace(this.windowId, targetInstanceId),
			focusNormalWindowByPath: worktreePath =>
				this.focusNormalWindowByPath(worktreePath),
			openNormalWindow: worktreePath => {
				mainWindow.open(this.toNormalWorkbenchUrl(worktreePath));
			},
		}, instanceId);
	}

	async notifyHostedWorkspaceReady(
		windowId: number,
		instanceId: string
	): Promise<void> {
		if (windowId !== this.windowId) {
			return;
		}

		const instance = this.instancesById.get(instanceId);
		if (!instance || !isHostedWorkspaceAvailable(instance)) {
			return;
		}

		this.hostedWorkspaces.markInstanceReady(instance);
		this.emitState();
	}

	async focusWorkspace(_windowId: number): Promise<void> {
		const instance = this.getAvailableActiveInstance();
		if (instance) {
			this.focusIframe(instance);
		}
	}

	async focusShell(_windowId: number): Promise<void> {
		await this.commandService.executeCommand(FOCUS_PROJECT_PANE_COMMAND_ID);
	}

	async setProjectsSidebarVisible(
		_windowId: number,
		visible: boolean
	): Promise<void> {
		this.hostedWorkspaces.setProjectsSidebarVisible(
			visible,
			hasLoadedHostedWorkspace(this.instancesById.values())
		);
		this.emitState();
	}

	async setProjectSwitcherNavigationState(
		_windowId: number,
		canGoBack: boolean,
		canGoForward: boolean
	): Promise<void> {
		if (!this.hostedWorkspaces.setProjectSwitcherNavigationState(
			canGoBack,
			canGoForward
		)) {
			return;
		}

		this.emitState();
	}

	async runActionInShell(
		_windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		await this.commandService.executeCommand(
			request.id,
			...(request.args ?? [])
		);
		return true;
	}

	async runActionInWorkspace(
		_windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		return this.postCommandToActive(request.id, request.args ?? []);
	}

	async runKeybindingInWorkspace(
		_windowId: number,
		_request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		this.getAvailableActiveInstance()?.iframe.contentWindow?.focus();
		return false;
	}

	async triggerPasteInWorkspace(_windowId: number): Promise<boolean> {
		this.getAvailableActiveInstance()?.iframe.contentWindow?.focus();
		return false;
	}

	async reloadWorkspace(_windowId: number): Promise<void> {
		const instance = this.getAvailableActiveInstance();
		if (!instance) {
			return;
		}

		instance.state = 'loading';
		void this.postCommand(instance, 'workbench.action.reloadWindow', []);
		mainWindow.setTimeout(() => {
			if (instance.state === 'loading') {
				instance.iframe.contentWindow?.location.reload();
			}
		}, 500);
		this.emitState();
	}

	async toggleWorkspaceDevTools(_windowId: number): Promise<boolean> {
		return false;
	}

	async layoutWorkspace(
		_windowId: number,
		_bounds: IRectangle
	): Promise<void> {
		this.applyIframeLayout();
	}

	async captureWorkspaceScreenshot(
		_windowId: number,
		_rect?: IRectangle,
		_quality?: number
	): Promise<VSBuffer | undefined> {
		return undefined;
	}

	async setWorkspaceOverlayOcclusion(
		_windowId: number,
		_occluded: boolean
	): Promise<void> {
		// Web overlays are normal DOM and can layer above same-origin iframes.
	}

	async shutdownWindowWorkspaces(
		windowId: number,
		_reason: ShutdownReason
	): Promise<void> {
		if (windowId !== this.windowId) {
			return;
		}

		for (const instance of [...this.instancesById.values()]) {
			await this.requestUnload(instance);
			this.removeInstance(instance);
		}
	}

	private readonly onMessage = (event: MessageEvent): void => {
		if (
			event.origin !== mainWindow.location.origin ||
			!isHucodeOmniWebChildMessage(event.data)
		) {
			return;
		}

		const instance = this.instancesById.get(event.data.instanceId);
		if (!instance || event.source !== instance.iframe.contentWindow) {
			return;
		}

		this.handleChildMessage(event.data);
	};

	private handleChildMessage(message: HucodeOmniWebChildMessage): void {
		const instance = this.instancesById.get(message.instanceId);
		if (!instance) {
			return;
		}

		switch (message.type) {
			case HucodeOmniWebChildMessageType.UnloadReady:
				this.pendingUnload.get(message.instanceId)?.();
				break;
			case HucodeOmniWebChildMessageType.CommandResult:
				this.resolvePendingCommand(
					message.instanceId,
					message.requestId,
					message.ok
				);
				if (instance.state === 'loading') {
					instance.state = message.ok ? 'loaded' : 'crashed';
					this.emitState();
				}
				break;
			case HucodeOmniWebChildMessageType.Ready:
				if (!isHostedWorkspaceAvailable(instance)) {
					return;
				}
				void this.notifyHostedWorkspaceReady(
					this.windowId,
					message.instanceId
				);
				break;
			case HucodeOmniWebChildMessageType.Focus:
				if (!isHostedWorkspaceAvailable(instance)) {
					return;
				}
				instance.focused = message.focused;
				if (message.focused) {
					this.activateInstance(instance);
				} else {
					this.emitState();
				}
				break;
			case HucodeOmniWebChildMessageType.ShellCommand:
				if (!isHostedWorkspaceAvailable(instance)) {
					return;
				}
				void this.handleShellCommand(instance, message.commandId);
				break;
			case HucodeOmniWebChildMessageType.ShellRequest:
				if (!isHostedWorkspaceAvailable(instance)) {
					return;
				}
				void this.handleShellRequest(instance, message);
				break;
		}
	}

	private async handleShellCommand(
		instance: IHostedIframeInstance,
		commandId: string
	): Promise<void> {
		switch (commandId) {
			case FOCUS_PROJECT_PANE_COMMAND_ID:
				await this.focusShell(this.windowId);
				break;
			case FOCUS_WORKSPACE_COMMAND_ID:
				this.activateInstance(instance);
				this.focusIframe(instance);
				break;
			case RELOAD_WORKSPACE_COMMAND_ID:
				await this.reloadWorkspace(this.windowId);
				break;
			case CLOSE_WORKSPACE_COMMAND_ID:
			case UNLOAD_CURRENT_WORKTREE_COMMAND_ID:
				await this.closeWorkspace(this.windowId, instance.instanceId);
				break;
			default:
				await this.commandService.executeCommand(commandId);
				break;
		}
	}

	private createInstance(
		worktreePath: string,
		projectId: string | undefined
	): IHostedIframeInstance {
		const instanceId = generateUuid();
		const iframe = document.createElement('iframe');
		iframe.className = 'hucode-omni-host-iframe hidden';
		iframe.title = worktreePath;
		iframe.dataset.hucodeHostedInstanceId = instanceId;
		iframe.src = this.toWorkbenchUrl(instanceId, worktreePath);

		return {
			instanceId,
			projectId,
			worktreePath,
			state: 'loading',
			iframe,
			visible: false,
			focused: false,
			lastActiveAt: Date.now(),
		};
	}

	private activateInstance(instance: IHostedIframeInstance): void {
		this.hostedWorkspaces.activateInstance(instance);
		for (const candidate of this.instancesById.values()) {
			const visible = candidate.instanceId === instance.instanceId;
			candidate.visible = visible;
			candidate.focused = visible ? candidate.focused : false;
			candidate.iframe.classList.toggle('hidden', !visible);
		}
		this.emitState();
	}

	private removeInstance(instance: IHostedIframeInstance): void {
		const wasActive = this.activeInstanceId === instance.instanceId;
		instance.state = 'unloaded';
		instance.iframe.remove();
		this.hostedWorkspaces.removeInstance(instance);
		if (wasActive) {
			const next = getMostRecentHostedWorkspace(this.instancesById.values());
			if (next) {
				this.activateInstance(next);
				return;
			}
		}
		this.emitState();
	}

	private requestUnload(instance: IHostedIframeInstance): Promise<void> {
		return new Promise(resolve => {
			const handle = mainWindow.setTimeout(() => {
				this.pendingUnload.delete(instance.instanceId);
				resolve();
			}, 1500);
			this.pendingUnload.set(instance.instanceId, () => {
				mainWindow.clearTimeout(handle);
				this.pendingUnload.delete(instance.instanceId);
				resolve();
			});
			instance.iframe.contentWindow?.postMessage({
				type: HucodeOmniWebParentMessageType.BeforeUnload,
				instanceId: instance.instanceId,
			}, mainWindow.location.origin);
		});
	}

	private postCommandToActive(
		commandId: string,
		args: readonly unknown[]
	): Promise<boolean> {
		const instance = this.getAvailableActiveInstance();
		if (!instance) {
			return Promise.resolve(false);
		}

		return this.postCommand(instance, commandId, args);
	}

	private async openFilesInInstance(
		instance: IHostedIframeInstance,
		request: INativeOpenFileRequest
	): Promise<boolean> {
		if (!await this.waitForInstanceReady(instance)) {
			return false;
		}

		return this.postCommand(instance, 'vscode:openFiles', [request]);
	}

	private waitForInstanceReady(instance: IHostedIframeInstance): Promise<boolean> {
		return waitForHostedWorkspaceReady(
			instance,
			this.onDidChangeWindowState,
			WebHucodeShellService.READY_TIMEOUT_MS
		);
	}

	private postCommand(
		instance: IHostedIframeInstance,
		commandId: string,
		args: readonly unknown[]
	): Promise<boolean> {
		const requestId = generateUuid();
		const targetWindow = instance.iframe.contentWindow;
		if (!targetWindow) {
			return Promise.resolve(false);
		}

		return new Promise(resolve => {
			const key = this.toPendingRequestKey(instance.instanceId, requestId);
			const handle = mainWindow.setTimeout(() => {
				this.pendingCommands.delete(key);
				resolve(false);
			}, 5000);
			this.pendingCommands.set(key, ok => {
				mainWindow.clearTimeout(handle);
				resolve(ok);
			});
			targetWindow.postMessage({
				type: HucodeOmniWebParentMessageType.RunCommand,
				instanceId: instance.instanceId,
				requestId,
				commandId,
				args,
			}, mainWindow.location.origin);
		});
	}

	private resolvePendingCommand(
		instanceId: string,
		requestId: string | undefined,
		ok: boolean
	): void {
		if (!requestId) {
			return;
		}

		const key = this.toPendingRequestKey(instanceId, requestId);
		const resolve = this.pendingCommands.get(key);
		if (!resolve) {
			return;
		}

		this.pendingCommands.delete(key);
		resolve(ok);
	}

	private async handleShellRequest(
		instance: IHostedIframeInstance,
		message: IHucodeOmniWebShellRequestMessage
	): Promise<void> {
		try {
			const result = await this.runShellRequest(instance, message);
			this.postShellResponse(instance, message.requestId, true, result);
		} catch (error) {
			this.postShellResponse(
				instance,
				message.requestId,
				false,
				undefined,
				error instanceof Error ? error.message : String(error)
			);
		}
	}

	private async runShellRequest(
		instance: IHostedIframeInstance,
		message: IHucodeOmniWebShellRequestMessage
	): Promise<unknown> {
		const args = Array.isArray(message.args) ? message.args : [];
		switch (message.method) {
			case 'getWindowState':
				return this.getState();
			case 'findHostedWorkspaceByPath':
				return this.findHostedWorkspaceByPath(getStringArg(args, 0));
			case 'focusHostedWorkspaceByPath':
				return this.focusHostedWorkspaceByPath(
					getStringArg(args, 0),
					getOptionalStringArg(args, 1)
				);
			case 'focusNormalWindowByPath':
				return this.focusNormalWindowByPath(getStringArg(args, 0));
			case 'openWorkspace':
				return this.openWorkspace(
					this.windowId,
					getStringArg(args, 1),
					getOptionalStringArg(args, 2)
				);
			case 'openFilesInWorkspace':
				return this.openFilesInWorkspace(
					this.windowId,
					getStringArg(args, 1),
					args[2] as INativeOpenFileRequest,
					getOptionalStringArg(args, 3)
				);
			case 'openFilesInActiveWorkspace':
				return this.openFilesInActiveWorkspace(
					this.windowId,
					args[1] as INativeOpenFileRequest
				);
			case 'closeWorkspace':
				return this.closeWorkspace(
					this.windowId,
					instance.instanceId
				);
			case 'reopenWorkspaceInNormalWindow':
				return this.reopenWorkspaceInNormalWindow(
					this.windowId,
					instance.instanceId
				);
			case 'notifyHostedWorkspaceReady':
				return this.notifyHostedWorkspaceReady(
					this.windowId,
					instance.instanceId
				);
			case 'focusWorkspace':
				return this.focusWorkspace(this.windowId);
			case 'focusShell':
				return this.focusShell(this.windowId);
			case 'setProjectsSidebarVisible':
				return this.setProjectsSidebarVisible(
					this.windowId,
					args[1] === true
				);
			case 'setProjectSwitcherNavigationState':
				return this.setProjectSwitcherNavigationState(
					this.windowId,
					args[1] === true,
					args[2] === true
				);
			case 'runActionInShell':
				return this.runActionInShell(
					this.windowId,
					args[1] as INativeRunActionInWindowRequest
				);
			case 'runActionInWorkspace':
				return this.runActionInWorkspace(
					this.windowId,
					args[1] as INativeRunActionInWindowRequest
				);
			case 'runKeybindingInWorkspace':
				return this.runKeybindingInWorkspace(
					this.windowId,
					args[1] as INativeRunKeybindingInWindowRequest
				);
			case 'triggerPasteInWorkspace':
				return this.triggerPasteInWorkspace(this.windowId);
			case 'reloadWorkspace':
				return this.reloadWorkspace(this.windowId);
			case 'toggleWorkspaceDevTools':
				return this.toggleWorkspaceDevTools(this.windowId);
			case 'layoutWorkspace':
				return this.layoutWorkspace(this.windowId, args[1] as IRectangle);
			case 'captureWorkspaceScreenshot':
				return undefined;
			case 'setWorkspaceOverlayOcclusion':
				return this.setWorkspaceOverlayOcclusion(
					this.windowId,
					args[1] === true
				);
			case 'shutdownWindowWorkspaces':
				return this.shutdownWindowWorkspaces(
					this.windowId,
					args[1] as ShutdownReason
				);
			default:
				throw new Error(`Unsupported shell request: ${message.method}`);
		}
	}

	private postShellResponse(
		instance: IHostedIframeInstance,
		requestId: string,
		ok: boolean,
		result?: unknown,
		error?: string
	): void {
		instance.iframe.contentWindow?.postMessage({
			type: HucodeOmniWebParentMessageType.ShellResponse,
			instanceId: instance.instanceId,
			requestId,
			ok,
			result,
			error,
		}, mainWindow.location.origin);
	}

	private focusIframe(instance: IHostedIframeInstance): void {
		instance.iframe.focus();
		instance.iframe.contentWindow?.focus();
	}

	private attachIframes(surface: HTMLElement): void {
		for (const instance of this.instancesById.values()) {
			if (instance.iframe.parentElement !== surface) {
				surface.append(instance.iframe);
			}
		}
		this.applyIframeLayout();
	}

	private attachIframe(instance: IHostedIframeInstance): void {
		const surface = this.hostSurfaceService.getSurface();
		if (surface) {
			surface.append(instance.iframe);
			this.applyIframeLayout();
		}
	}

	private applyIframeLayout(): void {
		const surface = this.hostSurfaceService.getSurface();
		if (!surface) {
			return;
		}

		for (const instance of this.instancesById.values()) {
			instance.iframe.style.width = '';
			instance.iframe.style.height = '';
		}
	}

	private toWorkbenchUrl(instanceId: string, worktreePath: string): string {
		const workbenchUrl = new URL(this.workbenchRoute, mainWindow.location.origin);
		workbenchUrl.searchParams.set('folder', worktreePath);
		workbenchUrl.searchParams.set('payload', JSON.stringify([
			['isHostedOmniWorkspace', 'true'],
			['hostedInstanceId', instanceId],
		]));
		return workbenchUrl.toString();
	}

	private toNormalWorkbenchUrl(worktreePath: string): string {
		const workbenchUrl = new URL(this.workbenchRoute, mainWindow.location.origin);
		workbenchUrl.searchParams.set('folder', worktreePath);
		return workbenchUrl.toString();
	}

	private getActiveInstance(): IHostedIframeInstance | undefined {
		return this.activeInstanceId
			? this.instancesById.get(this.activeInstanceId)
			: undefined;
	}

	private getAvailableActiveInstance(): IHostedIframeInstance | undefined {
		const instance = this.getActiveInstance();
		return instance && isHostedWorkspaceAvailable(instance)
			? instance
			: undefined;
	}

	private getInstanceByPath(
		worktreePath: string
	): IHostedIframeInstance | undefined {
		return this.hostedWorkspaces.getInstanceByPath(worktreePath);
	}

	private getAvailableInstanceByPath(
		worktreePath: string
	): IHostedIframeInstance | undefined {
		const instance = this.getInstanceByPath(worktreePath);
		return instance && isHostedWorkspaceAvailable(instance)
			? instance
			: undefined;
	}

	private getState(): IHucodeHostedWorkspaceState {
		return this.hostedWorkspaces.toState();
	}

	private emitState(): void {
		this.hostedWorkspaces.setProjectsSidebarVisible(
			this.hostedWorkspaces.projectsSidebarVisible,
			hasLoadedHostedWorkspace(this.instancesById.values())
		);
		const state = this.getState();
		this._onDidChangeWindowState.fire({
			windowId: this.windowId,
			state,
		});
		for (const instance of this.instancesById.values()) {
			this.postState(instance, state);
		}
	}

	private postState(
		instance: IHostedIframeInstance,
		state: IHucodeHostedWorkspaceState
	): void {
		instance.iframe.contentWindow?.postMessage({
			type: HucodeOmniWebParentMessageType.State,
			instanceId: instance.instanceId,
			state,
		}, mainWindow.location.origin);
	}

	private toPathKey(path: string): string {
		return getProjectManagerPathComparisonKey(
			path,
			this.serverPathCaseSensitive
		);
	}

	private toPendingRequestKey(instanceId: string, requestId: string): string {
		return `${instanceId}:${requestId}`;
	}

	private get instancesById(): Map<string, IHostedIframeInstance> {
		return this.hostedWorkspaces.instancesById;
	}

	private get activeInstanceId(): string | undefined {
		return this.hostedWorkspaces.activeInstanceId;
	}
}

function isHucodeOmniWebChildMessage(
	value: unknown
): value is HucodeOmniWebChildMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const type = (value as { readonly type?: unknown }).type;
	return type === HucodeOmniWebChildMessageType.Ready ||
		type === HucodeOmniWebChildMessageType.Focus ||
		type === HucodeOmniWebChildMessageType.UnloadReady ||
		type === HucodeOmniWebChildMessageType.CommandResult ||
		type === HucodeOmniWebChildMessageType.ShellCommand ||
		type === HucodeOmniWebChildMessageType.ShellRequest;
}

function emptyState(): IHucodeHostedWorkspaceState {
	return {
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: [],
	};
}

function getStringArg(args: readonly unknown[], index: number): string {
	const value = args[index];
	if (typeof value !== 'string') {
		throw new Error(`Expected string argument at index ${index}`);
	}

	return value;
}

function getOptionalStringArg(
	args: readonly unknown[],
	index: number
): string | undefined {
	const value = args[index];
	if (value === undefined || typeof value === 'string') {
		return value;
	}

	throw new Error(`Expected optional string argument at index ${index}`);
}

registerSingleton(
	IHucodeShellService,
	WebHucodeShellService,
	InstantiationType.Delayed
);
