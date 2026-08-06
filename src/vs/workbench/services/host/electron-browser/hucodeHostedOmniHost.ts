/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveDocument } from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { NativeHostService } from '../../../../platform/native/common/nativeHostService.js';
import { IRectangle } from '../../../../platform/window/common/window.js';
import {
	IHucodeHostedShellService,
	IHucodeHostedShellState,
} from '../../../../platform/window/common/hucodeHostedShellService.js';
import { INativeWorkbenchEnvironmentService } from '../../environment/electron-browser/environmentService.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';

/**
 * Creates the workbench native-host service with Hucode hosted-workspace
 * adjustments when the current renderer is embedded in an Omni shell.
 */
export function createHucodeWorkbenchNativeHostService(
	environmentService: INativeWorkbenchEnvironmentService,
	mainProcessService: IMainProcessService
): INativeHostService {
	const service = new NativeHostService(
		environmentService.window.id,
		mainProcessService
	) as unknown as INativeHostService;

	if (!environmentService.isHostedOmniWorkspace) {
		return service;
	}

	return new Proxy(service, {
		get(target, property, receiver) {
			if (
				property === 'setRepresentedFilename' ||
				property === 'setDocumentEdited'
			) {
				return async () => { };
			}

			return Reflect.get(target, property, receiver);
		}
	}) as INativeHostService;
}

/**
 * Tracks whether a hosted Omni workbench should report host focus based on
 * both the owning shell window and the active hosted workspace instance.
 */
export class HucodeHostedOmniFocusTracker extends Disposable {

	private readonly _onDidChangeFocus = this._register(new Emitter<void>());
	readonly onDidChangeFocus = this._onDidChangeFocus.event;

	private ownerWindowFocused: boolean;
	private instanceActiveAndVisible = false;

	constructor(
		private readonly nativeHostService: INativeHostService,
		private readonly environmentService: IWorkbenchEnvironmentService,
		private readonly hostedShellService: IHucodeHostedShellService,
		private readonly hasDocumentFocus = () => getActiveDocument().hasFocus()
	) {
		super();

		this.ownerWindowFocused = this.hasDocumentFocus();
		this.registerListeners();
	}

	get hasFocus(): boolean | undefined {
		if (!this.environmentService.isHostedOmniWorkspace) {
			return undefined;
		}

		return this.instanceActiveAndVisible &&
			(this.hasDocumentFocus() || this.ownerWindowFocused);
	}

	async hadLastFocus(): Promise<boolean | undefined> {
		if (!this.environmentService.isHostedOmniWorkspace) {
			return undefined;
		}

		const activeWindowId = await this.nativeHostService.getActiveWindowId();
		if (typeof activeWindowId === 'undefined') {
			return false;
		}

		const windowHadLastFocus =
			activeWindowId === this.nativeHostService.windowId;
		this.updateOwnerWindowFocus(windowHadLastFocus);
		if (!windowHadLastFocus) {
			return false;
		}

		await this.updateWorkspaceState();
		return this.hasFocus ?? false;
	}

	private registerListeners(): void {
		if (!this.environmentService.isHostedOmniWorkspace) {
			return;
		}

		this._register(Event.filter(
			this.nativeHostService.onDidFocusMainOrAuxiliaryWindow,
			id => id === this.nativeHostService.windowId,
			this._store
		)(() => this.updateOwnerWindowFocus(true)));

		this._register(Event.filter(
			this.nativeHostService.onDidBlurMainOrAuxiliaryWindow,
			id => id === this.nativeHostService.windowId,
			this._store
		)(() => this.updateOwnerWindowFocus(false)));

		this._register(this.hostedShellService.onDidChangeState(state =>
			this.updateInstanceState(state)
		));

		void this.nativeHostService.getActiveWindowId().then(activeWindowId => {
			this.updateOwnerWindowFocus(
				activeWindowId === this.nativeHostService.windowId
			);
		}).catch(onUnexpectedError);

		void this.updateWorkspaceState().catch(onUnexpectedError);
	}

	private async updateWorkspaceState(): Promise<void> {
		if (!this.environmentService.isHostedOmniWorkspace) {
			return;
		}

		const state = await this.hostedShellService.getState();
		this.updateInstanceState(state);
	}

	private updateOwnerWindowFocus(focused: boolean): void {
		if (this.ownerWindowFocused === focused) {
			return;
		}

		const hadFocus = this.hasFocus;
		this.ownerWindowFocused = focused;
		this.fireFocusChangeIfNeeded(hadFocus);
	}

	private updateInstanceState(state: IHucodeHostedShellState): void {
		const activeAndVisible = state.available && state.active &&
			state.visible && state.lifecycleState === 'active';

		if (this.instanceActiveAndVisible === activeAndVisible) {
			return;
		}

		const hadFocus = this.hasFocus;
		this.instanceActiveAndVisible = activeAndVisible;
		this.fireFocusChangeIfNeeded(hadFocus);
	}

	private fireFocusChangeIfNeeded(hadFocus: boolean | undefined): void {
		if (this.hasFocus !== hadFocus) {
			this._onDidChangeFocus.fire();
		}
	}
}

/**
 * Captures the hosted workspace view when screenshots are requested from an
 * embedded Omni workbench.
 */
export function getHucodeHostedOmniScreenshot(
	environmentService: IWorkbenchEnvironmentService,
	hostedShellService: IHucodeHostedShellService,
	rect?: IRectangle
): Promise<VSBuffer | undefined> | undefined {
	if (!environmentService.isHostedOmniWorkspace) {
		return undefined;
	}

	return hostedShellService.captureSelfScreenshot(rect);
}
