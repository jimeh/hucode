/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventHelper, getActiveElement } from '../../base/browser/dom.js';
import { URI } from '../../base/common/uri.js';
import { DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import {
	HUCODE_OMNI_LOCAL_INPUT_SELECTOR,
	HUCODE_OMNI_PROJECTS_SELECTOR,
	isHucodeForwardedFromOmniShell,
	isHucodeOmniShellAction,
	isHucodeOmniShellLayoutAction,
	withHucodeOmniShellCommandForwardingDisabled,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import {
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
} from '../../platform/window/common/window.js';
import { INativeWorkbenchEnvironmentService } from '../services/environment/electron-browser/environmentService.js';

const HUCODE_SHELL_CHANNEL_NAME = 'hucodeShell';

const HUCODE_OMNI_CLIPBOARD_ACTIONS = new Map<string, string>([
	['copy', 'editor.action.clipboardCopyAction'],
	['cut', 'editor.action.clipboardCutAction'],
]);

/**
 * Callbacks used by Hucode Omni command forwarding to invoke local workbench
 * behavior without depending on NativeWindow internals.
 */
export interface IHucodeOmniCommandForwardingWindowHandlers {
	readonly document: Document;
	readonly getActiveEditorResource: () => URI | undefined;
	readonly executeCommand: (
		commandId: string,
		...args: unknown[]
	) => Promise<unknown>;
	readonly dispatchKeybinding: (
		userSettingsLabel: string,
		target: Element
	) => void;
	readonly onActionExecuted: (
		request: INativeRunActionInWindowRequest
	) => void;
	readonly onActionError: (error: unknown) => void;
}

export class HucodeOmniCommandForwarding {

	constructor(
		private readonly nativeEnvironmentService:
			INativeWorkbenchEnvironmentService,
		private readonly mainProcessService: IMainProcessService,
		private readonly logService: ILogService,
	) { }

	/**
	 * Registers Omni command forwarding for NativeWindow shell integration.
	 */
	registerWindowListeners(
		handlers: IHucodeOmniCommandForwardingWindowHandlers
	): IDisposable {
		const disposables = new DisposableStore();
		disposables.add(this.registerClipboardListeners(handlers.document));

		const runActionHandler = (_event: unknown, ...argsRaw: unknown[]) => {
			const request = argsRaw[0] as INativeRunActionInWindowRequest;
			void this.handleRunActionInWindow(request, handlers);
		};
		ipcRenderer.on('vscode:runAction', runActionHandler);
		disposables.add(toDisposable(() =>
			ipcRenderer.removeListener('vscode:runAction', runActionHandler)
		));

		const runKeybindingHandler = (_event: unknown, ...argsRaw: unknown[]) => {
			const request = argsRaw[0] as INativeRunKeybindingInWindowRequest;
			void this.handleRunKeybindingInWindow(request, handlers);
		};
		ipcRenderer.on('vscode:runKeybinding', runKeybindingHandler);
		disposables.add(toDisposable(() =>
			ipcRenderer.removeListener(
				'vscode:runKeybinding',
				runKeybindingHandler
			)
		));

		return disposables;
	}

	/**
	 * Registers clipboard command forwarding from the Omni shell to the hosted
	 * workspace.
	 */
	registerClipboardListeners(targetDocument: Document): IDisposable {
		const disposables = new DisposableStore();

		for (const [eventType, actionId] of HUCODE_OMNI_CLIPBOARD_ACTIONS) {
			disposables.add(addDisposableListener(
				targetDocument,
				eventType,
				e => this.handleClipboardEvent(e, actionId)
			));
		}

		return disposables;
	}

	/**
	 * Handles a native run-action request from the shell menu, touch bar, or
	 * hosted Omni command forwarding.
	 */
	async handleRunActionInWindow(
		request: INativeRunActionInWindowRequest,
		handlers: IHucodeOmniCommandForwardingWindowHandlers
	): Promise<void> {
		if (await this.forwardActionToWorkspace(request)) {
			return;
		}

		const args = this.getActionArguments(request, handlers);

		try {
			const executeCommand = () =>
				handlers.executeCommand(request.id, ...args);

			await this.runWithForwardingDisabledIfNeeded(
				request,
				executeCommand
			);

			handlers.onActionExecuted(request);
		} catch (error) {
			handlers.onActionError(error);
		}
	}

	/**
	 * Handles a native run-keybinding request from the shell menu or hosted Omni
	 * command forwarding.
	 */
	async handleRunKeybindingInWindow(
		request: INativeRunKeybindingInWindowRequest,
		handlers: IHucodeOmniCommandForwardingWindowHandlers
	): Promise<void> {
		if (await this.forwardKeybindingToWorkspace(request)) {
			return;
		}

		const activeElement = getActiveElement();
		if (!activeElement) {
			return;
		}

		const dispatch = () =>
			handlers.dispatchKeybinding(
				request.userSettingsLabel,
				activeElement
			);

		await this.runWithForwardingDisabledIfNeeded(request, dispatch);
	}

	shouldForwardShellInvocation(): boolean {
		return this.nativeEnvironmentService.isOmniWindow &&
			!this.isActiveElementInside(HUCODE_OMNI_PROJECTS_SELECTOR) &&
			!this.isActiveElementInside(HUCODE_OMNI_LOCAL_INPUT_SELECTOR);
	}

	async forwardActionToWorkspace(
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		if (
			!this.nativeEnvironmentService.isOmniWindow ||
			isHucodeForwardedFromOmniShell(request) ||
			this.isShellLocalInputFocused()
		) {
			return false;
		}

		if (isHucodeOmniShellAction(request.id)) {
			return false;
		}

		const forwarded = await this.tryForwardActionToWorkspace(request);
		return forwarded || isHucodeOmniShellLayoutAction(request.id);
	}

	async forwardKeybindingToWorkspace(
		request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		if (
			!this.nativeEnvironmentService.isOmniWindow ||
			isHucodeForwardedFromOmniShell(request) ||
			this.isShellLocalInputFocused()
		) {
			return false;
		}

		return this.tryForwardKeybindingToWorkspace(request);
	}

	async runWithForwardingDisabledIfNeeded<T>(
		request:
			| INativeRunActionInWindowRequest
			| INativeRunKeybindingInWindowRequest,
		callback: () => T | Promise<T>
	): Promise<T> {
		if (isHucodeForwardedFromOmniShell(request)) {
			return await withHucodeOmniShellCommandForwardingDisabled(callback);
		}

		return await callback();
	}

	private async tryForwardActionToWorkspace(
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		try {
			return await this.callHucodeShellChannel<boolean>(
				'runActionInWorkspace',
				[this.nativeEnvironmentService.window.id, request]
			);
		} catch (error) {
			this.logService.warn(
				`Failed to forward Omni shell action ${request.id}: ${error}`
			);
			return false;
		}
	}

	private async tryForwardKeybindingToWorkspace(
		request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		try {
			return await this.callHucodeShellChannel<boolean>(
				'runKeybindingInWorkspace',
				[this.nativeEnvironmentService.window.id, request]
			);
		} catch (error) {
			this.logService.warn(
				'Failed to forward Omni shell keybinding ' +
				`${request.userSettingsLabel}: ${error}`
			);
			return false;
		}
	}

	private async callHucodeShellChannel<T>(
		command: string,
		args: unknown[]
	): Promise<T> {
		return this.mainProcessService
			.getChannel(HUCODE_SHELL_CHANNEL_NAME)
			.call<T>(command, args);
	}

	private handleClipboardEvent(event: Event, actionId: string): void {
		if (!this.shouldForwardShellInvocation()) {
			return;
		}

		EventHelper.stop(event, true);
		void this.forwardActionToWorkspace({
			id: actionId,
			from: 'menu'
		});
	}

	private getActionArguments(
		request: INativeRunActionInWindowRequest,
		handlers: IHucodeOmniCommandForwardingWindowHandlers
	): unknown[] {
		const args: unknown[] = request.args || [];

		// Touch bar items are context-aware based on the active editor.
		if (request.from === 'touchbar') {
			const resource = handlers.getActiveEditorResource();
			if (resource) {
				args.push(resource);
			}
		} else if (request.from !== 'keybinding' && request.from !== 'systemWideKeybinding') {
			// A keybinding (in-window or OS system-wide) runs the command with
			// exactly the arguments configured in `keybindings.json` (already in
			// `request.args`). We intentionally do not append a `{ from }`
			// sentinel so that commands taking positional arguments receive the
			// same payload they would from a regular in-window keybinding.
			args.push({ from: request.from });
		}

		return args;
	}

	private isActiveElementInside(selector: string): boolean {
		const activeElement = getActiveElement();
		return activeElement instanceof Element &&
			!!activeElement.closest(selector);
	}

	private isShellLocalInputFocused(): boolean {
		return this.isActiveElementInside(HUCODE_OMNI_LOCAL_INPUT_SELECTOR);
	}
}
