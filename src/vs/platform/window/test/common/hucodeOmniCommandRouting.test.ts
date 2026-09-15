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
	HucodeOmniCommandForwardingContext,
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

	test('scopes forwarding suppression to the synchronous callback', () => {
		const context = new HucodeOmniCommandForwardingContext();
		const scope = context.createScope();
		assert.strictEqual(scope.isForwardingDisabled, false);

		scope.runWithForwardingDisabled(() => {
			assert.strictEqual(scope.isForwardingDisabled, true);
			scope.runWithForwardingDisabled(() => {
				assert.strictEqual(scope.isForwardingDisabled, true);
			});
			assert.strictEqual(scope.isForwardingDisabled, true);
		});

		assert.strictEqual(scope.isForwardingDisabled, false);
	});

	test('isolates forwarding suppression between owners', () => {
		const context = new HucodeOmniCommandForwardingContext();
		const firstScope = context.createScope();
		const secondScope = context.createScope();

		firstScope.runWithForwardingDisabled(() => {
			assert.strictEqual(firstScope.isForwardingDisabled, true);
			assert.strictEqual(secondScope.isForwardingDisabled, false);
		});

		assert.strictEqual(firstScope.isForwardingDisabled, false);
		assert.strictEqual(secondScope.isForwardingDisabled, false);
	});

	test('restores forwarding suppression after callback errors', () => {
		const scope =
			new HucodeOmniCommandForwardingContext().createScope();
		assert.throws(
			() => scope.runWithForwardingDisabled(() => {
				throw new Error('expected');
			}),
			/expected/
		);
		assert.strictEqual(scope.isForwardingDisabled, false);
	});

	test('retains suppression until returned promises settle', async () => {
		const context = new HucodeOmniCommandForwardingContext();
		const scope = context.createScope();
		let resolvePending!: () => void;
		const pending = new Promise<void>(resolve => {
			resolvePending = resolve;
		});

		const result = scope.runWithForwardingDisabled(() => pending);

		assert.strictEqual(scope.isForwardingDisabled, true);
		assert.strictEqual(context.isForwardingDisabled, true);
		resolvePending();
		await result;
		assert.strictEqual(scope.isForwardingDisabled, false);
		assert.strictEqual(context.isForwardingDisabled, false);
	});

	test('cleans up rejected and out-of-order async suppression scopes',
		async () => {
			const context = new HucodeOmniCommandForwardingContext();
			const scope = context.createScope();
			let resolveFirst!: () => void;
			const firstPending = new Promise<void>(resolve => {
				resolveFirst = resolve;
			});
			let rejectSecond!: (error: Error) => void;
			const secondPending = new Promise<void>((_resolve, reject) => {
				rejectSecond = reject;
			});

			const first = scope.runWithForwardingDisabled(() => firstPending);
			const second = scope.runWithForwardingDisabled(() => secondPending);
			assert.strictEqual(scope.isForwardingDisabled, true);

			resolveFirst();
			await first;
			assert.strictEqual(scope.isForwardingDisabled, true);

			rejectSecond(new Error('expected rejection'));
			await assert.rejects(second, /expected rejection/);
			assert.strictEqual(scope.isForwardingDisabled, false);
			assert.strictEqual(context.isForwardingDisabled, false);
		}
	);

	test('action-specific suppression does not disable unrelated commands',
		async () => {
			const context = new HucodeOmniCommandForwardingContext();
			const scope = context.createScope();
			let resolvePending!: () => void;
			const pending = new Promise<void>(resolve => {
				resolvePending = resolve;
			});

			const result = scope.runWithForwardingDisabledFor(
				'editor.action.clipboardCopyAction',
				() => pending
			);

			assert.strictEqual(
				context.isForwardingDisabledFor(
					'editor.action.clipboardCopyAction'
				),
				true
			);
			assert.strictEqual(
				context.isForwardingDisabledFor('workbench.action.files.save'),
				false
			);
			resolvePending();
			await result;
			assert.strictEqual(context.isForwardingDisabled, false);
		}
	);
});
