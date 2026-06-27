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
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import {
	INativeOpenFileRequest,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
	IRectangle,
} from '../../platform/window/common/window.js';
import {
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
} from '../../platform/window/common/hucodeOmniWebMessages.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeHostedWorkspaceOwner,
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
	IHucodeShellWindowStateChange,
} from '../common/omniWindow.js';
import { ShutdownReason } from
	'../../workbench/services/lifecycle/common/lifecycle.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';

interface IPendingShellRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: number;
}

interface IHucodeOmniWebStateMessage {
	readonly type?: unknown;
	readonly instanceId?: unknown;
	readonly state?: unknown;
}

interface IHucodeOmniWebShellResponseLike {
	readonly type?: unknown;
	readonly instanceId?: unknown;
	readonly requestId?: unknown;
	readonly ok?: unknown;
	readonly result?: unknown;
	readonly error?: unknown;
}

/**
 * Hosted iframe implementation of the Hucode shell service.
 */
export class HostedOmniWebShellService extends Disposable
	implements IHucodeShellService {

	declare readonly _serviceBrand: undefined;
	readonly supportsWorkspaceScreenshotOverlay = false;

	private readonly windowId = getWindowId(mainWindow);
	private readonly instanceId: string | undefined;
	private readonly pendingRequests = new Map<string, IPendingShellRequest>();
	private state = emptyState();

	private readonly _onDidChangeWindowState =
		this._register(new Emitter<IHucodeShellWindowStateChange>());
	readonly onDidChangeWindowState = this._onDidChangeWindowState.event;

	constructor(
		@IWorkbenchEnvironmentService
		private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super();

		this.instanceId = environmentService.isHostedOmniWorkspace
			? environmentService.hostedInstanceId
			: undefined;

		this._register(toDisposable(() => {
			mainWindow.removeEventListener('message', this.onMessage);
			for (const [requestId, request] of this.pendingRequests) {
				mainWindow.clearTimeout(request.timeout);
				request.reject(new Error(`Shell request canceled: ${requestId}`));
			}
			this.pendingRequests.clear();
		}));
		mainWindow.addEventListener('message', this.onMessage);
	}

	async getWindowState(
		_windowId: number
	): Promise<IHucodeHostedWorkspaceState> {
		if (!this.isHosted()) {
			return this.state;
		}

		const state = await this.request<IHucodeHostedWorkspaceState>(
			'getWindowState',
			[this.windowId],
			this.state
		);
		this.updateState(state);
		return this.state;
	}

	async findHostedWorkspaceByPath(
		worktreePath: string
	): Promise<IHucodeHostedWorkspaceOwner | undefined> {
		return this.request<IHucodeHostedWorkspaceOwner | undefined>(
			'findHostedWorkspaceByPath',
			[worktreePath],
			undefined
		);
	}

	async focusHostedWorkspaceByPath(
		worktreePath: string,
		projectId?: string
	): Promise<boolean> {
		return this.request<boolean>(
			'focusHostedWorkspaceByPath',
			[worktreePath, projectId],
			false
		);
	}

	async focusNormalWindowByPath(worktreePath: string): Promise<boolean> {
		return this.request<boolean>(
			'focusNormalWindowByPath',
			[worktreePath],
			false
		);
	}

	async openWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		return this.request<IHucodeHostedWorkspaceState>(
			'openWorkspace',
			[windowId, worktreePath, projectId],
			this.state
		);
	}

	async openFilesInWorkspace(
		windowId: number,
		worktreePath: string,
		request: INativeOpenFileRequest,
		projectId?: string
	): Promise<boolean> {
		return this.request<boolean>(
			'openFilesInWorkspace',
			[windowId, worktreePath, request, projectId],
			false
		);
	}

	async openFilesInActiveWorkspace(
		windowId: number,
		request: INativeOpenFileRequest
	): Promise<boolean> {
		return this.request<boolean>(
			'openFilesInActiveWorkspace',
			[windowId, request],
			false
		);
	}

	async closeWorkspace(
		windowId: number,
		instanceId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		return this.request<IHucodeHostedWorkspaceState>(
			'closeWorkspace',
			[windowId, instanceId],
			this.state
		);
	}

	async reopenWorkspaceInNormalWindow(
		windowId: number,
		instanceId: string
	): Promise<boolean> {
		return this.request<boolean>(
			'reopenWorkspaceInNormalWindow',
			[windowId, instanceId],
			false
		);
	}

	async notifyHostedWorkspaceReady(
		windowId: number,
		instanceId: string
	): Promise<void> {
		await this.request<void>(
			'notifyHostedWorkspaceReady',
			[windowId, instanceId],
			undefined
		);
	}

	async focusWorkspace(windowId: number): Promise<void> {
		await this.request<void>('focusWorkspace', [windowId], undefined);
	}

	async focusShell(windowId: number): Promise<void> {
		await this.request<void>('focusShell', [windowId], undefined);
	}

	async setProjectsSidebarVisible(
		windowId: number,
		visible: boolean
	): Promise<void> {
		await this.request<void>(
			'setProjectsSidebarVisible',
			[windowId, visible],
			undefined
		);
	}

	async setProjectSwitcherNavigationState(
		windowId: number,
		canGoBack: boolean,
		canGoForward: boolean
	): Promise<void> {
		await this.request<void>(
			'setProjectSwitcherNavigationState',
			[windowId, canGoBack, canGoForward],
			undefined
		);
	}

	async runActionInShell(
		windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		return this.request<boolean>(
			'runActionInShell',
			[windowId, request],
			false
		);
	}

	async runActionInWorkspace(
		windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		return this.request<boolean>(
			'runActionInWorkspace',
			[windowId, request],
			false
		);
	}

	async runKeybindingInWorkspace(
		windowId: number,
		request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		return this.request<boolean>(
			'runKeybindingInWorkspace',
			[windowId, request],
			false
		);
	}

	async triggerPasteInWorkspace(windowId: number): Promise<boolean> {
		return this.request<boolean>(
			'triggerPasteInWorkspace',
			[windowId],
			false
		);
	}

	async reloadWorkspace(windowId: number): Promise<void> {
		await this.request<void>('reloadWorkspace', [windowId], undefined);
	}

	async toggleWorkspaceDevTools(windowId: number): Promise<boolean> {
		return this.request<boolean>(
			'toggleWorkspaceDevTools',
			[windowId],
			false
		);
	}

	async layoutWorkspace(
		windowId: number,
		bounds: IRectangle
	): Promise<void> {
		await this.request<void>('layoutWorkspace', [windowId, bounds], undefined);
	}

	async captureWorkspaceScreenshot(
		_windowId: number,
		_rect?: IRectangle,
		_quality?: number
	): Promise<VSBuffer | undefined> {
		return undefined;
	}

	async setWorkspaceOverlayOcclusion(
		windowId: number,
		occluded: boolean
	): Promise<void> {
		await this.request<void>(
			'setWorkspaceOverlayOcclusion',
			[windowId, occluded],
			undefined
		);
	}

	async shutdownWindowWorkspaces(
		windowId: number,
		reason: ShutdownReason
	): Promise<void> {
		await this.request<void>(
			'shutdownWindowWorkspaces',
			[windowId, reason],
			undefined
		);
	}

	private readonly onMessage = (event: MessageEvent): void => {
		if (
			event.origin !== mainWindow.location.origin ||
			!this.instanceId ||
			!isMessageForInstance(event.data, this.instanceId)
		) {
			return;
		}

		const message = event.data as
			IHucodeOmniWebStateMessage | IHucodeOmniWebShellResponseLike;
		switch (message.type) {
			case HucodeOmniWebParentMessageType.State:
				this.updateState((message as IHucodeOmniWebStateMessage).state);
				break;
			case HucodeOmniWebParentMessageType.ShellResponse:
				this.handleResponse(message);
				break;
		}
	};

	private handleResponse(
		message: IHucodeOmniWebShellResponseLike
	): void {
		if (typeof message.requestId !== 'string') {
			return;
		}

		const pending = this.pendingRequests.get(message.requestId);
		if (!pending) {
			return;
		}

		this.pendingRequests.delete(message.requestId);
		mainWindow.clearTimeout(pending.timeout);
		if (message.ok === true) {
			pending.resolve(message.result);
		} else {
			pending.reject(new Error(
				typeof message.error === 'string'
					? message.error
					: 'Hosted Omni shell request failed'
			));
		}
	}

	private updateState(state: unknown): void {
		if (!isHostedWorkspaceState(state)) {
			return;
		}

		this.state = state;
		this._onDidChangeWindowState.fire({
			windowId: this.windowId,
			state,
		});
	}

	private request<T>(
		method: string,
		args: readonly unknown[],
		fallback: T
	): Promise<T> {
		if (!this.isHosted() || mainWindow.parent === mainWindow) {
			return Promise.resolve(fallback);
		}

		const requestId = generateUuid();
		return new Promise<T>((resolve, reject) => {
			const timeout = mainWindow.setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new Error(`Hosted Omni shell request timed out: ${method}`));
			}, 5000);
			this.pendingRequests.set(requestId, {
				resolve: value => resolve(value as T),
				reject,
				timeout,
			});
			mainWindow.parent.postMessage({
				type: HucodeOmniWebChildMessageType.ShellRequest,
				instanceId: this.instanceId,
				requestId,
				method,
				args,
			}, mainWindow.location.origin);
		});
	}

	private isHosted(): boolean {
		return !!this.environmentService.isHostedOmniWorkspace &&
			!!this.instanceId;
	}
}

