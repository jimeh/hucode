/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	hucodeGetRendererReplyTargetKey,
	hucodeGetRendererReplyTargetLabel,
	hucodeIsRendererReplyTargetEqual,
	hucodeResolveRendererReplyTargetWithLookup,
} from '../../common/hucodeRendererReplyTarget.js';

suite('HucodeRendererReplyTarget', () => {

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
