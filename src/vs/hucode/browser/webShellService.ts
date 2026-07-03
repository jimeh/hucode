/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import {
	Disposable,
	DisposableStore,
	IDisposable,
	toDisposable,
} from '../../base/common/lifecycle.js';
import { generateUuid } from '../../base/common/uuid.js';
import { Client as MessagePortClient } from
	'../../base/parts/ipc/browser/ipc.mp.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import {
	INativeOpenFileRequest,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
	IRectangle,
} from '../../platform/window/common/window.js';
import { FOCUS_PROJECT_PANE_COMMAND_ID } from
	'../../platform/window/common/hucodeOmniCommandRouting.js';
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
	createEmptyHostedWorkspaceState,
	getMostRecentHostedWorkspace,
	hasLoadedHostedWorkspace,
	HostedWorkspaceStateModel,
	isHostedWorkspaceAvailable,
	waitForHostedWorkspaceReady,
} from '../common/hostedWorkspaceState.js';
import { reopenHucodeHostedWorkspaceInNormalWindow } from
	'../common/omniWorkspaceReopen.js';
import {
	HUCODE_OMNI_WEB_SHELL_CHANNEL,
	HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
	HucodeOmniWebChildMessage,
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
	IHucodeOmniWebWorkbenchClient,
} from '../../platform/window/common/hucodeOmniWebMessages.js';
import {
	getHucodeOmniHostedWorkbenchRoute,
	getHucodeOmniWorkbenchRoute,
	getHucodeServerPathCaseSensitive,
} from '../../platform/environment/common/hucodeWebConfiguration.js';
import { getProjectManagerPathComparisonKey } from
	'../../platform/projectManager/common/projectManagerState.js';
import { IHucodeWebOmniHostSurfaceService } from
	'./webOmniHostSurfaceService.js';

interface IHostedIframeConnection {
	readonly workbench: IHucodeOmniWebWorkbenchClient;
	readonly disposables: DisposableStore;
}

interface IHostedIframeInstance {
	instanceId: string;
	projectId?: string;
	worktreePath: string;
	state: HucodeHostedWorkbenchLifecycleState;
	iframe: HTMLIFrameElement;
	visible: boolean;
	focused: boolean;
	lastActiveAt?: number;
	connection?: IHostedIframeConnection;
}

type WebHucodeShellTimer = ReturnType<typeof setTimeout>;
type IWebHucodeShellCommandService = Pick<ICommandService, 'executeCommand'>;
type IWebHucodeShellHostSurfaceService = Pick<
	IHucodeWebOmniHostSurfaceService,
	'onDidChangeSurface' | 'getSurface'
>;

const REQUEST_TIMEOUT = Symbol('hucodeOmniWebRequestTimeout');

export interface IWebHucodeShellOptions {
	readonly workbenchRoute: string;
	readonly hostedWorkbenchRoute: string;
	readonly serverPathCaseSensitive: boolean;
}

export interface IWebHucodeShellBrowserAdapter {
	readonly windowId: number;
	readonly origin: string;
	createIframe(): HTMLIFrameElement;
	addMessageListener(listener: (event: MessageEvent) => void): IDisposable;
	setTimeout(callback: () => void, timeout: number): WebHucodeShellTimer;
	clearTimeout(handle: WebHucodeShellTimer): void;
	open(url: string): void;
	focusIframe(iframe: HTMLIFrameElement): void;
	focusIframeContent(iframe: HTMLIFrameElement): void;
	reloadIframe(iframe: HTMLIFrameElement): void;
	createMessageChannel(): MessageChannel;
	postPortMessage(
		iframe: HTMLIFrameElement,
		message: object,
		port: MessagePort
	): void;
}

