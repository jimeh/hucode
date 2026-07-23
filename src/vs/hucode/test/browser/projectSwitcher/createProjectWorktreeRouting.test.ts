/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import type { INativeRunActionInWindowRequest } from
	'../../../../platform/window/common/window.js';
import type { IHucodeShellService } from
	'../../../common/omniWindow.js';
import { CREATE_WORKTREE_COMMAND_ID } from
	'../../../browser/projectSwitcher/projectSwitcherCommon.js';
import { tryForwardShellCreateWorktreeCommand } from
	'../../../browser/projectSwitcher/createProjectWorktreeRouting.js';

suite('CreateProjectWorktreeRouting', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps web Omni Create Worktree in the shell', async () => {
		const calls: IForwardedAction[] = [];
		const handle = { $treeItemHandle: 'project:pinned:project' };
		assert.strictEqual(await tryForwardShellCreateWorktreeCommand(
			{ isOmniWindow: true, isWebClient: true },
			shell(calls),
			7,
			handle
		), false);

		assert.deepStrictEqual(calls, []);
	});

	test('forwards native Omni Create Worktree to the workbench', async () => {
		const calls: IForwardedAction[] = [];
		const handle = { $treeItemHandle: 'project:pinned:project' };
		assert.strictEqual(await tryForwardShellCreateWorktreeCommand(
			{ isOmniWindow: true, isWebClient: false },
			shell(calls),
			7,
			handle
		), true);

		assert.deepStrictEqual(calls, [{
			windowId: 7,
			request: {
				id: CREATE_WORKTREE_COMMAND_ID,
				from: 'mouse',
				args: [handle],
			},
		}]);
	});

	test('returns false when native Omni forwarding misses', async () => {
		const calls: IForwardedAction[] = [];
		assert.strictEqual(await tryForwardShellCreateWorktreeCommand(
			{ isOmniWindow: true, isWebClient: false },
			shell(calls, false),
			7
		), false);
		assert.deepStrictEqual(calls, [{
			windowId: 7,
			request: {
				id: CREATE_WORKTREE_COMMAND_ID,
				from: 'mouse',
				args: undefined,
			},
		}]);
	});

	test('does not forward Create Worktree outside Omni', async () => {
		const calls: IForwardedAction[] = [];
		assert.strictEqual(await tryForwardShellCreateWorktreeCommand(
			{ isOmniWindow: false, isWebClient: false },
			shell(calls),
			7
		), false);
		assert.deepStrictEqual(calls, []);
	});
});

/** Records a forwarded shell action for routing assertions. */
interface IForwardedAction {
	readonly windowId: number;
	readonly request: INativeRunActionInWindowRequest;
}

/** Creates a shell-service stub that records forwarded actions. */
function shell(
	calls: IForwardedAction[],
	result = true
): Pick<IHucodeShellService, 'runActionInWorkspace'> {
	return {
		async runActionInWorkspace(windowId, request) {
			calls.push({ windowId, request });
			return result;
		},
	};
}
