/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventHelper, getActiveElement } from '../../base/browser/dom.js';
import { URI } from '../../base/common/uri.js';
import { DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { ILogService } from '../../platform/log/common/log.js';
import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import {
	HucodeShellControllerUnavailableError,
	IHucodeShellControllerService,
} from
	'../../platform/window/common/hucodeShellControllerService.js';
import {
	HUCODE_OMNI_LOCAL_INPUT_SELECTOR,
	HUCODE_OMNI_PROJECTS_SELECTOR,
	IHucodeOmniCommandForwardingScope,
	isHucodeForwardedFromOmniShell,
	isHucodeOmniShellAction,
	isHucodeOmniShellLayoutAction,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import '../../platform/window/common/hucodeOmniCommandForwardingContext.js';
import {
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
} from '../../platform/window/common/window.js';
import { INativeWorkbenchEnvironmentService } from '../services/environment/electron-browser/environmentService.js';

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
		private readonly commandForwardingScope:
			IHucodeOmniCommandForwardingScope,
		@INativeWorkbenchEnvironmentService
		private readonly nativeEnvironmentService:
			INativeWorkbenchEnvironmentService,
		@IHucodeShellControllerService
		private readonly shellControllerService:
			IHucodeShellControllerService,
		@ILogService
		private readonly logService: ILogService,
	) { }

	/**
	 * Registers Omni command forwarding for NativeWindow shell integration.
	 */
	registerWindowListeners(
		handlers: IHucodeOmniCommandForwardingWindowHandlers
	): IDisposable {
		const disposables = new DisposableStore();
		disposables.add(this.registerClipboardListeners(
			handlers.document,
			handlers
		));

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
	registerClipboardListeners(
		targetDocument: Document,
		handlers: IHucodeOmniCommandForwardingWindowHandlers
	): IDisposable {
		const disposables = new DisposableStore();

		for (const [eventType, actionId] of HUCODE_OMNI_CLIPBOARD_ACTIONS) {
			disposables.add(addDisposableListener(
				targetDocument,
				eventType,
				e => {
					void this.handleClipboardEvent(e, actionId, handlers);
				}
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

	shouldForwardShellInvocation(actionId?: string): boolean {
		const forwardingDisabled = actionId
			? this.commandForwardingScope.isForwardingDisabledFor(actionId)
			: this.commandForwardingScope.isForwardingDisabled;
		return !forwardingDisabled &&
			this.nativeEnvironmentService.isOmniWindow &&
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
			return await this.commandForwardingScope
				.runWithForwardingDisabled(callback);
		}

		return await callback();
	}

	private async tryForwardActionToWorkspace(
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		try {
			return await this.shellControllerService
				.runActionInWorkspace(request);
		} catch (error) {
			this.logService.warn(
				`Failed to forward Omni shell action ${request.id}: ${error}`
			);
			return false;
		}
	}

	/**
	 * Forwards copy or cut, retrying locally only when dispatch definitely did
	 * not start; ambiguous transport failures are consumed for at-most-once use.
	 */
	private async tryForwardClipboardActionToWorkspace(
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		try {
			return await this.shellControllerService
				.runActionInWorkspace(request);
		} catch (error) {
			this.logService.warn(
				`Failed to forward Omni shell action ${request.id}: ${error}`
			);
			// Once dispatch begins, a transport failure is ambiguous: the hosted
			// workbench may already have applied copy or cut. Only a definitive
			// pre-dispatch absence is safe to retry in the shell.
			return !(error instanceof HucodeShellControllerUnavailableError);
		}
	}

	/** Forwards a keybinding and permits local fallback after any failure. */
	private async tryForwardKeybindingToWorkspace(
		request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		try {
			return await this.shellControllerService
				.runKeybindingInWorkspace(request);
		} catch (error) {
			this.logService.warn(
				'Failed to forward Omni shell keybinding ' +
				`${request.userSettingsLabel}: ${error}`
			);
			return false;
		}
	}

	async handleClipboardEvent(
		event: Event,
		actionId: string,
		handlers: IHucodeOmniCommandForwardingWindowHandlers
	): Promise<void> {
		if (!this.shouldForwardShellInvocation(actionId)) {
			return;
		}

		// Clipboard cancellation must happen during event dispatch.
		EventHelper.stop(event, true);
		const request: INativeRunActionInWindowRequest = {
			id: actionId,
			from: 'menu'
		};
		if (await this.tryForwardClipboardActionToWorkspace(request)) {
			return;
		}

		try {
			await this.commandForwardingScope.runWithForwardingDisabledFor(
				actionId,
				() => handlers.executeCommand(actionId)
			);
		} catch (error) {
			handlers.onActionError(error);
		}
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