function defaultWebHucodeShellBrowserAdapter():
	IWebHucodeShellBrowserAdapter {
	return {
		windowId: getWindowId(mainWindow),
		origin: mainWindow.location.origin,
		createIframe: () => document.createElement('iframe'),
		addMessageListener: listener => {
			mainWindow.addEventListener('message', listener);
			return toDisposable(() => {
				mainWindow.removeEventListener('message', listener);
			});
		},
		setTimeout: (callback, timeout) => setTimeout(callback, timeout),
		clearTimeout: handle => clearTimeout(handle),
		open: url => {
			mainWindow.open(url);
		},
		focusIframe: iframe => iframe.focus(),
		focusIframeContent: iframe => iframe.contentWindow?.focus(),
		reloadIframe: iframe => iframe.contentWindow?.location.reload(),
		createMessageChannel: () => new MessageChannel(),
		postPortMessage: (iframe, message, port) => {
			iframe.contentWindow?.postMessage(
				message,
				mainWindow.location.origin,
				[port]
			);
		},
	};
}

/**
 * Browser implementation of the Hucode Omni shell service.
 *
 * Hosted iframes bootstrap over window messages (`Ready`/`Focus`) and are
 * then driven over a per-instance MessagePort IPC connection: the shell
 * exposes itself as the shell channel and calls back into the hosted
 * workbench through the workbench channel.
 */
