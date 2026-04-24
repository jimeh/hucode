/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../base/common/event.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import { IRectangle } from '../../platform/window/common/window.js';
import { ShutdownReason } from '../../workbench/services/lifecycle/common/lifecycle.js';

export const HUCODE_SHELL_CHANNEL_NAME = 'hucodeShell';

/**
 * Lifecycle state of a hosted Omni workbench instance.
 */
export type HucodeHostedWorkbenchLifecycleState =
	| 'loading'
	| 'active'
	| 'loaded'
	| 'dormant'
	| 'unloaded'
	| 'crashed';

/**
 * Current state for one hosted Omni workbench instance.
 */
export interface IHucodeHostedWorkbenchInstance {
	readonly instanceId: string;
	readonly projectId?: string;
	readonly worktreePath: string;
	readonly state: HucodeHostedWorkbenchLifecycleState;
	readonly webContentsId?: number;
	readonly processId?: number;
	readonly visible: boolean;
	readonly focused: boolean;
	readonly lastActiveAt?: number;
}

/**
 * Current hosted-workspace state for an Omni-window shell.
 */
export interface IHucodeHostedWorkspaceState {
	readonly activeInstanceId?: string;
	readonly instances: readonly IHucodeHostedWorkbenchInstance[];
}

/**
 * Fired when an Omni-window's hosted-workspace state changes.
 */
export interface IHucodeShellWindowStateChange {
	readonly windowId: number;
	readonly state: IHucodeHostedWorkspaceState;
}

export const IHucodeShellService =
	createDecorator<IHucodeShellService>('hucodeShellService');

/**
 * Main/renderer contract for the Hucode Omni-window shell.
 */
export interface IHucodeShellService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeWindowState: Event<IHucodeShellWindowStateChange>;

	getWindowState(windowId: number): Promise<IHucodeHostedWorkspaceState>;
	openWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState>;
	closeWorkspace(
		windowId: number,
		instanceId?: string
	): Promise<IHucodeHostedWorkspaceState>;
	focusWorkspace(windowId: number): Promise<void>;
	focusShell(windowId: number): Promise<void>;
	reloadWorkspace(windowId: number): Promise<void>;
	layoutWorkspace(windowId: number, bounds: IRectangle): Promise<void>;
	shutdownWindowWorkspaces(
		windowId: number,
		reason: ShutdownReason
	): Promise<void>;
}
