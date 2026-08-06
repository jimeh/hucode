/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import {
	areHucodeHostedShellStatesEqual,
	HucodeHostedShellCapability,
	createHucodeHostedShellClient,
	HUCODE_HOSTED_SHELL_CHANNEL,
	HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedNavigationRequest,
	IHucodeHostedReadyResult,
	IHucodeHostedShellService,
	IHucodeHostedShellState,
	isSupportedHucodeHostedNavigationRequest,
	negotiateHucodeHostedShellCapabilities,
} from '../../platform/window/common/hucodeHostedShellService.js';
import {
	createLegacyHucodeHostedShellActionRequest,
	isHucodeHostedShellAction,
} from
	'../../platform/window/common/hucodeHostedShellActions.js';
import { IRectangle } from '../../platform/window/common/window.js';
import { HUCODE_OMNI_WEB_SHELL_CHANNEL } from
	'../../platform/window/common/hucodeOmniWebMessages.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';
import {
	IHucodeHostedOmniWebConnectionService,
} from './hostedOmniWebConnection.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../common/omniWindow.js';

/** Client path selected from the parent shell's explicit handshake. */
export type HostedOmniWebShellClientMode =
	| 'current'
	| 'legacy'
	| 'unavailable';

/** Selects legacy only when the parent omitted capability versioning. */
export function getHostedOmniWebShellClientMode(
	protocolVersion: number | undefined,
	capabilities: readonly HucodeHostedShellCapability[] | undefined
): HostedOmniWebShellClientMode {
	if (negotiateHucodeHostedShellCapabilities(
		protocolVersion,
		capabilities
	)) {
		return 'current';
	}
	return protocolVersion === undefined ? 'legacy' : 'unavailable';
}

/**
 * Hosted iframe client for the narrow shell capability.
 *
 * A missing capability version identifies the selected one-generation legacy
 * window: a new child connected to an older shell. That path adapts only this
 * narrow interface to the old channel and never exposes the old service to
 * current hosted contributions.
 */
export class HostedOmniWebShellService extends Disposable
	implements IHucodeHostedShellService {

	declare readonly _serviceBrand: undefined;

	private readonly connected: Promise<IHucodeHostedShellService> | undefined;
	private state = HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
	private readonly _onDidChangeState =
		this._register(new Emitter<IHucodeHostedShellState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		@IHucodeHostedOmniWebConnectionService
		connectionService: IHucodeHostedOmniWebConnectionService,
		@IWorkbenchEnvironmentService
		environmentService: IWorkbenchEnvironmentService,
	) {
		super();

		const instanceId = environmentService.hostedInstanceId;
		if (!connectionService.isHosted || !instanceId) {
			return;
		}

		let disposed = false;
		this._register({ dispose: () => { disposed = true; } });
		this.connected = connectionService.whenConnected().then(connection => {
			const mode = getHostedOmniWebShellClientMode(
				connection.hostedShellProtocolVersion,
				connection.hostedShellCapabilities
			);
			const shell = mode === 'current'
				? createHucodeHostedShellClient(connection.ipcClient.getChannel(
					HUCODE_HOSTED_SHELL_CHANNEL
				))
				: mode === 'legacy'
					? createLegacyHostedShellClient(
						ProxyChannel.toService<IHucodeShellService>(
							connection.ipcClient.getChannel(
								HUCODE_OMNI_WEB_SHELL_CHANNEL
							)
						),
						connection.shellWindowId,
						instanceId
					)
					: createUnavailableHostedShellClient();
			if (!disposed) {
				this._register(shell.onDidChangeState(state => {
					this.state = state;
					this._onDidChangeState.fire(state);
				}));
			}
			return shell;
		});
	}

	private async withShell<T>(
		fallback: () => T,
		run: (shell: IHucodeHostedShellService) => Promise<T>
	): Promise<T> {
		return this.connected ? run(await this.connected) : fallback();
	}

	async getState(): Promise<IHucodeHostedShellState> {
		return this.withShell(() => this.state, async shell => {
			this.state = await shell.getState();
			return this.state;
		});
	}

	notifyReady(): Promise<IHucodeHostedReadyResult> {
		return this.withShell(
			() => ({ outcome: HucodeHostedShellOperationOutcome.Unavailable }),
			shell => shell.notifyReady()
		);
	}

	closeSelf() {
		return this.runOperation(shell => shell.closeSelf());
	}

	reopenSelfInNormalWindow() {
		return this.runOperation(shell => shell.reopenSelfInNormalWindow());
	}

	reloadSelf() {
		return this.runOperation(shell => shell.reloadSelf());
	}

	focusSelf() {
		return this.runOperation(shell => shell.focusSelf());
	}

	focusShell() {
		return this.runOperation(shell => shell.focusShell());
	}

	requestShellAction(action: Parameters<
		IHucodeHostedShellService['requestShellAction']
	>[0]) {
		return this.runOperation(shell => shell.requestShellAction(action));
	}

	navigateToFolder(request: IHucodeHostedNavigationRequest) {
		return this.runOperation(shell => shell.navigateToFolder(request));
	}

	triggerPasteInSelf() {
		return this.runOperation(shell => shell.triggerPasteInSelf());
	}

	captureSelfScreenshot(
		rect?: IRectangle,
		quality?: number
	): Promise<VSBuffer | undefined> {
		return this.withShell(
			() => undefined,
			shell => shell.captureSelfScreenshot(rect, quality)
		);
	}

	private runOperation(
		run: (
			shell: IHucodeHostedShellService
		) => Promise<HucodeHostedShellOperationOutcome>
	): Promise<HucodeHostedShellOperationOutcome> {
		return this.withShell(
			() => HucodeHostedShellOperationOutcome.Unavailable,
			run
		);
	}
}