export class WebHucodeShellController extends Disposable
	implements IHucodeShellService {

	declare readonly _serviceBrand: undefined;
	readonly supportsWorkspaceScreenshotOverlay = false;
	private static readonly READY_TIMEOUT_MS = 30000;
	private static readonly COMMAND_TIMEOUT_MS = 5000;
	private static readonly UNLOAD_TIMEOUT_MS = 1500;

	private readonly windowId: number;
	private readonly workbenchRoute: string;
	private readonly hostedWorkbenchRoute: string;
	private readonly serverPathCaseSensitive: boolean;
	private readonly hostedWorkspaces: HostedWorkspaceStateModel<
		IHostedIframeInstance
	>;

	private readonly pendingConnectionDisposals = new Set<DisposableStore>();

	private readonly _onDidChangeWindowState =
		this._register(new Emitter<IHucodeShellWindowStateChange>());
	readonly onDidChangeWindowState = this._onDidChangeWindowState.event;

	constructor(
		options: IWebHucodeShellOptions,
		private readonly commandService: IWebHucodeShellCommandService,
		private readonly hostSurfaceService: IWebHucodeShellHostSurfaceService,
		private readonly browser: IWebHucodeShellBrowserAdapter =
			defaultWebHucodeShellBrowserAdapter(),
	) {
		super();

		this.windowId = browser.windowId;
		this.workbenchRoute = options.workbenchRoute;
		this.hostedWorkbenchRoute = options.hostedWorkbenchRoute;
		this.serverPathCaseSensitive = options.serverPathCaseSensitive;
		this.hostedWorkspaces = new HostedWorkspaceStateModel(
			path => this.toPathKey(path)
		);
		this._register(this.hostSurfaceService.onDidChangeSurface(surface => {
			if (surface) {
				this.attachIframes(surface);
			}
		}));
		this._register(this.browser.addMessageListener(this.onMessage));
		this._register(toDisposable(() => {
			for (const instance of this.instancesById.values()) {
				this.disposeConnection(instance);
			}
		}));
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
				this.browser.open(this.toNormalWorkbenchUrl(worktreePath));
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
		const instance = this.getAvailableActiveInstance();
		if (!instance) {
			return false;
		}

		return this.runCommandInInstance(
			instance,
			request.id,
			request.args ?? []
		);
	}

	async runKeybindingInWorkspace(
		_windowId: number,
		_request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		const instance = this.getAvailableActiveInstance();
		if (instance) {
			this.browser.focusIframeContent(instance.iframe);
		}
		return false;
	}

	async triggerPasteInWorkspace(_windowId: number): Promise<boolean> {
		const instance = this.getAvailableActiveInstance();
		if (instance) {
			this.browser.focusIframeContent(instance.iframe);
		}
		return false;
	}

	async reloadWorkspace(_windowId: number): Promise<void> {
		const instance = this.getAvailableActiveInstance();
		if (!instance) {
			return;
		}

		instance.state = 'loading';
		void this.runCommandInInstance(
			instance,
			'workbench.action.reloadWindow',
			[]
		);
		this.browser.setTimeout(() => {
			if (instance.state === 'loading') {
				this.browser.reloadIframe(instance.iframe);
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
			event.origin !== this.browser.origin ||
			!isHucodeOmniWebChildMessage(event.data)
		) {
			return;
		}

		const instance = this.instancesById.get(event.data.instanceId);
		if (!instance || event.source !== instance.iframe.contentWindow) {
			return;
		}

		this.handleChildMessage(instance, event.data);
	};

	private handleChildMessage(
		instance: IHostedIframeInstance,
		message: HucodeOmniWebChildMessage
	): void {
		if (!isHostedWorkspaceAvailable(instance)) {
			return;
		}

		switch (message.type) {
			case HucodeOmniWebChildMessageType.Ready:
				this.connectInstance(instance);
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
		}
	}

	/**
	 * Establishes the per-instance MessagePort IPC connection. A repeated
	 * ready signal means the iframe document reloaded, so any previous
	 * connection is replaced.
	 */
	private connectInstance(instance: IHostedIframeInstance): void {
		this.disposeConnection(instance);

		const disposables = new DisposableStore();
		const channel = this.browser.createMessageChannel();
		const client = disposables.add(new MessagePortClient(
			channel.port1,
			`hucodeOmniWebShell:${instance.instanceId}`
		));
		client.registerChannel(
			HUCODE_OMNI_WEB_SHELL_CHANNEL,
			ProxyChannel.fromService(this, disposables)
		);
		instance.connection = {
			workbench: ProxyChannel.toService<IHucodeOmniWebWorkbenchClient>(
				client.getChannel(HUCODE_OMNI_WEB_WORKBENCH_CHANNEL)
			),
			disposables,
		};
		this.browser.postPortMessage(instance.iframe, {
			type: HucodeOmniWebParentMessageType.Port,
			instanceId: instance.instanceId,
			windowId: this.windowId,
		}, channel.port2);
	}

	private disposeConnection(instance: IHostedIframeInstance): void {
		const connection = instance.connection;
		if (!connection) {
			return;
		}

		instance.connection = undefined;
		// Closing a workspace over its own shell channel must not close the
		// port before the pending response has been flushed to the iframe.
		this.pendingConnectionDisposals.add(connection.disposables);
		this.browser.setTimeout(() => {
			if (this.pendingConnectionDisposals.delete(connection.disposables)) {
				connection.disposables.dispose();
			}
		}, 0);
	}

	override dispose(): void {
		super.dispose();

		for (const disposables of this.pendingConnectionDisposals) {
			disposables.dispose();
		}
		this.pendingConnectionDisposals.clear();
	}

	private createInstance(
		worktreePath: string,
		projectId: string | undefined
	): IHostedIframeInstance {
		const instanceId = generateUuid();
		const iframe = this.browser.createIframe();
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
		this.disposeConnection(instance);
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

	private async requestUnload(instance: IHostedIframeInstance): Promise<void> {
		const workbench = instance.connection?.workbench;
		if (!workbench) {
			return;
		}

		await this.raceTimeout(
			workbench.prepareUnload().then(() => undefined, () => undefined),
			WebHucodeShellController.UNLOAD_TIMEOUT_MS
		);
	}

	private async openFilesInInstance(
		instance: IHostedIframeInstance,
		request: INativeOpenFileRequest
	): Promise<boolean> {
		if (!await this.waitForInstanceReady(instance)) {
			return false;
		}

		const workbench = instance.connection?.workbench;
		if (!workbench) {
			return false;
		}

		const result = await this.raceTimeout(
			workbench.openFiles(request).catch(() => false),
			WebHucodeShellController.COMMAND_TIMEOUT_MS
		);
		return result === true;
	}

	private waitForInstanceReady(instance: IHostedIframeInstance): Promise<boolean> {
		return waitForHostedWorkspaceReady(
			instance,
			this.onDidChangeWindowState,
			WebHucodeShellController.READY_TIMEOUT_MS
		);
	}

	/**
	 * Runs a workbench command in an instance. Completed results also settle
	 * a pending `loading` state: success marks the workbench ready, failure
	 * marks it crashed. Timeouts leave the state untouched so an in-flight
	 * reload keeps its iframe-level fallback.
	 */
	private async runCommandInInstance(
		instance: IHostedIframeInstance,
		commandId: string,
		args: readonly unknown[]
	): Promise<boolean> {
		const workbench = instance.connection?.workbench;
		if (!workbench) {
			return false;
		}

		const result = await this.raceTimeout(
			workbench.runCommand(commandId, args).catch(() => false),
			WebHucodeShellController.COMMAND_TIMEOUT_MS
		);
		if (result === REQUEST_TIMEOUT) {
			return false;
		}

		if (instance.state === 'loading') {
			if (result) {
				this.hostedWorkspaces.markInstanceReady(instance);
			} else {
				instance.state = 'crashed';
			}
			this.emitState();
		}
		return result;
	}

	private raceTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number
	): Promise<T | typeof REQUEST_TIMEOUT> {
		return new Promise(resolve => {
			const handle = this.browser.setTimeout(
				() => resolve(REQUEST_TIMEOUT),
				timeoutMs
			);
			void promise.then(value => {
				this.browser.clearTimeout(handle);
				resolve(value);
			});
		});
	}

	private focusIframe(instance: IHostedIframeInstance): void {
		this.browser.focusIframe(instance.iframe);
		this.browser.focusIframeContent(instance.iframe);
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
		const workbenchUrl = new URL(
			this.hostedWorkbenchRoute,
			this.browser.origin
		);
		workbenchUrl.searchParams.set('folder', worktreePath);
		workbenchUrl.searchParams.set('payload', JSON.stringify([
			['isHostedOmniWorkspace', 'true'],
			['hostedInstanceId', instanceId],
		]));
		return workbenchUrl.toString();
	}

	private toNormalWorkbenchUrl(worktreePath: string): string {
		const workbenchUrl = new URL(this.workbenchRoute, this.browser.origin);
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
		this._onDidChangeWindowState.fire({
			windowId: this.windowId,
			state: this.getState(),
		});
	}

	private toPathKey(path: string): string {
		return getProjectManagerPathComparisonKey(
			path,
			this.serverPathCaseSensitive
		);
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
		type === HucodeOmniWebChildMessageType.Focus;
}

function emptyState(): IHucodeHostedWorkspaceState {
	return createEmptyHostedWorkspaceState();
}

export class WebHucodeShellService extends WebHucodeShellController {
	constructor(
		@IBrowserWorkbenchEnvironmentService
		environmentService: IBrowserWorkbenchEnvironmentService,
		@ICommandService commandService: ICommandService,
		@IHucodeWebOmniHostSurfaceService
		hostSurfaceService: IHucodeWebOmniHostSurfaceService,
	) {
		super({
			workbenchRoute: getHucodeOmniWorkbenchRoute(
				environmentService.options
			),
			hostedWorkbenchRoute: getHucodeOmniHostedWorkbenchRoute(
				environmentService.options
			),
			serverPathCaseSensitive: getHucodeServerPathCaseSensitive(
				environmentService.options
			),
		}, commandService, hostSurfaceService);
	}
}

registerSingleton(
	IHucodeShellService,
	WebHucodeShellService,
	InstantiationType.Delayed
);