function isMessageForInstance(value: unknown, instanceId: string): boolean {
	return !!value &&
		typeof value === 'object' &&
		(value as { readonly instanceId?: unknown }).instanceId === instanceId;
}

function isHostedWorkspaceState(
	value: unknown
): value is IHucodeHostedWorkspaceState {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const state = value as {
		readonly projectsSidebarVisible?: unknown;
		readonly projectSwitcherCanGoBack?: unknown;
		readonly projectSwitcherCanGoForward?: unknown;
		readonly instances?: unknown;
	};
	return typeof state.projectsSidebarVisible === 'boolean' &&
		typeof state.projectSwitcherCanGoBack === 'boolean' &&
		typeof state.projectSwitcherCanGoForward === 'boolean' &&
		Array.isArray(state.instances) &&
		state.instances.every(isHostedWorkbenchInstance);
}

function isHostedWorkbenchInstance(
	value: unknown
): boolean {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const instance = value as {
		readonly instanceId?: unknown;
		readonly worktreePath?: unknown;
		readonly state?: unknown;
		readonly visible?: unknown;
		readonly focused?: unknown;
	};
	return typeof instance.instanceId === 'string' &&
		typeof instance.worktreePath === 'string' &&
		isHostedWorkbenchLifecycleState(instance.state) &&
		typeof instance.visible === 'boolean' &&
		typeof instance.focused === 'boolean';
}

function isHostedWorkbenchLifecycleState(
	value: unknown
): value is HucodeHostedWorkbenchLifecycleState {
	return value === 'restore-pending' ||
		value === 'loading' ||
		value === 'active' ||
		value === 'loaded' ||
		value === 'dormant' ||
		value === 'unloaded' ||
		value === 'crashed';
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
	HostedOmniWebShellService,
	InstantiationType.Delayed
);
