/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BrowserViewHostedWebContents } from '../../electron-main/browserViewHostedWebContents.js';
import type { BrowserView } from '../../electron-main/browserView.js';

class TestBrowserView {
	readonly visibleCalls: { id: number; visible: boolean }[] = [];
	readonly frontCalls: number[] = [];

	constructor(readonly hostedWebContentsIds: readonly number[]) { }

	setHostedWebContentsVisible(id: number, visible: boolean): void {
		this.visibleCalls.push({ id, visible });
	}

	bringToFrontForHostedWebContents(id: number): void {
		this.frontCalls.push(id);
	}

	belongsToHostedWebContents(id: number): boolean {
		return this.hostedWebContentsIds.includes(id);
	}

	asBrowserView(): BrowserView {
		return this as unknown as BrowserView;
	}
}

suite('BrowserViewHostedWebContents', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tracks hosted webContents visibility', () => {
		const hosted = new BrowserViewHostedWebContents();

		assert.strictEqual(hosted.isVisible(undefined), true);
		assert.strictEqual(hosted.isVisible(42), true);

		hosted.setVisible(42, false, []);

		assert.strictEqual(hosted.isVisible(42), false);
		assert.strictEqual(hosted.isVisible(7), true);
	});

	test('forwards visibility and front requests to browser views', () => {
		const hosted = new BrowserViewHostedWebContents();
		const first = new TestBrowserView([42]);
		const second = new TestBrowserView([7]);
		const views = [first.asBrowserView(), second.asBrowserView()];

		hosted.setVisible(42, false, views);
		hosted.bringToFront(42, views);

		assert.deepStrictEqual(first.visibleCalls, [
			{ id: 42, visible: false },
		]);
		assert.deepStrictEqual(second.visibleCalls, [
			{ id: 42, visible: false },
		]);
		assert.deepStrictEqual(first.frontCalls, [42]);
		assert.deepStrictEqual(second.frontCalls, [42]);
	});

	test('finds browser views owned by a hosted webContents', () => {
		const hosted = new BrowserViewHostedWebContents();
		const first = new TestBrowserView([42]);
		const second = new TestBrowserView([7]);
		const third = new TestBrowserView([42, 7]);

		assert.deepStrictEqual(hosted.getOwnedViewIds(42, [
			['first', first.asBrowserView()],
			['second', second.asBrowserView()],
			['third', third.asBrowserView()],
		]), ['first', 'third']);
	});
});
