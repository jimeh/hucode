/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../base/common/types.js';
import { INativeOpenFileRequest } from './window.js';
import { HucodeHostedShellCapability } from
	'./hucodeHostedShellService.js';

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

/** Identifies one hosted workbench document and one of its bootstrap retries. */
export interface IHucodeOmniWebConnectionBootstrap {
	readonly id: string;
	readonly attempt: number;
}

/** Validates the current document-and-attempt connection correlation. */
export function isHucodeOmniWebConnectionBootstrapMetadata(value: {
	readonly connectionBootstrap?: unknown;
	readonly connectionAttempt?: unknown;
}): boolean {
	if (hasKey(value, { connectionAttempt: true })) {
		return false;
	}
	if (!value.connectionBootstrap ||
		typeof value.connectionBootstrap !== 'object') {
		return false;
	}
	const bootstrap = value.connectionBootstrap as {
		readonly id?: unknown;
		readonly attempt?: unknown;
	};
	return typeof bootstrap.id === 'string' && bootstrap.id.length > 0 &&
		Number.isSafeInteger(bootstrap.attempt) &&
		(bootstrap.attempt as number) > 0;
}

/**
 * Message transferring the shell IPC port into a hosted iframe workbench.
 */
export interface IHucodeOmniWebPortMessage {
	readonly type: HucodeOmniWebParentMessageType.Port;
	readonly instanceId: string;
	/** Correlates retryable bootstraps for the current document. */
	readonly connectionBootstrap: IHucodeOmniWebConnectionBootstrap;
	/** Negotiated independently from the hosted unload protocol. */
	readonly hostedShellProtocolVersion: number;
	readonly hostedShellCapabilities: readonly HucodeHostedShellCapability[];
}

/**
 * Version of the hosted-workbench half of the Omni web protocol.
 *
 * 1. `prepareUnload` performs the whole shutdown; there is no commit phase.
 * 2. unload is the two-phase
 *    `prepareUnloadForCommit`/`commitUnload` handshake, while
 *    `prepareUnload` keeps the version 1 behavior for older shells.
 *
 * A workbench announces this when it signals ready, and a shell must assume
 * version 1 when a workbench announces nothing. The pairing is reachable:
 * `reloadWorkspace` reloads a single hosted iframe without touching the shell
 * document, so a long-lived shell whose server was rolled back can find
 * itself driving an older workbench.
 */
export const HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION = 2;

/**
 * Message sent by a hosted iframe when its workbench is ready.
 */
export interface IHucodeOmniWebReadyMessage {
	readonly type: HucodeOmniWebChildMessageType.Ready;
	readonly instanceId: string;

	/** Current document identity and its monotonic bootstrap attempt. */
	readonly connectionBootstrap: IHucodeOmniWebConnectionBootstrap;

	/**
	 * {@link HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION} as the workbench knows
	 * it. Absent from workbenches built before the unload handshake split.
	 */
	readonly protocolVersion?: number;

	/** Hosted shell capability version offered by this workbench. */
	readonly hostedShellProtocolVersion: number;
	/** Hosted shell operation groups offered by this workbench. */
	readonly hostedShellCapabilities: readonly HucodeHostedShellCapability[];
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
	 * Performs the complete version 1 unload. This remains available on newer
	 * workbenches because an older shell can survive a deployment and then
	 * load a newer hosted iframe. A true answer means shutdown reached its
	 * irreversible commit.
	 */
	prepareUnload(): Promise<boolean>;

	/**
	 * Runs the veto-capable half of the version 2 unload handshake. Resolves
	 * false when preparation was vetoed or failed, telling the shell to keep
	 * the hosted workbench alive. The workbench does not shut down either way
	 * — that only happens once {@link commitUnload} follows — though its
	 * shutdown listeners do run.
	 */
	prepareUnloadForCommit(): Promise<boolean>;

	/**
	 * Shuts the hosted workbench down after a successful
	 * {@link prepareUnloadForCommit} and the shell's decision that the
	 * workbench is really going away. This is the irreversible half of the
	 * handshake. Resolves false when no prepared unload was outstanding,
	 * leaving the workbench alive.
	 *
	 * Only workbenches announcing {@link HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION}
	 * 2 or later have this. A shell must read the version a workbench sent
	 * with its ready message before it decides how to unload it.
	 */
	commitUnload(): Promise<boolean>;
}
