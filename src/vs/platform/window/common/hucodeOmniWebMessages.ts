/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeOpenFileRequest } from './window.js';

/**
 * Channel exposing the Omni web shell service to hosted iframe workbenches.
 */
export const HUCODE_OMNI_WEB_SHELL_CHANNEL = 'hucodeOmniWebShell';

/**
 * Channel exposing a hosted iframe workbench to the Omni web shell.
 */
export const HUCODE_OMNI_WEB_WORKBENCH_CHANNEL = 'hucodeOmniWebWorkbench';

/**
 * Parent-to-iframe window message names for hosted Omni web workbenches.
 *
 * These bootstrap the MessagePort IPC connection; all shell/workbench calls
 * flow over the transferred port instead of window messages.
 */
export const enum HucodeOmniWebParentMessageType {
	Port = 'hucode.omni.port',
}

/**
 * Iframe-to-parent window message names for hosted Omni web workbenches.
 */
export const enum HucodeOmniWebChildMessageType {
	Ready = 'hucode.omni.hostedWorkbenchReady',
	Focus = 'hucode.omni.hostedWorkbenchFocus',
}

/**
 * Message transferring the shell IPC port into a hosted iframe workbench.
 */
export interface IHucodeOmniWebPortMessage {
	readonly type: HucodeOmniWebParentMessageType.Port;
	readonly instanceId: string;
	readonly windowId: number;
}

/**
 * Message sent by a hosted iframe when its workbench is ready.
 */
export interface IHucodeOmniWebReadyMessage {
	readonly type: HucodeOmniWebChildMessageType.Ready;
	readonly instanceId: string;
}

/**
 * Focus status update sent by a hosted iframe workbench.
 */
export interface IHucodeOmniWebFocusMessage {
	readonly type: HucodeOmniWebChildMessageType.Focus;
	readonly instanceId: string;
	readonly focused: boolean;
}

export type HucodeOmniWebParentMessage = IHucodeOmniWebPortMessage;

export type HucodeOmniWebChildMessage =
	| IHucodeOmniWebReadyMessage
	| IHucodeOmniWebFocusMessage;

/**
 * Hosted iframe workbench operations callable by the Omni web shell.
 */
export interface IHucodeOmniWebWorkbenchClient {
	/**
	 * Runs a workbench command inside the hosted workbench.
	 */
	runCommand(commandId: string, args: readonly unknown[]): Promise<boolean>;

	/**
	 * Opens a forwarded file-open request inside the hosted workbench.
	 */
	openFiles(request: INativeOpenFileRequest): Promise<boolean>;

	/**
	 * Runs the hosted workbench shutdown handshake before unload.
	 */
	prepareUnload(): Promise<void>;
}