function createUnavailableHostedShellClient(): IHucodeHostedShellService {
	const unavailable = () => Promise.resolve(
		HucodeHostedShellOperationOutcome.Unavailable
	);
	return {
		_serviceBrand: undefined,
		onDidChangeState: Event.None,
		getState: async () => HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
		notifyReady: async () => ({
			outcome: HucodeHostedShellOperationOutcome.Unavailable,
		}),
		closeSelf: unavailable,
		reopenSelfInNormalWindow: unavailable,
		reloadSelf: unavailable,
		focusSelf: unavailable,
		focusShell: unavailable,
		requestShellAction: unavailable,
		navigateToFolder: unavailable,
		triggerPasteInSelf: unavailable,
		captureSelfScreenshot: async () => undefined,
	};
}

/** Adapts a trusted old-parent channel to the narrow current client surface. */
export function createLegacyHostedShellClient(
	legacy: IHucodeShellService,
	windowId: number,
	instanceId: string
): IHucodeHostedShellService {
	const project = (state: IHucodeHostedWorkspaceState) => {
		const self = state.instances.find(instance =>
			instance.instanceId === instanceId);
		return self ? {
			available: true,
			projectsSidebarVisible: state.projectsSidebarVisible,
			projectSwitcherCanGoBack: state.projectSwitcherCanGoBack,
			projectSwitcherCanGoForward: state.projectSwitcherCanGoForward,
			lifecycleState: self?.state,
			active: state.activeInstanceId === instanceId,
			visible: self.visible,
		} satisfies IHucodeHostedShellState :
			HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
	};
	const onDidChangeState = Event.latch(
		Event.map(
			Event.filter(legacy.onDidChangeWindowState, change =>
				change.windowId === windowId),
			change => project(change.state)
		),
		areHucodeHostedShellStatesEqual
	);
	const accepted = (value: boolean) => value
		? HucodeHostedShellOperationOutcome.Accepted
		: HucodeHostedShellOperationOutcome.Unavailable;
	const getLegacyState = () => legacy.getWindowState(windowId);
	const isActiveVisible = async () => {
		const state = await getLegacyState();
		const self = state.instances.find(candidate =>
			candidate.instanceId === instanceId);
		return !!self && state.activeInstanceId === instanceId && self.visible;
	};

	return {
		_serviceBrand: undefined,
		onDidChangeState,
		getState: async () => project(await getLegacyState()),
		async notifyReady() {
			await legacy.notifyHostedWorkspaceReady(windowId, instanceId);
			const state = project(await getLegacyState());
			return {
				outcome: !state.available
					? HucodeHostedShellOperationOutcome.Unavailable
					: state.lifecycleState === 'loading' ||
						state.lifecycleState === 'restore-pending'
						? HucodeHostedShellOperationOutcome.Unavailable
						: HucodeHostedShellOperationOutcome.Accepted,
				state,
			};
		},
		async closeSelf() {
			const state = project(await getLegacyState());
			if (!state.available) {
				return HucodeHostedShellOperationOutcome.Unavailable;
			}
			await legacy.closeWorkspace(windowId, instanceId);
			return HucodeHostedShellOperationOutcome.Accepted;
		},
		async reopenSelfInNormalWindow() {
			return accepted(await legacy.reopenWorkspaceInNormalWindow(
				windowId,
				instanceId
			));
		},
		async reloadSelf() {
			if (!await isActiveVisible()) {
				return HucodeHostedShellOperationOutcome.Rejected;
			}
			await legacy.reloadWorkspace(windowId);
			return HucodeHostedShellOperationOutcome.Accepted;
		},
		async focusSelf() {
			const state = await getLegacyState();
			const self = state.instances.find(candidate =>
				candidate.instanceId === instanceId);
			if (!self) {
				return HucodeHostedShellOperationOutcome.Unavailable;
			}
			if (state.activeInstanceId !== instanceId &&
				!await legacy.focusHostedWorkspaceByPath(
					self.worktreePath,
					self.projectId
				)) {
				return HucodeHostedShellOperationOutcome.Unavailable;
			}
			await legacy.focusWorkspace(windowId);
			return HucodeHostedShellOperationOutcome.Accepted;
		},
		async focusShell() {
			if (!await isActiveVisible()) {
				return HucodeHostedShellOperationOutcome.Rejected;
			}
			await legacy.focusShell(windowId);
			return HucodeHostedShellOperationOutcome.Accepted;
		},
		async requestShellAction(action) {
			if (!isHucodeHostedShellAction(action)) {
				return HucodeHostedShellOperationOutcome.Unsupported;
			}
			if (!await isActiveVisible()) {
				return HucodeHostedShellOperationOutcome.Rejected;
			}
			return accepted(await legacy.runActionInShell(
				windowId,
				createLegacyHucodeHostedShellActionRequest(action)
			));
		},
		async navigateToFolder(request) {
			if (!isSupportedHucodeHostedNavigationRequest(request)) {
				return HucodeHostedShellOperationOutcome.Unsupported;
			}
			if (!await isActiveVisible()) {
				return HucodeHostedShellOperationOutcome.Rejected;
			}
			const resource = URI.revive(request.folderUri);
			await legacy.openAndFocusWorkspace(
				windowId,
				resource.fsPath
			);
			return HucodeHostedShellOperationOutcome.Accepted;
		},
		async triggerPasteInSelf() {
			if (!await isActiveVisible()) {
				return HucodeHostedShellOperationOutcome.Rejected;
			}
			return accepted(await legacy.triggerPasteInWorkspace(windowId));
		},
		async captureSelfScreenshot(rect, quality) {
			return await isActiveVisible()
				? legacy.captureWorkspaceScreenshot(windowId, rect, quality)
				: undefined;
		},
	};
}

registerSingleton(
	IHucodeHostedShellService,
	HostedOmniWebShellService,
	InstantiationType.Delayed
);
