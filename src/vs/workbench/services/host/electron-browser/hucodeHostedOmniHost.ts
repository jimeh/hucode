/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveDocument } from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { NativeHostService } from '../../../../platform/native/common/nativeHostService.js';
import { IRectangle } from '../../../../platform/window/common/window.js';
import { INativeWorkbenchEnvironmentService } from '../../environment/electron-browser/environmentService.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';

/**
 * Lifecycle state subset needed by hosted-workbench focus tracking.
 */
export interface IHucodeHostedWorkbenchInstance {
	readonly instanceId: string;
	readonly state: string;
	readonly visible: boolean;
}

/**
 * Hosted workspace state subset needed by workbench host integration.
 */
export interface IHucodeHostedWorkspaceState {
	readonly activeInstanceId?: string;
	readonly instances: readonly IHucodeHostedWorkbenchInstance[];
}

/**
 * Shell service subset used by native host integration. The service id matches
 * the full Hucode shell service registered by the Omni shell.
 */
export interface IHucodeShellService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeWindowState: Event<{
		readonly windowId: number;
		readonly state: IHucodeHostedWorkspaceState;
	}>;
	getWindowState(windowId: number): Promise<IHucodeHostedWorkspaceState>;
	focusHostedWorkspaceByPath(
		worktreePath: string,
		projectId?: string
	): Promise<boolean>;
	focusNormalWindowByPath(worktreePath: string): Promise<boolean>;
	openWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState>;
	focusWorkspace(windowId: number): Promise<void>;
	captureWorkspaceScreenshot(
		windowId: number,
		rect?: IRectangle,
		quality?: number
	): Promise<VSBuffer | undefined>;
}

export const IHucodeShellService =
	createDecorator<IHucodeShellService>('hucodeShellService');

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
		private readonly shellService: IHucodeShellService,
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
		if (
			!this.environmentService.isHostedOmniWorkspace ||
			!this.environmentService.hostedInstanceId
		) {
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

		this._register(Event.filter(
			this.shellService.onDidChangeWindowState,
			e => e.windowId === this.nativeHostService.windowId,
			this._store
		)(e => this.updateInstanceState(e.state)));

		void this.nativeHostService.getActiveWindowId().then(activeWindowId => {
			this.updateOwnerWindowFocus(
				activeWindowId === this.nativeHostService.windowId
			);
		}).catch(onUnexpectedError);

		void this.updateWorkspaceState().catch(onUnexpectedError);
	}

	private async updateWorkspaceState(): Promise<void> {
		if (
			!this.environmentService.isHostedOmniWorkspace ||
			!this.environmentService.hostedInstanceId
		) {
			return;
		}

		const state = await this.shellService.getWindowState(
			this.nativeHostService.windowId
		);
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

	private updateInstanceState(state: IHucodeHostedWorkspaceState): void {
		const instanceId = this.environmentService.hostedInstanceId;
		const instance = state.instances.find(candidate =>
			candidate.instanceId === instanceId
		);
		const activeAndVisible =
			state.activeInstanceId === instanceId &&
			instance?.state === 'active' &&
			instance.visible;

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
	shellService: IHucodeShellService,
	windowId: number,
	rect?: IRectangle
): Promise<VSBuffer | undefined> | undefined {
	if (!environmentService.isHostedOmniWorkspace) {
		return undefined;
	}

	return shellService.captureWorkspaceScreenshot(windowId, rect);
}
