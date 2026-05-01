/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement } from '../../base/browser/dom.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import {
	HUCODE_OMNI_LOCAL_INPUT_SELECTOR,
	HUCODE_OMNI_PROJECTS_SELECTOR,
	isHucodeForwardedFromOmniShell,
	isHucodeOmniShellAction,
	isHucodeOmniShellKeybinding,
	isHucodeOmniShellLayoutAction,
	isHucodeOmniShellLayoutKeybinding,
	withHucodeOmniShellCommandForwardingDisabled,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import {
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
} from '../../platform/window/common/window.js';
import { INativeWorkbenchEnvironmentService } from '../services/environment/electron-browser/environmentService.js';

const HUCODE_SHELL_CHANNEL_NAME = 'hucodeShell';

export const HUCODE_OMNI_CLIPBOARD_ACTIONS = new Map<string, string>([
	['copy', 'editor.action.clipboardCopyAction'],
	['cut', 'editor.action.clipboardCutAction'],
]);

export class HucodeOmniCommandForwarding {

	constructor(
		private readonly nativeEnvironmentService:
			INativeWorkbenchEnvironmentService,
		private readonly mainProcessService: IMainProcessService,
		private readonly logService: ILogService,
	) { }

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

		if (isHucodeOmniShellKeybinding(request.userSettingsLabel)) {
			return false;
		}

		const forwarded = await this.tryForwardKeybindingToWorkspace(request);
		return forwarded ||
			isHucodeOmniShellLayoutKeybinding(request.userSettingsLabel);
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

	private isActiveElementInside(selector: string): boolean {
		const activeElement = getActiveElement();
		return activeElement instanceof Element &&
			!!activeElement.closest(selector);
	}

	private isShellLocalInputFocused(): boolean {
		return this.isActiveElementInside(HUCODE_OMNI_LOCAL_INPUT_SELECTOR);
	}
}
