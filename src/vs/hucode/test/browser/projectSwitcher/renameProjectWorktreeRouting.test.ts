/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import type { INativeRunActionInWindowRequest } from
	'../../../../platform/window/common/window.js';
import type { IHucodeShellService } from
	'../../../common/omniWindow.js';
import {
	RENAME_PROJECT_COMMAND_ID,
	RENAME_WORKTREE_COMMAND_ID,
} from '../../../browser/projectSwitcher/projectSwitcherCommon.js';
import { tryForwardShellRenameCommand } from
	'../../../browser/projectSwitcher/renameProjectWorktreeRouting.js';

suite('RenameProjectWorktreeRouting', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const renameCommands = [
		{
			id: RENAME_PROJECT_COMMAND_ID,
			handle: { $treeItemHandle: 'project:pinned:project' },
		},
		{
			id: RENAME_WORKTREE_COMMAND_ID,
			handle: { $treeItemHandle: 'worktree:project:%2Frepo' },
		},
	] as const;

	test('keeps web Omni rename commands in the shell', async () => {
		const calls: IForwardedAction[] = [];
		for (const command of renameCommands) {
			assert.strictEqual(await tryForwardShellRenameCommand(
				true,
				true,
				shell(calls),
				7,
				command.id,
				command.handle
			), false);
		}

		assert.deepStrictEqual(calls, []);
	});

	test('forwards native Omni rename commands to the workbench', async () => {
		const calls: IForwardedAction[] = [];
		for (const command of renameCommands) {
			assert.strictEqual(await tryForwardShellRenameCommand(
				true,
				false,
				shell(calls),
				7,
				command.id,
				command.handle
			), true);
		}

		assert.deepStrictEqual(calls, renameCommands.map(command => ({
			windowId: 7,
			request: {
				id: command.id,
				from: 'mouse',
				args: [command.handle],
			},
		})));
	});

	test('does not forward rename commands outside Omni', async () => {
		const calls: IForwardedAction[] = [];
		assert.strictEqual(await tryForwardShellRenameCommand(
			false,
			false,
			shell(calls),
			7,
			RENAME_PROJECT_COMMAND_ID
		), false);
		assert.deepStrictEqual(calls, []);
	});
});

interface IForwardedAction {
	readonly windowId: number;
	readonly request: INativeRunActionInWindowRequest;
}

function shell(
	calls: IForwardedAction[]
): Pick<IHucodeShellService, 'runActionInWorkspace'> {
	return {
		async runActionInWorkspace(windowId, request) {
			calls.push({ windowId, request });
			return true;
		},
	};
}
