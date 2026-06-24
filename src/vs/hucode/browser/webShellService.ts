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
	createHostedWorkspaceState,
	getMostRecentHostedWorkspace,
	getReadyHostedWorkspaceState,
	hasLoadedHostedWorkspace,
} from '../common/hostedWorkspaceState.js';
import {
	HucodeOmniWebChildMessage,
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
} from '../../platform/window/common/hucodeOmniWebMessages.js';
import { getHucodeOmniWorkbenchRoute } from
	'../../platform/environment/common/hucodeWebConfiguration.js';
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

	private readonly windowId = getWindowId(mainWindow);
	private readonly workbenchRoute: string;
	private readonly instancesById = new Map<string, IHostedIframeInstance>();
	private readonly instanceIdsByPath = new Map<string, string>();
	private readonly pendingUnload = new Map<string, () => void>();
	private activeInstanceId: string | undefined;
	private projectsSidebarVisible = true;
	private projectSwitcherCanGoBack = false;
	private projectSwitcherCanGoForward = false;
	private bounds: IRectangle = { x: 0, y: 0, width: 0, height: 0 };

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
		const instance = this.getInstanceByPath(worktreePath);
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
		const instance = this.getInstanceByPath(worktreePath);
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
			existing.projectId = projectId ?? existing.projectId;
			this.activateInstance(existing);
			return this.getState();
		}

		const instance = this.createInstance(worktreePath, projectId);
		this.instancesById.set(instance.instanceId, instance);
		this.instanceIdsByPath.set(this.toPathKey(worktreePath), instance.instanceId);
		this.attachIframe(instance);
		this.activateInstance(instance);
		return this.getState();
	}

	async openFilesInWorkspace(
		windowId: number,
		worktreePath: string,
		_request: INativeOpenFileRequest,
		projectId?: string
	): Promise<boolean> {
		await this.openWorkspace(windowId, worktreePath, projectId);
		return false;
	}

	async openFilesInActiveWorkspace(
		_windowId: number,
		_request: INativeOpenFileRequest
	): Promise<boolean> {
		return false;
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
		_windowId: number,
		instanceId: string
	): Promise<boolean> {
		const instance = this.instancesById.get(instanceId);
		if (!instance) {
			return false;
		}

		mainWindow.open(this.toWorkbenchUrl(instance.instanceId, instance.worktreePath));
		return true;
	}

	async notifyHostedWorkspaceReady(
		windowId: number,
		instanceId: string
	): Promise<void> {
		if (windowId !== this.windowId) {
			return;
		}

		const instance = this.instancesById.get(instanceId);
		if (!instance) {
			return;
		}

		instance.state = getReadyHostedWorkspaceState(
			instance,
			this.activeInstanceId
		);
		this.emitState();
	}

	async focusWorkspace(_windowId: number): Promise<void> {
		const instance = this.getActiveInstance();
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
		this.projectsSidebarVisible = visible;
		this.emitState();
	}

	async setProjectSwitcherNavigationState(
		_windowId: number,
		canGoBack: boolean,
		canGoForward: boolean
	): Promise<void> {
		if (
			this.projectSwitcherCanGoBack === canGoBack &&
			this.projectSwitcherCanGoForward === canGoForward
		) {
			return;
		}

		this.projectSwitcherCanGoBack = canGoBack;
		this.projectSwitcherCanGoForward = canGoForward;
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
		this.getActiveInstance()?.iframe.contentWindow?.focus();
		return false;
	}

	async triggerPasteInWorkspace(_windowId: number): Promise<boolean> {
		this.getActiveInstance()?.iframe.contentWindow?.focus();
		return false;
	}

	async reloadWorkspace(_windowId: number): Promise<void> {
		const instance = this.getActiveInstance();
		if (!instance) {
			return;
		}

		instance.state = 'loading';
		this.postCommand(instance, 'workbench.action.reloadWindow', []);
		mainWindow.setTimeout(() => {
			if (instance.state === 'loading') {
				instance.iframe.src = instance.iframe.src;
			}
		}, 500);
		this.emitState();
	}

	async toggleWorkspaceDevTools(_windowId: number): Promise<boolean> {
		return false;
	}

	async layoutWorkspace(
		_windowId: number,
		bounds: IRectangle
	): Promise<void> {
		this.bounds = bounds;
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

		this.handleChildMessage(event.data);
	};

	private handleChildMessage(message: HucodeOmniWebChildMessage): void {
		const instance = this.instancesById.get(message.instanceId);
		if (!instance) {
			return;
		}

		switch (message.type) {
			case HucodeOmniWebChildMessageType.Ready:
				void this.notifyHostedWorkspaceReady(
					this.windowId,
					message.instanceId
				);
				break;
			case HucodeOmniWebChildMessageType.Focus:
				instance.focused = message.focused;
				if (message.focused) {
					this.activateInstance(instance);
				} else {
					this.emitState();
				}
				break;
			case HucodeOmniWebChildMessageType.UnloadReady:
				this.pendingUnload.get(message.instanceId)?.();
				break;
			case HucodeOmniWebChildMessageType.CommandResult:
				if (instance.state === 'loading') {
					instance.state = message.ok ? 'loaded' : 'crashed';
					this.emitState();
				}
				break;
			case HucodeOmniWebChildMessageType.ShellCommand:
				void this.handleShellCommand(instance, message.commandId);
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
		iframe.addEventListener('load', () => {
			const instance = this.instancesById.get(instanceId);
			if (instance && instance.state === 'loading') {
				instance.state = instance.instanceId === this.activeInstanceId
					? 'active'
					: 'loaded';
				this.emitState();
			}
		});

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
		this.activeInstanceId = instance.instanceId;
		instance.state = instance.state === 'loading' ? 'loading' : 'active';
		instance.lastActiveAt = Date.now();
		for (const candidate of this.instancesById.values()) {
			const visible = candidate.instanceId === instance.instanceId;
			candidate.visible = visible;
			candidate.focused = visible ? candidate.focused : false;
			if (!visible && candidate.state === 'active') {
				candidate.state = 'loaded';
			}
			candidate.iframe.classList.toggle('hidden', !visible);
		}
		this.emitState();
	}

	private removeInstance(instance: IHostedIframeInstance): void {
		instance.state = 'unloaded';
		instance.iframe.remove();
		this.instancesById.delete(instance.instanceId);
		this.instanceIdsByPath.delete(this.toPathKey(instance.worktreePath));
		if (this.activeInstanceId === instance.instanceId) {
			this.activeInstanceId = undefined;
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
	): boolean {
		const instance = this.getActiveInstance();
		if (!instance) {
			return false;
		}

		this.postCommand(instance, commandId, args);
		return true;
	}

	private postCommand(
		instance: IHostedIframeInstance,
		commandId: string,
		args: readonly unknown[]
	): void {
		instance.iframe.contentWindow?.postMessage({
			type: HucodeOmniWebParentMessageType.RunCommand,
			instanceId: instance.instanceId,
			commandId,
			args,
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
		if (!surface || this.bounds.width <= 0 || this.bounds.height <= 0) {
			return;
		}

		for (const instance of this.instancesById.values()) {
			instance.iframe.style.width = `${Math.max(0, this.bounds.width)}px`;
			instance.iframe.style.height = `${Math.max(0, this.bounds.height)}px`;
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

	private getActiveInstance(): IHostedIframeInstance | undefined {
		return this.activeInstanceId
			? this.instancesById.get(this.activeInstanceId)
			: undefined;
	}

	private getInstanceByPath(
		worktreePath: string
	): IHostedIframeInstance | undefined {
		const instanceId = this.instanceIdsByPath.get(this.toPathKey(worktreePath));
		return instanceId ? this.instancesById.get(instanceId) : undefined;
	}

	private getState(): IHucodeHostedWorkspaceState {
		return createHostedWorkspaceState(
			this.instancesById.values(),
			this.activeInstanceId,
			this.projectsSidebarVisible,
			this.projectSwitcherCanGoBack,
			this.projectSwitcherCanGoForward
		);
	}

	private emitState(): void {
		if (!hasLoadedHostedWorkspace(this.instancesById.values())) {
			this.projectsSidebarVisible = true;
		}
		this._onDidChangeWindowState.fire({
			windowId: this.windowId,
			state: this.getState(),
		});
	}

	private toPathKey(path: string): string {
		return path.toLowerCase();
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
		type === HucodeOmniWebChildMessageType.ShellCommand;
}

function emptyState(): IHucodeHostedWorkspaceState {
	return {
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: [],
	};
}

registerSingleton(
	IHucodeShellService,
	WebHucodeShellService,
	InstantiationType.Delayed
);
