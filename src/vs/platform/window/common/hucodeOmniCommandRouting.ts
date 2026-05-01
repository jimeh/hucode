/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
} from './window.js';

const HUCODE_OMNI_SHELL_ACTION_PREFIXES = [
	'hucode.projectSwitcher.',
];

const HUCODE_OMNI_SHELL_ACTION_IDS = new Set([
	'workbench.action.omniWindow.focusProjectsFromExplorerShortcut',
	'workbench.action.omniWindow.focusProjectsFromSourceControlShortcut',
	'workbench.action.omniWindow.focusProjectPane',
	'workbench.action.omniWindow.openSelectedInOmniWindow',
	'workbench.action.omniWindow.openSelectedInNewWindow',
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

const HUCODE_OMNI_SHELL_KEYBINDINGS = new Set([
	'shift+cmd+e',
	'cmd+shift+e',
	'ctrl+shift+e',
	'ctrl+shift+g',
	'shift+cmd+g',
	'cmd+shift+g',
]);

const HUCODE_OMNI_SHELL_LAYOUT_KEYBINDINGS = new Set([
	'cmd+b',
	'ctrl+b',
	'cmd+j',
	'ctrl+j',
	'alt+cmd+b',
	'cmd+alt+b',
	'ctrl+alt+b',
]);

let hucodeOmniShellCommandForwardingDisabled = 0;

/**
 * Returns whether a command is owned by the Omni Projects shell.
 */
export function isHucodeOmniShellAction(commandId: string): boolean {
	return HUCODE_OMNI_SHELL_ACTION_IDS.has(commandId) ||
		HUCODE_OMNI_SHELL_ACTION_PREFIXES.some(prefix =>
			commandId.startsWith(prefix)
		);
}

/**
 * Returns whether a command would expose unsupported shell layout UI.
 */
export function isHucodeOmniShellLayoutAction(commandId: string): boolean {
	return HUCODE_OMNI_SHELL_LAYOUT_ACTION_IDS.has(commandId);
}

/**
 * Returns whether a keybinding is reserved for the Omni Projects shell.
 */
export function isHucodeOmniShellKeybinding(
	userSettingsLabel: string
): boolean {
	return HUCODE_OMNI_SHELL_KEYBINDINGS.has(
		normalizeHucodeOmniKeybindingLabel(userSettingsLabel)
	);
}

/**
 * Returns whether a keybinding would expose unsupported shell layout UI.
 */
export function isHucodeOmniShellLayoutKeybinding(
	userSettingsLabel: string
): boolean {
	return HUCODE_OMNI_SHELL_LAYOUT_KEYBINDINGS.has(
		normalizeHucodeOmniKeybindingLabel(userSettingsLabel)
	);
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

/**
 * Runs work without the Omni shell command forwarder re-forwarding commands.
 */
export async function withHucodeOmniShellCommandForwardingDisabled<T>(
	callback: () => T | Promise<T>
): Promise<T> {
	hucodeOmniShellCommandForwardingDisabled++;
	try {
		return await callback();
	} finally {
		hucodeOmniShellCommandForwardingDisabled--;
	}
}

/**
 * Returns whether Omni shell command forwarding is temporarily disabled.
 */
export function isHucodeOmniShellCommandForwardingDisabled(): boolean {
	return hucodeOmniShellCommandForwardingDisabled > 0;
}

function normalizeHucodeOmniKeybindingLabel(userSettingsLabel: string): string {
	return userSettingsLabel.toLowerCase().replace(/\s+/g, '');
}
