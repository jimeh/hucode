/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
} from './window.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

const HUCODE_OMNI_SHELL_ACTION_PREFIXES = [
	'hucode.projectSwitcher.',
];

export const UNLOAD_CURRENT_WORKTREE_COMMAND_ID =
	'workbench.action.omniWindow.unloadCurrentWorktree';
export const FOCUS_PROJECT_PANE_COMMAND_ID =
	'workbench.action.omniWindow.focusProjectPane';
export const OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID =
	'workbench.action.omniWindow.openSelectedInOmniWindow';
export const OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID =
	'workbench.action.omniWindow.openSelectedInNewWindow';
export const FOCUS_WORKSPACE_COMMAND_ID =
	'workbench.action.omniWindow.focusWorkspace';
export const RELOAD_WORKSPACE_COMMAND_ID =
	'workbench.action.omniWindow.reloadWorkspace';
export const CLOSE_WORKSPACE_COMMAND_ID =
	'workbench.action.omniWindow.closeWorkspace';
export const TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID =
	'workbench.action.omniWindow.toggleProjectsSidebar';

const HUCODE_OMNI_SHELL_ACTION_IDS = new Set([
	FOCUS_PROJECT_PANE_COMMAND_ID,
	OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID,
	OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
	FOCUS_WORKSPACE_COMMAND_ID,
	RELOAD_WORKSPACE_COMMAND_ID,
	CLOSE_WORKSPACE_COMMAND_ID,
	UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
	TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
]);

const HUCODE_OMNI_SHELL_LAYOUT_ACTION_IDS = new Set([
	'workbench.action.togglePanel',
	'workbench.action.closePanel',
	'workbench.action.toggleMaximizedPanel',
	'workbench.action.toggleAuxiliaryBar',
	'workbench.action.closeAuxiliaryBar',
	'workbench.action.toggleMaximizedAuxiliaryBar',
	'workbench.action.toggleSidebarVisibility',
	'workbench.action.closeSidebar',
	'workbench.action.focusSideBar',
	'workbench.action.toggleSidebarPosition',
]);

export const HUCODE_OMNI_PROJECTS_SELECTOR =
	'.hucode-omni-projects-view, .hucode-project-switcher-view';

export const HUCODE_OMNI_LOCAL_INPUT_SELECTOR = [
	'.quick-input-widget',
	'.monaco-inputbox',
	'input',
	'textarea',
	'select',
	'[contenteditable="true"]',
].join(', ');

export const IHucodeOmniCommandForwardingContext =
	createDecorator<IHucodeOmniCommandForwardingContext>(
		'hucodeOmniCommandForwardingContext'
	);

/**
 * Synchronous invocation context shared by the renderer's forwarding surfaces.
 * Each surface owns a distinct scope created by this service.
 */
export interface IHucodeOmniCommandForwardingContext {
	readonly _serviceBrand: undefined;
	readonly isForwardingDisabled: boolean;
	createScope(): IHucodeOmniCommandForwardingScope;
}

export interface IHucodeOmniCommandForwardingScope {
	readonly isForwardingDisabled: boolean;
	runWithForwardingDisabled<T>(
		callback: () => T
	): T;
}

export class HucodeOmniCommandForwardingContext
	implements IHucodeOmniCommandForwardingContext {

	declare readonly _serviceBrand: undefined;

	private readonly activeScopes: symbol[] = [];

	get isForwardingDisabled(): boolean {
		return this.activeScopes.length > 0;
	}

	createScope(): IHucodeOmniCommandForwardingScope {
		const context = this;
		const token = Symbol('hucodeOmniCommandForwardingScope');

		return {
			get isForwardingDisabled(): boolean {
				return context.activeScopes.includes(token);
			},
			runWithForwardingDisabled<T>(callback: () => T): T {
				context.activeScopes.push(token);
				try {
					// Do not await promises returned by the callback. Consumers
					// inspect this context synchronously before their first await.
					return callback();
				} finally {
					context.activeScopes.pop();
				}
			},
		};
	}
}

/**
 * Returns whether a command is owned by the Omni Projects shell.
 */
export function isHucodeOmniShellAction(commandId: string): boolean {
	return isHucodeOmniExplicitShellAction(commandId) ||
		HUCODE_OMNI_SHELL_ACTION_PREFIXES.some(prefix =>
			commandId.startsWith(prefix)
		);
}

/**
 * Returns whether a command is one of the shell's closed, argument-independent
 * controls rather than a member of a broader routed command namespace.
 */
export function isHucodeOmniExplicitShellAction(commandId: string): boolean {
	return HUCODE_OMNI_SHELL_ACTION_IDS.has(commandId);
}

/**
 * Returns whether a command would expose unsupported shell layout UI.
 */
export function isHucodeOmniShellLayoutAction(commandId: string): boolean {
	return HUCODE_OMNI_SHELL_LAYOUT_ACTION_IDS.has(commandId);
}

/**
 * Returns whether this native request already came from the Omni shell.
 */
export function isHucodeForwardedFromOmniShell(
	request:
		| INativeRunActionInWindowRequest
		| INativeRunKeybindingInWindowRequest
): boolean {
	return request.hucodeForwardedFromOmniShell === true;
}
