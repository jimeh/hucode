/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	hucodeGetRendererReplyTargetKey,
	hucodeGetRendererReplyTargetLabel,
	hucodeIsRendererReplyTargetEqual,
	hucodeResolveRendererReplyTargetWithLookup,
} from '../../common/hucodeRendererReplyTarget.js';
import {
	CLOSE_WORKSPACE_COMMAND_ID,
	FOCUS_PROJECT_PANE_COMMAND_ID,
	FOCUS_WORKSPACE_COMMAND_ID,
	isHucodeForwardedFromOmniShell,
	isHucodeOmniShellAction,
	isHucodeOmniShellCommandForwardingDisabled,
	isHucodeOmniShellLayoutAction,
	OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
	OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID,
	RELOAD_WORKSPACE_COMMAND_ID,
	TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
	UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
	withHucodeOmniShellCommandForwardingDisabled,
} from '../../common/hucodeOmniCommandRouting.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('RendererReplyTarget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('labels window and hosted webContents targets', () => {
		assert.strictEqual(
			hucodeGetRendererReplyTargetLabel({ kind: 'window', windowId: 1 }),
			'window:1'
		);
		assert.strictEqual(
			hucodeGetRendererReplyTargetLabel({
				kind: 'webContents',
				ownerWindowId: 1,
				webContentsId: 2
			}),
			'webContents:2'
		);
	});

	test('keys include owner window for hosted webContents targets', () => {
		assert.strictEqual(
			hucodeGetRendererReplyTargetKey({ kind: 'window', windowId: 1 }),
			'window:1'
		);
		assert.strictEqual(
			hucodeGetRendererReplyTargetKey({
				kind: 'webContents',
				ownerWindowId: 1,
				webContentsId: 2
			}),
			'webContents:1:2'
		);
	});

	test('compares target identity by stable key', () => {
		assert.ok(hucodeIsRendererReplyTargetEqual(
			{ kind: 'window', windowId: 1 },
			{ kind: 'window', windowId: 1 }
		));
		assert.ok(hucodeIsRendererReplyTargetEqual(
			{ kind: 'webContents', ownerWindowId: 1, webContentsId: 2 },
			{ kind: 'webContents', ownerWindowId: 1, webContentsId: 2 }
		));
		assert.ok(!hucodeIsRendererReplyTargetEqual(
			{ kind: 'webContents', ownerWindowId: 1, webContentsId: 2 },
			{ kind: 'webContents', ownerWindowId: 3, webContentsId: 2 }
		));
	});

	test('resolves window targets to the owner window webContents', () => {
		const ownerWindow = {
			id: 1,
			win: {
				id: 'window',
				destroyed: false,
				webContents: { id: 10, destroyed: false }
			}
		};
		const resolved = hucodeResolveRendererReplyTargetWithLookup({
			kind: 'window',
			windowId: 1,
		}, {
			getWindowById: id => id === ownerWindow.id ? ownerWindow : undefined,
			getWindow: window => window.win,
			getWindowWebContents: window => window.webContents,
			getWebContentsById: () => undefined,
			isWindowDestroyed: window => window.destroyed,
			isWebContentsDestroyed: contents => contents.destroyed,
		});

		assert.strictEqual(resolved?.ownerWindow, ownerWindow);
		assert.strictEqual(resolved?.targetWindow, ownerWindow.win);
		assert.strictEqual(resolved?.targetContents, ownerWindow.win.webContents);
	});

	test('resolves hosted targets to their hosted webContents', () => {
		const ownerWindow = {
			id: 1,
			win: {
				id: 'window',
				destroyed: false,
				webContents: { id: 10, destroyed: false }
			}
		};
		const hostedContents = { id: 20, destroyed: false };
		const resolved = hucodeResolveRendererReplyTargetWithLookup({
			kind: 'webContents',
			ownerWindowId: 1,
			webContentsId: hostedContents.id,
		}, {
			getWindowById: id => id === ownerWindow.id ? ownerWindow : undefined,
			getWindow: window => window.win,
			getWindowWebContents: window => window.webContents,
			getWebContentsById: id => id === hostedContents.id ? hostedContents : undefined,
			isWindowDestroyed: window => window.destroyed,
			isWebContentsDestroyed: contents => contents.destroyed,
		});

		assert.strictEqual(resolved?.ownerWindow, ownerWindow);
		assert.strictEqual(resolved?.targetWindow, ownerWindow.win);
		assert.strictEqual(resolved?.targetContents, hostedContents);
	});

	test('refuses destroyed hosted webContents', () => {
		const ownerWindow = {
			id: 1,
			win: {
				id: 'window',
				destroyed: false,
				webContents: { id: 10, destroyed: false }
			}
		};
		const hostedContents = { id: 20, destroyed: true };
		const resolved = hucodeResolveRendererReplyTargetWithLookup({
			kind: 'webContents',
			ownerWindowId: 1,
			webContentsId: hostedContents.id,
		}, {
			getWindowById: id => id === ownerWindow.id ? ownerWindow : undefined,
			getWindow: window => window.win,
			getWindowWebContents: window => window.webContents,
			getWebContentsById: id => id === hostedContents.id ? hostedContents : undefined,
			isWindowDestroyed: window => window.destroyed,
			isWebContentsDestroyed: contents => contents.destroyed,
		});

		assert.strictEqual(resolved, undefined);
	});
});

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
		].map(commandId => isHucodeOmniShellAction(commandId)), [
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
		]);
		assert.strictEqual(
			isHucodeOmniShellAction('hucode.projectSwitcher.refresh'),
			true
		);
		assert.strictEqual(
			isHucodeOmniShellAction('workbench.action.files.save'),
			false
		);
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
		assert.strictEqual(
			isHucodeOmniShellCommandForwardingDisabled(),
			false
		);

		await withHucodeOmniShellCommandForwardingDisabled(async () => {
			assert.strictEqual(
				isHucodeOmniShellCommandForwardingDisabled(),
				true
			);
			await withHucodeOmniShellCommandForwardingDisabled(() => {
				assert.strictEqual(
					isHucodeOmniShellCommandForwardingDisabled(),
					true
				);
			});
			assert.strictEqual(
				isHucodeOmniShellCommandForwardingDisabled(),
				true
			);
		});

		assert.strictEqual(
			isHucodeOmniShellCommandForwardingDisabled(),
			false
		);
	});

	test('restores forwarding suppression after callback errors', async () => {
		await assert.rejects(
			withHucodeOmniShellCommandForwardingDisabled(() => {
				throw new Error('expected');
			}),
			/expected/
		);
		assert.strictEqual(
			isHucodeOmniShellCommandForwardingDisabled(),
			false
		);
	});
});
