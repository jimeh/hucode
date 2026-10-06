/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeRunActionInWindowRequest } from './window.js';
import { TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID } from
	'./hucodeOmniCommandRouting.js';

export const GO_BACK_WORKTREE_COMMAND_ID = 'hucode.projectSwitcher.goBack';
export const GO_FORWARD_WORKTREE_COMMAND_ID =
	'hucode.projectSwitcher.goForward';
export const ADD_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.addProject';
export const REFRESH_PROJECTS_COMMAND_ID = 'hucode.projectSwitcher.refresh';
export const COLLAPSE_ALL_PROJECTS_COMMAND_ID =
	'hucode.projectSwitcher.collapseAll';

/** Actions a hosted workbench may ask its Omni shell to perform. */
export const HucodeHostedShellAction = {
	ToggleProjectsSidebar: 'toggleProjectsSidebar',
	AddProject: 'addProject',
	RefreshProjects: 'refreshProjects',
	CollapseProjects: 'collapseProjects',
	NavigateBack: 'navigateBack',
	NavigateForward: 'navigateForward',
} as const;

export type HucodeHostedShellAction =
	typeof HucodeHostedShellAction[keyof typeof HucodeHostedShellAction];

/** Complete closed set of shell actions available to hosted workbenches. */
export const HUCODE_HOSTED_SHELL_ACTIONS: readonly HucodeHostedShellAction[] =
	Object.freeze(Object.values(HucodeHostedShellAction));

const HUCODE_HOSTED_SHELL_ACTION_COMMAND_IDS: Record<
	HucodeHostedShellAction,
	string
> = {
	[HucodeHostedShellAction.ToggleProjectsSidebar]:
		TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
	[HucodeHostedShellAction.AddProject]: ADD_PROJECT_COMMAND_ID,
	[HucodeHostedShellAction.RefreshProjects]: REFRESH_PROJECTS_COMMAND_ID,
	[HucodeHostedShellAction.CollapseProjects]:
		COLLAPSE_ALL_PROJECTS_COMMAND_ID,
	[HucodeHostedShellAction.NavigateBack]: GO_BACK_WORKTREE_COMMAND_ID,
	[HucodeHostedShellAction.NavigateForward]: GO_FORWARD_WORKTREE_COMMAND_ID,
};

const HUCODE_HOSTED_SHELL_ACTIONS_BY_COMMAND_ID = new Map(
	Object.entries(HUCODE_HOSTED_SHELL_ACTION_COMMAND_IDS).map(
		([action, commandId]) => [
			commandId,
			action as HucodeHostedShellAction,
		] as const
	)
);

const HUCODE_HOSTED_SHELL_ACTION_LOG_ID_LIMIT = 80;

/** Returns whether a value is a supported semantic hosted shell action. */
export function isHucodeHostedShellAction(
	value: unknown
): value is HucodeHostedShellAction {
	return typeof value === 'string' &&
		(HUCODE_HOSTED_SHELL_ACTIONS as readonly string[]).includes(value);
}

/** Resolves an authorized legacy command ID to its semantic hosted action. */
export function getHucodeHostedShellAction(
	commandId: unknown
): HucodeHostedShellAction | undefined {
	return typeof commandId === 'string'
		? HUCODE_HOSTED_SHELL_ACTIONS_BY_COMMAND_ID.get(commandId)
		: undefined;
}

/** Returns a bounded, single-line command ID label safe for rejection logs. */
export function formatHucodeHostedShellActionCommandIdForLog(
	commandId: unknown
): string {
	if (typeof commandId !== 'string') {
		return '<non-string>';
	}

	const truncated = commandId.slice(0, HUCODE_HOSTED_SHELL_ACTION_LOG_ID_LIMIT);
	const sanitized = truncated.replace(/[^A-Za-z0-9._-]/g, '?');
	if (!sanitized) {
		return '<empty>';
	}
	return commandId.length > HUCODE_HOSTED_SHELL_ACTION_LOG_ID_LIMIT
		? `${sanitized}...`
		: sanitized;
}

/** Resolves a semantic hosted action to its shell-owned command ID. */
export function getHucodeHostedShellActionCommandId(
	action: HucodeHostedShellAction
): string {
	return HUCODE_HOSTED_SHELL_ACTION_COMMAND_IDS[action];
}

/**
 * Creates the bounded legacy wire request used while old web children remain
 * compatible. Its command ID and source are owned by the trusted caller.
 */
export function createLegacyHucodeHostedShellActionRequest(
	action: HucodeHostedShellAction
): INativeRunActionInWindowRequest {
	return {
		id: getHucodeHostedShellActionCommandId(action),
		from: 'menu',
	};
}
