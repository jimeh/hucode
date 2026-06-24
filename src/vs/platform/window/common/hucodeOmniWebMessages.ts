/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parent-to-iframe message names for hosted Omni web workbenches.
 */
export const enum HucodeOmniWebParentMessageType {
	BeforeUnload = 'hucode.omni.beforeUnload',
	RunCommand = 'hucode.omni.runCommand',
}

/**
 * Iframe-to-parent message names for hosted Omni web workbenches.
 */
export const enum HucodeOmniWebChildMessageType {
	Ready = 'hucode.omni.hostedWorkbenchReady',
	Focus = 'hucode.omni.hostedWorkbenchFocus',
	UnloadReady = 'hucode.omni.unloadReady',
	CommandResult = 'hucode.omni.commandResult',
	ShellCommand = 'hucode.omni.shellCommand',
}

/**
 * Request sent by the Omni shell to run a command in an iframe workbench.
 */
export interface IHucodeOmniWebRunCommandMessage {
	readonly type: HucodeOmniWebParentMessageType.RunCommand;
	readonly instanceId: string;
	readonly commandId: string;
	readonly args?: readonly unknown[];
}

/**
 * Request sent by the Omni shell before unloading an iframe workbench.
 */
export interface IHucodeOmniWebBeforeUnloadMessage {
	readonly type: HucodeOmniWebParentMessageType.BeforeUnload;
	readonly instanceId: string;
}

/**
 * Message sent by iframe workbenches once unload handling has completed.
 */
export interface IHucodeOmniWebUnloadReadyMessage {
	readonly type: HucodeOmniWebChildMessageType.UnloadReady;
	readonly instanceId: string;
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

/**
 * Result sent after an iframe command request completes.
 */
export interface IHucodeOmniWebCommandResultMessage {
	readonly type: HucodeOmniWebChildMessageType.CommandResult;
	readonly instanceId: string;
	readonly ok: boolean;
}

/**
 * Shell-owned command requested by a hosted iframe workbench.
 */
export interface IHucodeOmniWebShellCommandMessage {
	readonly type: HucodeOmniWebChildMessageType.ShellCommand;
	readonly instanceId: string;
	readonly commandId: string;
	readonly args?: readonly unknown[];
}

export type HucodeOmniWebParentMessage =
	| IHucodeOmniWebRunCommandMessage
	| IHucodeOmniWebBeforeUnloadMessage;

export type HucodeOmniWebChildMessage =
	| IHucodeOmniWebReadyMessage
	| IHucodeOmniWebFocusMessage
	| IHucodeOmniWebUnloadReadyMessage
	| IHucodeOmniWebCommandResultMessage
	| IHucodeOmniWebShellCommandMessage;
