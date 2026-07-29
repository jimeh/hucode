/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	CLOSE_WORKSPACE_COMMAND_ID,
	FOCUS_PROJECT_PANE_COMMAND_ID,
	FOCUS_WORKSPACE_COMMAND_ID,
	HucodeOmniCommandForwardingScope,
	isHucodeForwardedFromOmniShell,
	isHucodeOmniShellAction,
	isHucodeOmniShellLayoutAction,
	OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
	OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID,
	RELOAD_WORKSPACE_COMMAND_ID,
	TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
	UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
} from '../../common/hucodeOmniCommandRouting.js';

suite('HucodeOmniCommandRouting', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('identifies shell-owned actions', () => {
		assert.deepStrictEqual([
			FOCUS_PROJECT_PANE_COMMAND_ID,
			OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID,
			OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
			FOCUS_WORKSPACE_COMMAND_ID,
			RELOAD_WORKSPACE_COMMAND_ID,
			CLOSE_WORKSPACE_COMMAND_ID,
			UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
			TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
			'hucode.projectSwitcher.refresh',
			'workbench.action.files.save',
		].map(commandId => isHucodeOmniShellAction(commandId)), [
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			false,
		]);
	});

	test('identifies shell layout actions', () => {
		assert.strictEqual(
			isHucodeOmniShellLayoutAction('workbench.action.togglePanel'),
			true
		);
		assert.strictEqual(
			isHucodeOmniShellLayoutAction('workbench.action.files.save'),
			false
		);
	});

	test('detects requests already forwarded from the shell', () => {
		assert.strictEqual(
			isHucodeForwardedFromOmniShell({
				id: 'workbench.action.files.save',
				from: 'keybinding',
				hucodeForwardedFromOmniShell: true
			}),
			true
		);
		assert.strictEqual(
			isHucodeForwardedFromOmniShell({
				id: 'workbench.action.files.save',
				from: 'keybinding'
			}),
			false
		);
	});

	test('scopes forwarding suppression to the callback', async () => {
		const scope = new HucodeOmniCommandForwardingScope();
		assert.strictEqual(scope.isForwardingDisabled, false);

		await scope.runWithForwardingDisabled(async () => {
			assert.strictEqual(scope.isForwardingDisabled, true);
			await scope.runWithForwardingDisabled(() => {
				assert.strictEqual(scope.isForwardingDisabled, true);
			});
			assert.strictEqual(scope.isForwardingDisabled, true);
		});

		assert.strictEqual(scope.isForwardingDisabled, false);
	});

	test('isolates forwarding suppression between owners', async () => {
		const firstScope = new HucodeOmniCommandForwardingScope();
		const secondScope = new HucodeOmniCommandForwardingScope();

		await firstScope.runWithForwardingDisabled(() => {
			assert.strictEqual(firstScope.isForwardingDisabled, true);
			assert.strictEqual(secondScope.isForwardingDisabled, false);
		});

		assert.strictEqual(firstScope.isForwardingDisabled, false);
		assert.strictEqual(secondScope.isForwardingDisabled, false);
	});

	test('restores forwarding suppression after callback errors', async () => {
		const scope = new HucodeOmniCommandForwardingScope();
		await assert.rejects(
			scope.runWithForwardingDisabled(() => {
				throw new Error('expected');
			}),
			/expected/
		);
		assert.strictEqual(scope.isForwardingDisabled, false);
	});
});
