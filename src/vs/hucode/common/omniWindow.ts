/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../base/common/event.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import {
	INativeOpenFileRequest,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
	IRectangle,
} from '../../platform/window/common/window.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { UriComponents } from '../../base/common/uri.js';
import { ShutdownReason } from '../../workbench/services/lifecycle/common/lifecycle.js';
import {
	HucodeHostedWorkbenchRestorePolicy,
	IHucodeRetainedWorkbench,
} from './retainedWorkbench.js';
import { ProjectSwitcherOmniSection } from
	'./projectSwitcher/projectSwitcherViewState.js';

export const HUCODE_SHELL_CHANNEL_NAME = 'hucodeShell';

export { UNLOAD_CURRENT_WORKTREE_COMMAND_ID } from
	'../../platform/window/common/hucodeOmniCommandRouting.js';

/**
 * Lifecycle state of a hosted Omni workbench instance.
 */
export type HucodeHostedWorkbenchLifecycleState =
	| 'restore-pending'
	| 'loading'
	| 'active'
	| 'loaded'
	| 'dormant'
	| 'unloaded'
	| 'missing'
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
	readonly projectsSidebarVisible: boolean;
	readonly projectSwitcherCanGoBack: boolean;
	readonly projectSwitcherCanGoForward: boolean;
	readonly projectSwitcherSectionOrder?: readonly ProjectSwitcherOmniSection[];
	readonly instances: readonly IHucodeHostedWorkbenchInstance[];
	readonly retainedWorkbenches?: readonly IHucodeRetainedWorkbench[];
}

/**
 * Fired when an Omni-window's hosted-workspace state changes.
 */
export interface IHucodeShellWindowStateChange {
	readonly windowId: number;
	readonly state: IHucodeHostedWorkspaceState;
}

/**
 * Existing hosted Omni workbench that owns a worktree path.
 */
export interface IHucodeHostedWorkspaceOwner {
	readonly windowId: number;
	readonly instanceId: string;
	readonly projectId?: string;
	readonly worktreePath: string;
}

export const IHucodeShellService =
	createDecorator<IHucodeShellService>('hucodeShellService');

/**
 * Main/renderer contract for the Hucode Omni-window shell.
 */
export interface IHucodeShellService {
	readonly _serviceBrand: undefined;
	/**
	 * Whether the current host can use screenshot fallback rendering for shell
	 * overlays above hosted workbenches.
	 */
	readonly supportsWorkspaceScreenshotOverlay: boolean;

	readonly onDidChangeWindowState: Event<IHucodeShellWindowStateChange>;

	getWindowState(windowId: number): Promise<IHucodeHostedWorkspaceState>;
	findHostedWorkspaceByPath(
		worktreePath: string
	): Promise<IHucodeHostedWorkspaceOwner | undefined>;
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
	/** Retains, loads, and activates an arbitrary folder workbench. */
	retainAndOpenWorkbench(
		windowId: number,
		folderUri: UriComponents,
	): Promise<IHucodeHostedWorkspaceState>;
	/** Unloads an arbitrary workbench while preserving its retained record. */
	unloadRetainedWorkbench(
		windowId: number,
		workbenchId: string,
	): Promise<IHucodeHostedWorkspaceState>;
	/** Safely unloads and removes an arbitrary workbench record. */
	dismissRetainedWorkbench(
		windowId: number,
		workbenchId: string,
	): Promise<IHucodeHostedWorkspaceState>;
	/** Persists the complete manual order of arbitrary workbench records. */
	reorderRetainedWorkbenches(
		windowId: number,
		orderedWorkbenchIds: readonly string[],
	): Promise<IHucodeHostedWorkspaceState>;
	/** Removes arbitrary records that are now authoritative project worktrees. */
	reconcileRetainedWorkbenches(
		windowId: number,
		projectFolders: readonly {
			readonly projectId: string;
			readonly folderUri: UriComponents;
		}[],
	): Promise<IHucodeHostedWorkspaceState>;
	/** Configures which desired-loaded workbenches are eager on startup. */
	setHostedWorkbenchRestorePolicy(
		windowId: number,
		policy: HucodeHostedWorkbenchRestorePolicy,
	): Promise<void>;
	/**
	 * Opens files inside a hosted workspace, creating or activating the
	 * workspace first when necessary.
	 */
	openFilesInWorkspace(
		windowId: number,
		worktreePath: string,
		request: INativeOpenFileRequest,
		projectId?: string
	): Promise<boolean>;
	/**
	 * Opens files inside the currently active hosted workspace.
	 */
	openFilesInActiveWorkspace(
		windowId: number,
		request: INativeOpenFileRequest
	): Promise<boolean>;
	closeWorkspace(
		windowId: number,
		instanceId?: string
	): Promise<IHucodeHostedWorkspaceState>;
	reopenWorkspaceInNormalWindow(
		windowId: number,
		instanceId: string
	): Promise<boolean>;
	/**
	 * Marks a hosted workspace as ready after its workbench reaches Restored.
	 */
	notifyHostedWorkspaceReady(
		windowId: number,
		instanceId: string
	): Promise<void>;
	focusWorkspace(windowId: number): Promise<void>;
	focusShell(windowId: number): Promise<void>;
	/**
	 * Updates the current Omni Projects sidebar visibility for hosted
	 * workbenches.
	 */
	setProjectsSidebarVisible(
		windowId: number,
		visible: boolean
	): Promise<void>;
	/**
	 * Updates shell-owned Projects navigation affordance state for hosted
	 * workbench titlebars.
	 */
	setProjectSwitcherNavigationState(
		windowId: number,
		canGoBack: boolean,
		canGoForward: boolean
	): Promise<void>;
	/** Updates the visual order used by mixed workbench navigation. */
	setProjectSwitcherSectionOrder(
		windowId: number,
		order: readonly ProjectSwitcherOmniSection[]
	): Promise<void>;
	/**
	 * Sends an action invocation to the Omni shell renderer.
	 */
	runActionInShell(
		windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean>;
	/**
	 * Sends a native menu/action invocation from the shell to the active
	 * hosted workspace.
	 */
	runActionInWorkspace(
		windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean>;
	/**
	 * Sends a native menu keybinding invocation from the shell to the active
	 * hosted workspace.
	 */
	runKeybindingInWorkspace(
		windowId: number,
		request: INativeRunKeybindingInWindowRequest
	): Promise<boolean>;
	/**
	 * Triggers native paste in the active hosted workspace `WebContentsView`.
	 */
	triggerPasteInWorkspace(windowId: number): Promise<boolean>;
	reloadWorkspace(windowId: number): Promise<void>;
	toggleWorkspaceDevTools(windowId: number): Promise<boolean>;
	layoutWorkspace(windowId: number, bounds: IRectangle): Promise<void>;
	/**
	 * Captures the active hosted workspace view for DOM fallback rendering.
	 */
	captureWorkspaceScreenshot(
		windowId: number,
		rect?: IRectangle,
		quality?: number
	): Promise<VSBuffer | undefined>;
	/**
	 * Hides or restores the active hosted workspace view while shell overlays
	 * need to render above it.
	 */
	setWorkspaceOverlayOcclusion(
		windowId: number,
		occluded: boolean
	): Promise<void>;
	shutdownWindowWorkspaces(
		windowId: number,
		reason: ShutdownReason
	): Promise<void>;
}
