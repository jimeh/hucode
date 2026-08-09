/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import type { INativeRunActionInWindowRequest } from
	'../../../../platform/window/common/window.js';
import type { IHucodeShellControllerService } from
	'../../../../platform/window/common/hucodeShellControllerService.js';
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
				{ isOmniWindow: true, isWebClient: true },
				shell(calls),
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
				{ isOmniWindow: true, isWebClient: false },
				shell(calls),
				command.id,
				command.handle
			), true);
		}

		assert.deepStrictEqual(calls, renameCommands.map(command => ({
			request: {
				id: command.id,
				from: 'mouse',
				args: [command.handle],
			},
		})));
	});

	test('returns false when native Omni forwarding misses', async () => {
		const calls: IForwardedAction[] = [];
		assert.strictEqual(await tryForwardShellRenameCommand(
			{ isOmniWindow: true, isWebClient: false },
			shell(calls, false),
			RENAME_PROJECT_COMMAND_ID
		), false);
		assert.deepStrictEqual(calls, [{
			request: {
				id: RENAME_PROJECT_COMMAND_ID,
				from: 'mouse',
				args: undefined,
			},
		}]);
	});

	test('does not forward rename commands outside Omni', async () => {
		const calls: IForwardedAction[] = [];
		assert.strictEqual(await tryForwardShellRenameCommand(
			{ isOmniWindow: false, isWebClient: false },
			shell(calls),
			RENAME_PROJECT_COMMAND_ID
		), false);
		assert.deepStrictEqual(calls, []);
	});
});

/** Records a forwarded shell action for routing assertions. */
interface IForwardedAction {
	readonly request: INativeRunActionInWindowRequest;
}

/** Creates a shell-service stub that records forwarded actions. */
function shell(
	calls: IForwardedAction[],
	result = true
): Pick<IHucodeShellControllerService, 'runActionInWorkspace'> {
	return {
		async runActionInWorkspace(request) {
			calls.push({ request });
			return result;
		},
	};
}
