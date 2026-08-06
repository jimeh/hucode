/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import {
	areHucodeHostedShellStatesEqual,
	HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedNavigationRequest,
	IHucodeHostedReadyResult,
	IHucodeHostedShellService,
	IHucodeHostedShellState,
} from '../../platform/window/common/hucodeHostedShellService.js';
import {
	createLegacyHucodeHostedShellActionRequest,
	isHucodeHostedShellAction,
} from
	'../../platform/window/common/hucodeHostedShellActions.js';
import { IRectangle } from '../../platform/window/common/window.js';
import { INativeWorkbenchEnvironmentService } from
	'../../workbench/services/environment/electron-browser/environmentService.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../common/omniWindow.js';

/**
 * Temporary desktop adapter used until the per-instance port lands in PR 3.
 * It exposes only the shared narrow service and never forwards caller-selected
 * identities, command IDs, paste targets, or screenshot targets.
 */
export class DesktopHostedShellServiceAdapter extends Disposable
	implements IHucodeHostedShellService {

	declare readonly _serviceBrand: undefined;

	private readonly windowId: number;
	private readonly instanceId: string | undefined;
	private readonly _onDidChangeState =
		this._register(new Emitter<IHucodeHostedShellState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		@INativeWorkbenchEnvironmentService
		environmentService: INativeWorkbenchEnvironmentService,
		@IHucodeShellService private readonly shellService: IHucodeShellService,
	) {
		super();
		this.windowId = environmentService.window.id;
		this.instanceId = environmentService.isHostedOmniWorkspace
			? environmentService.hostedInstanceId
			: undefined;
		if (!this.instanceId) {
			return;
		}
		let last = HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
		this._register(shellService.onDidChangeWindowState(change => {
			if (change.windowId !== this.windowId) {
				return;
			}
			const next = this.project(change.state);
			if (!areHucodeHostedShellStatesEqual(last, next)) {
				last = next;
				this._onDidChangeState.fire(next);
			}
		}));
	}

	async getState(): Promise<IHucodeHostedShellState> {
		return this.instanceId
			? this.project(await this.shellService.getWindowState(this.windowId))
			: HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
	}

	async notifyReady(): Promise<IHucodeHostedReadyResult> {
		if (!this.instanceId) {
			return { outcome: HucodeHostedShellOperationOutcome.Unavailable };
		}
		await this.shellService.notifyHostedWorkspaceReady(
			this.windowId,
			this.instanceId
		);
		const state = await this.getState();
		return {
			outcome: state.available
				? HucodeHostedShellOperationOutcome.Accepted
				: HucodeHostedShellOperationOutcome.Unavailable,
			state: state.available ? state : undefined,
		};
	}

	async closeSelf() {
		if (!this.instanceId || !(await this.getState()).available) {
			return HucodeHostedShellOperationOutcome.Unavailable;
		}
		await this.shellService.closeWorkspace(this.windowId, this.instanceId);
		return HucodeHostedShellOperationOutcome.Accepted;
	}

	async reopenSelfInNormalWindow() {
		return this.instanceId && await this.shellService
			.reopenWorkspaceInNormalWindow(this.windowId, this.instanceId)
			? HucodeHostedShellOperationOutcome.Accepted
			: HucodeHostedShellOperationOutcome.Unavailable;
	}

	async reloadSelf() {
		const state = await this.getState();
		if (!state.active || !state.visible) {
			return HucodeHostedShellOperationOutcome.Rejected;
		}
		await this.shellService.reloadWorkspace(this.windowId);
		return HucodeHostedShellOperationOutcome.Accepted;
	}

	async focusSelf() {
		if (!this.instanceId) {
			return HucodeHostedShellOperationOutcome.Unavailable;
		}
		const state = await this.shellService.getWindowState(this.windowId);
		const self = state.instances.find(instance =>
			instance.instanceId === this.instanceId);
		if (!self) {
			return HucodeHostedShellOperationOutcome.Unavailable;
		}
		if (!state.activeInstanceId || state.activeInstanceId !== self.instanceId) {
			if (!await this.shellService.focusHostedWorkspaceByPath(
				self.worktreePath,
				self.projectId
			)) {
				return HucodeHostedShellOperationOutcome.Unavailable;
			}
		}
		await this.shellService.focusWorkspace(this.windowId);
		return HucodeHostedShellOperationOutcome.Accepted;
	}

	async focusShell() {
		if (!await this.isActiveVisible()) {
			return HucodeHostedShellOperationOutcome.Rejected;
		}
		await this.shellService.focusShell(this.windowId);
		return HucodeHostedShellOperationOutcome.Accepted;
	}

	async requestShellAction(action: Parameters<
		IHucodeHostedShellService['requestShellAction']
	>[0]) {
		if (!isHucodeHostedShellAction(action)) {
			return HucodeHostedShellOperationOutcome.Unsupported;
		}
		if (!await this.isActiveVisible()) {
			return HucodeHostedShellOperationOutcome.Rejected;
		}
		return await this.shellService.runActionInShell(
			this.windowId,
			createLegacyHucodeHostedShellActionRequest(action)
		)
			? HucodeHostedShellOperationOutcome.Accepted
			: HucodeHostedShellOperationOutcome.Unavailable;
	}

	navigateToFolder(
		_request: IHucodeHostedNavigationRequest
	): Promise<HucodeHostedShellOperationOutcome> {
		return Promise.resolve(HucodeHostedShellOperationOutcome.Unavailable);
	}

	triggerPasteInSelf(): Promise<HucodeHostedShellOperationOutcome> {
		return Promise.resolve(HucodeHostedShellOperationOutcome.Unavailable);
	}

	captureSelfScreenshot(
		_rect?: IRectangle,
		_quality?: number
	): Promise<VSBuffer | undefined> {
		return Promise.resolve(undefined);
	}

	private async isActiveVisible(): Promise<boolean> {
		const state = await this.getState();
		return state.available && state.active && state.visible;
	}

	private project(state: IHucodeHostedWorkspaceState): IHucodeHostedShellState {
		const self = state.instances.find(instance =>
			instance.instanceId === this.instanceId);
		return self ? {
			available: true,
			projectsSidebarVisible: state.projectsSidebarVisible,
			projectSwitcherCanGoBack: state.projectSwitcherCanGoBack,
			projectSwitcherCanGoForward: state.projectSwitcherCanGoForward,
			lifecycleState: self.state,
			active: state.activeInstanceId === self.instanceId,
			visible: self.visible,
		} : HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
	}
}

registerSingleton(
	IHucodeHostedShellService,
	DesktopHostedShellServiceAdapter,
	InstantiationType.Delayed
);
