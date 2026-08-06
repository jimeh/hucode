/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqual } from '../../../base/common/extpath.js';
import { basename } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { RawContextKey } from
	'../../../platform/contextkey/common/contextkey.js';
import { WorktreeRecord } from
	'../../../platform/projectManager/common/projectManager.js';

export {
	ADD_PROJECT_COMMAND_ID,
	COLLAPSE_ALL_PROJECTS_COMMAND_ID,
	GO_BACK_WORKTREE_COMMAND_ID,
	GO_FORWARD_WORKTREE_COMMAND_ID,
	REFRESH_PROJECTS_COMMAND_ID,
} from '../../../platform/window/common/hucodeHostedShellActions.js';

export const SWITCH_WORKTREE_COMMAND_ID =
	'hucode.projectSwitcher.switchWorktree';
export const ProjectSwitcherCanGoBackContext = new RawContextKey<boolean>(
	'hucode.projectSwitcher.canGoBack',
	false,
	localize(
		'projectSwitcherCanGoBack',
		'Whether the Hucode project switcher can navigate back'
	)
);
export const ProjectSwitcherCanGoForwardContext = new RawContextKey<boolean>(
	'hucode.projectSwitcher.canGoForward',
	false,
	localize(
		'projectSwitcherCanGoForward',
		'Whether the Hucode project switcher can navigate forward'
	)
);
export const SWITCH_PREVIOUS_WORKTREE_COMMAND_ID =
	'hucode.projectSwitcher.switchPreviousWorktree';
export const SWITCH_NEXT_WORKTREE_COMMAND_ID =
	'hucode.projectSwitcher.switchNextWorktree';
export const SWITCH_PREVIOUS_LOADED_WORKTREE_COMMAND_ID =
	'hucode.projectSwitcher.switchPreviousLoadedWorktree';
export const SWITCH_NEXT_LOADED_WORKTREE_COMMAND_ID =
	'hucode.projectSwitcher.switchNextLoadedWorktree';
export const SWITCH_LAST_ACTIVE_WORKTREE_COMMAND_ID =
	'hucode.projectSwitcher.switchLastActiveWorktree';
export const QUICK_SWITCH_LOADED_WORKTREE_COMMAND_ID =
	'hucode.projectSwitcher.quickSwitchLoadedWorktree';
export const QUICK_SWITCH_LOADED_WORKTREE_NAVIGATE_NEXT_COMMAND_ID =
	'hucode.projectSwitcher.quickSwitchLoadedWorktreeNavigateNext';
export const QUICK_SWITCH_LOADED_WORKTREE_NAVIGATE_PREVIOUS_COMMAND_ID =
	'hucode.projectSwitcher.quickSwitchLoadedWorktreeNavigatePrevious';
export const QUICK_SWITCH_LOADED_WORKTREE_CONTEXT_KEY =
	'inQuickSwitchLoadedProjectWorktree';
export const CREATE_WORKTREE_COMMAND_ID =
	'hucode.projectSwitcher.createWorktree';
export const RENAME_PROJECT_COMMAND_ID =
	'hucode.projectSwitcher.renameProject';
export const RENAME_WORKTREE_COMMAND_ID =
	'hucode.projectSwitcher.renameWorktree';

export function pathsEqual(pathA: string, pathB: string): boolean {
	return isEqual(pathA, pathB, !isLinux);
}

export function getWorktreeDisplayLabel(worktree: WorktreeRecord): string {
	return worktree.customLabel ??
		(worktree.isMain
			? localize('localWorktree', 'local')
			: basename(worktree.path));
}
