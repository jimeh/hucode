/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import {
	INativeOpenFileRequest,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
	IRectangle,
} from '../../platform/window/common/window.js';
import { HUCODE_OMNI_WEB_SHELL_CHANNEL } from
	'../../platform/window/common/hucodeOmniWebMessages.js';
import {
	IHucodeHostedOmniWebConnectionService,
} from './hostedOmniWebConnection.js';
import {
	IHucodeHostedWorkspaceOwner,
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
	IHucodeShellWindowStateChange,
} from '../common/omniWindow.js';
import { createEmptyHostedWorkspaceState } from
	'../common/hostedWorkspaceState.js';
import { ShutdownReason } from
	'../../workbench/services/lifecycle/common/lifecycle.js';

interface IConnectedShell {
	readonly shell: IHucodeShellService;
	readonly shellWindowId: number;
}

/**
 * Hosted iframe implementation of the Hucode shell service.
 *
 * Every call proxies over the shell's MessagePort channel, substituting the
 * shell's window id because hosted iframe windows have their own ids that the
 * shell controller does not know about.
 */
export class HostedOmniWebShellService extends Disposable
	implements IHucodeShellService {

	declare readonly _serviceBrand: undefined;
	readonly supportsWorkspaceScreenshotOverlay = false;

	private readonly windowId = getWindowId(mainWindow);
	private readonly connected: Promise<IConnectedShell> | undefined;
	private state = createEmptyHostedWorkspaceState();

	private readonly _onDidChangeWindowState =
		this._register(new Emitter<IHucodeShellWindowStateChange>());
	readonly onDidChangeWindowState = this._onDidChangeWindowState.event;

	constructor(
		@IHucodeHostedOmniWebConnectionService
		connectionService: IHucodeHostedOmniWebConnectionService,
	) {
		super();

		if (!connectionService.isHosted) {
			return;
		}

		let disposed = false;
		this._register({ dispose: () => { disposed = true; } });
		this.connected = connectionService.whenConnected().then(connection => {
			const shell = ProxyChannel.toService<IHucodeShellService>(
				connection.ipcClient.getChannel(HUCODE_OMNI_WEB_SHELL_CHANNEL)
			);
			if (!disposed) {
				this._register(shell.onDidChangeWindowState(change => {
					this.state = change.state;
					this._onDidChangeWindowState.fire({
						windowId: this.windowId,
						state: change.state,
					});
				}));
			}
			return { shell, shellWindowId: connection.shellWindowId };
		});
	}

	private async withShell<T>(
		fallback: () => T,
		run: (shell: IHucodeShellService, shellWindowId: number) => Promise<T>
	): Promise<T> {
		if (!this.connected) {
			return fallback();
		}

		const { shell, shellWindowId } = await this.connected;
		return run(shell, shellWindowId);
	}

	async getWindowState(
		_windowId: number
	): Promise<IHucodeHostedWorkspaceState> {
		return this.withShell(() => this.state, async (shell, windowId) => {
			this.state = await shell.getWindowState(windowId);
			return this.state;
		});
	}

	findHostedWorkspaceByPath(
		worktreePath: string
	): Promise<IHucodeHostedWorkspaceOwner | undefined> {
		return this.withShell(() => undefined, shell =>
			shell.findHostedWorkspaceByPath(worktreePath));
	}

	focusHostedWorkspaceByPath(
		worktreePath: string,
		projectId?: string
	): Promise<boolean> {
		return this.withShell(() => false, shell =>
			shell.focusHostedWorkspaceByPath(worktreePath, projectId));
	}

	focusNormalWindowByPath(worktreePath: string): Promise<boolean> {
		return this.withShell(() => false, shell =>
			shell.focusNormalWindowByPath(worktreePath));
	}

	openWorkspace(
		_windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		return this.withShell(() => this.state, (shell, windowId) =>
			shell.openWorkspace(windowId, worktreePath, projectId));
	}

	openFilesInWorkspace(
		_windowId: number,
		worktreePath: string,
		request: INativeOpenFileRequest,
		projectId?: string
	): Promise<boolean> {
		return this.withShell(() => false, (shell, windowId) =>
			shell.openFilesInWorkspace(
				windowId,
				worktreePath,
				request,
				projectId
			));
	}

	openFilesInActiveWorkspace(
		_windowId: number,
		request: INativeOpenFileRequest
	): Promise<boolean> {
		return this.withShell(() => false, (shell, windowId) =>
			shell.openFilesInActiveWorkspace(windowId, request));
	}

	closeWorkspace(
		_windowId: number,
		instanceId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		return this.withShell(() => this.state, (shell, windowId) =>
			shell.closeWorkspace(windowId, instanceId));
	}

	reopenWorkspaceInNormalWindow(
		_windowId: number,
		instanceId: string
	): Promise<boolean> {
		return this.withShell(() => false, (shell, windowId) =>
			shell.reopenWorkspaceInNormalWindow(windowId, instanceId));
	}

	notifyHostedWorkspaceReady(
		_windowId: number,
		instanceId: string
	): Promise<void> {
		return this.withShell(() => undefined, (shell, windowId) =>
			shell.notifyHostedWorkspaceReady(windowId, instanceId));
	}

	focusWorkspace(_windowId: number): Promise<void> {
		return this.withShell(() => undefined, (shell, windowId) =>
			shell.focusWorkspace(windowId));
	}

	focusShell(_windowId: number): Promise<void> {
		return this.withShell(() => undefined, (shell, windowId) =>
			shell.focusShell(windowId));
	}

	setProjectsSidebarVisible(
		_windowId: number,
		visible: boolean
	): Promise<void> {
		return this.withShell(() => undefined, (shell, windowId) =>
			shell.setProjectsSidebarVisible(windowId, visible));
	}

	setProjectSwitcherNavigationState(
		_windowId: number,
		canGoBack: boolean,
		canGoForward: boolean
	): Promise<void> {
		return this.withShell(() => undefined, (shell, windowId) =>
			shell.setProjectSwitcherNavigationState(
				windowId,
				canGoBack,
				canGoForward
			));
	}

	runActionInShell(
		_windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		return this.withShell(() => false, (shell, windowId) =>
			shell.runActionInShell(windowId, request));
	}

	runActionInWorkspace(
		_windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		return this.withShell(() => false, (shell, windowId) =>
			shell.runActionInWorkspace(windowId, request));
	}

	runKeybindingInWorkspace(
		_windowId: number,
		request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		return this.withShell(() => false, (shell, windowId) =>
			shell.runKeybindingInWorkspace(windowId, request));
	}

	triggerPasteInWorkspace(_windowId: number): Promise<boolean> {
		return this.withShell(() => false, (shell, windowId) =>
			shell.triggerPasteInWorkspace(windowId));
	}

	reloadWorkspace(_windowId: number): Promise<void> {
		return this.withShell(() => undefined, (shell, windowId) =>
			shell.reloadWorkspace(windowId));
	}

	toggleWorkspaceDevTools(_windowId: number): Promise<boolean> {
		return this.withShell(() => false, (shell, windowId) =>
			shell.toggleWorkspaceDevTools(windowId));
	}

	layoutWorkspace(_windowId: number, bounds: IRectangle): Promise<void> {
		return this.withShell(() => undefined, (shell, windowId) =>
			shell.layoutWorkspace(windowId, bounds));
	}

	async captureWorkspaceScreenshot(
		_windowId: number,
		_rect?: IRectangle,
		_quality?: number
	): Promise<VSBuffer | undefined> {
		return undefined;
	}

	setWorkspaceOverlayOcclusion(
		_windowId: number,
		occluded: boolean
	): Promise<void> {
		return this.withShell(() => undefined, (shell, windowId) =>
			shell.setWorkspaceOverlayOcclusion(windowId, occluded));
	}

	shutdownWindowWorkspaces(
		_windowId: number,
		reason: ShutdownReason
	): Promise<void> {
		return this.withShell(() => undefined, (shell, windowId) =>
			shell.shutdownWindowWorkspaces(windowId, reason));
	}
}

registerSingleton(
	IHucodeShellService,
	HostedOmniWebShellService,
	InstantiationType.Delayed
);
