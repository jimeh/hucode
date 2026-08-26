/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	ADD_PROJECT_COMMAND_ID,
	COLLAPSE_ALL_PROJECTS_COMMAND_ID,
	createLegacyHucodeHostedShellActionRequest,
	formatHucodeHostedShellActionCommandIdForLog,
	getHucodeHostedShellAction,
	getHucodeHostedShellActionCommandId,
	GO_BACK_WORKTREE_COMMAND_ID,
	GO_FORWARD_WORKTREE_COMMAND_ID,
	HUCODE_HOSTED_SHELL_ACTIONS,
	HucodeHostedShellAction,
	isHucodeHostedShellAction,
	REFRESH_PROJECTS_COMMAND_ID,
} from '../../common/hucodeHostedShellActions.js';
import { TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID } from '../../common/hucodeOmniCommandRouting.js';

suite('HucodeHostedShellActions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const expectedEntries = [
		[
			HucodeHostedShellAction.ToggleProjectsSidebar,
			TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
		],
		[HucodeHostedShellAction.AddProject, ADD_PROJECT_COMMAND_ID],
		[HucodeHostedShellAction.RefreshProjects, REFRESH_PROJECTS_COMMAND_ID],
		[
			HucodeHostedShellAction.CollapseProjects,
			COLLAPSE_ALL_PROJECTS_COMMAND_ID,
		],
		[HucodeHostedShellAction.NavigateBack, GO_BACK_WORKTREE_COMMAND_ID],
		[
			HucodeHostedShellAction.NavigateForward,
			GO_FORWARD_WORKTREE_COMMAND_ID,
		],
	] as const;

	test('defines exactly the six hosted shell actions', () => {
		assert.deepStrictEqual(HUCODE_HOSTED_SHELL_ACTIONS, [
			HucodeHostedShellAction.ToggleProjectsSidebar,
			HucodeHostedShellAction.AddProject,
			HucodeHostedShellAction.RefreshProjects,
			HucodeHostedShellAction.CollapseProjects,
			HucodeHostedShellAction.NavigateBack,
			HucodeHostedShellAction.NavigateForward,
		]);
		for (const action of HUCODE_HOSTED_SHELL_ACTIONS) {
			assert.strictEqual(isHucodeHostedShellAction(action), true);
		}
		for (const value of ['focusProjects', 'addProject.lookalike', 1, null]) {
			assert.strictEqual(isHucodeHostedShellAction(value), false);
		}
	});

	test('maps every semantic action to and from its command id', () => {
		for (const [action, commandId] of expectedEntries) {
			assert.strictEqual(
				getHucodeHostedShellAction(commandId),
				action
			);
			assert.strictEqual(
				getHucodeHostedShellActionCommandId(action),
				commandId
			);
		}
	});

	test('rejects unknown and namespace-lookalike command ids', () => {
		for (const commandId of [
			'hucode.unregistered',
			'hucode.projectSwitcher.dismissWorkbench',
			`${ADD_PROJECT_COMMAND_ID}.lookalike`,
			'workbench.action.omniWindow.focusProjectPane',
			undefined,
			null,
		]) {
			assert.strictEqual(getHucodeHostedShellAction(commandId), undefined);
		}
	});

	test('formats rejected command ids as bounded single-line labels', () => {
		assert.strictEqual(
			formatHucodeHostedShellActionCommandIdForLog('bad\nid/with space'),
			'bad?id?with?space'
		);
		assert.strictEqual(
			formatHucodeHostedShellActionCommandIdForLog('x'.repeat(81)),
			`${'x'.repeat(80)}...`
		);
		assert.strictEqual(
			formatHucodeHostedShellActionCommandIdForLog(undefined),
			'<non-string>'
		);
	});

	test('creates a server-owned legacy request without caller fields', () => {
		assert.deepStrictEqual(
			createLegacyHucodeHostedShellActionRequest(
				HucodeHostedShellAction.AddProject
			),
			{
				id: ADD_PROJECT_COMMAND_ID,
				from: 'menu',
			}
		);
	});
});
