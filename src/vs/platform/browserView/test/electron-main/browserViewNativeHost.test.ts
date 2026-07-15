/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { NullLogService } from '../../../log/common/log.js';
import type { ICodeWindow } from '../../../window/electron-main/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BrowserViewNativeHost } from '../../electron-main/browserViewNativeHost.js';

class TestView {
	readonly children: TestView[] = [];
	bounds: Electron.Rectangle;
	private visible = false;

	constructor(bounds: Electron.Rectangle = {
		x: 0,
		y: 0,
		width: 0,
		height: 0,
	}) {
		this.bounds = bounds;
	}

	addChildView(view: TestView): void {
		const index = this.children.indexOf(view);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
		this.children.push(view);
	}

	removeChildView(view: TestView): void {
		const index = this.children.indexOf(view);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	getBounds(): Electron.Rectangle {
		return this.bounds;
	}

	setBounds(bounds: Electron.Rectangle): void {
		this.bounds = bounds;
	}

	getVisible(): boolean {
		return this.visible;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}

	asView(): Electron.View {
		return this as unknown as Electron.View;
	}
}

class TestWebContentsView extends TestView {
	readonly webContents: Pick<Electron.WebContents, 'id' | 'isFocused'>;

	constructor(
		readonly id: number,
		bounds?: Electron.Rectangle
	) {
		super(bounds);
		this.webContents = {
			id,
			isFocused: () => false,
		};
	}

	asWebContentsView(): Electron.WebContentsView {
		return this as unknown as Electron.WebContentsView;
	}
}

class TestBrowserWindow {
	readonly contentView = new TestView();
	readonly webContents = {
		focus: () => { },
	};
	private focused = true;
	private destroyed = false;

	isFocused(): boolean {
		return this.focused;
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	asCodeWindow(id = 1): ICodeWindow {
		return {
			id,
			win: this,
		} as unknown as ICodeWindow;
	}
}

suite('BrowserViewNativeHost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('relayouts hosted browser views when the host is later attached', () => {
		const browserWindow = new TestBrowserWindow();
		const ownerWindow = browserWindow.asCodeWindow();
		const browserView = new TestWebContentsView(100);
		const nativeHost = new BrowserViewNativeHost(
			browserView.asWebContentsView(),
			ownerWindow,
			new NullLogService()
		);

		nativeHost.layout({
			windowId: ownerWindow.id,
			hostedWebContentsId: 42,
			x: 320,
			y: 70,
			width: 640,
			height: 480,
			zoomFactor: 1,
			cornerRadius: 0,
		}, true, () => ownerWindow);

		assert.deepStrictEqual(browserView.bounds, {
			x: 320,
			y: 70,
			width: 640,
			height: 480,
		});

		const hostedWorkbenchView = new TestWebContentsView(42, {
			x: 280,
			y: 0,
			width: 1000,
			height: 800,
		});
		browserWindow.contentView.addChildView(
			hostedWorkbenchView.asWebContentsView() as unknown as TestView
		);

		nativeHost.bringToFrontForHostedWebContents(
			42,
			() => ownerWindow
		);

		assert.deepStrictEqual(browserView.bounds, {
			x: 600,
			y: 70,
			width: 640,
			height: 480,
		});
	});

	test('keeps hosted browser visibility gated by host visibility', () => {
		const browserWindow = new TestBrowserWindow();
		const ownerWindow = browserWindow.asCodeWindow();
		const browserView = new TestWebContentsView(100);
		const hostedWorkbenchView = new TestWebContentsView(42, {
			x: 280,
			y: 0,
			width: 1000,
			height: 800,
		});
		browserWindow.contentView.addChildView(
			hostedWorkbenchView.asWebContentsView() as unknown as TestView
		);
		const nativeHost = new BrowserViewNativeHost(
			browserView.asWebContentsView(),
			ownerWindow,
			new NullLogService()
		);

		nativeHost.layout({
			windowId: ownerWindow.id,
			hostedWebContentsId: 42,
			x: 320,
			y: 70,
			width: 640,
			height: 480,
			zoomFactor: 1,
			cornerRadius: 0,
		}, false, () => ownerWindow);

		assert.strictEqual(browserView.getVisible(), false);

		nativeHost.setHostedWebContentsVisible(42, true, () => ownerWindow);

		assert.strictEqual(browserView.getVisible(), true);
		assert.deepStrictEqual(browserView.bounds, {
			x: 600,
			y: 70,
			width: 640,
			height: 480,
		});
	});

	test('defers the first show until a layout has positioned the view', () => {
		const browserWindow = new TestBrowserWindow();
		const ownerWindow = browserWindow.asCodeWindow();
		const browserView = new TestWebContentsView(100);
		const nativeHost = new BrowserViewNativeHost(
			browserView.asWebContentsView(),
			ownerWindow,
			new NullLogService()
		);

		nativeHost.setVisible(true);

		assert.strictEqual(browserView.getVisible(), false);

		nativeHost.layout({
			windowId: ownerWindow.id,
			x: 320,
			y: 70,
			width: 640,
			height: 480,
			zoomFactor: 1,
			cornerRadius: 0,
		}, true, () => ownerWindow);

		assert.strictEqual(browserView.getVisible(), true);
	});
});
