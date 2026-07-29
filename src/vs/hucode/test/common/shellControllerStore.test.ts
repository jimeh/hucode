/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { ShellControllerStore } from '../../common/shellControllerStore.js';

suite('ShellControllerStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates controllers lazily and caches their identity', () => {
		const created: number[] = [];
		const store = new ShellControllerStore(windowId => {
			created.push(windowId);
			return new TestController(windowId);
		});

		assert.strictEqual(store.get(7), undefined);
		assert.deepStrictEqual(created, []);

		const first = store.getOrCreate(7);
		const second = store.getOrCreate(7);

		assert.strictEqual(first, second);
		assert.strictEqual(store.get(7), first);
		assert.deepStrictEqual(created, [7]);

		store.dispose();
	});

	test('owns independent controllers for independent window IDs', () => {
		const store = new ShellControllerStore(
			windowId => new TestController(windowId)
		);

		const first = store.getOrCreate(1);
		const second = store.getOrCreate(2);

		assert.notStrictEqual(first, second);
		assert.strictEqual(first.windowId, 1);
		assert.strictEqual(second.windowId, 2);

		store.dispose();
	});

	test('deleting a controller disposes it and allows ID reuse', () => {
		const created: TestController[] = [];
		const store = new ShellControllerStore(windowId => {
			const controller = new TestController(windowId);
			created.push(controller);
			return controller;
		});
		const first = store.getOrCreate(5);

		store.deleteAndDispose(5);

		assert.strictEqual(first.disposeCount, 1);
		assert.strictEqual(store.get(5), undefined);

		const replacement = store.getOrCreate(5);

		assert.notStrictEqual(replacement, first);
		assert.deepStrictEqual(created, [first, replacement]);

		store.dispose();
		assert.strictEqual(first.disposeCount, 1);
		assert.strictEqual(replacement.disposeCount, 1);
	});

	test('does not cache a controller when its factory throws', () => {
		let attempts = 0;
		const store = new ShellControllerStore(windowId => {
			attempts++;
			if (attempts === 1) {
				throw new Error('factory failed');
			}
			return new TestController(windowId);
		});

		assert.throws(() => store.getOrCreate(9), /factory failed/);
		assert.strictEqual(store.get(9), undefined);

		const controller = store.getOrCreate(9);

		assert.strictEqual(controller.windowId, 9);
		assert.strictEqual(attempts, 2);

		store.dispose();
	});

	test('disposing the store disposes every owned controller', () => {
		const store = new ShellControllerStore(
			windowId => new TestController(windowId)
		);
		const first = store.getOrCreate(1);
		const second = store.getOrCreate(2);

		store.dispose();
		store.dispose();

		assert.strictEqual(first.disposeCount, 1);
		assert.strictEqual(second.disposeCount, 1);
		assert.strictEqual(store.get(1), undefined);
		assert.strictEqual(store.get(2), undefined);
	});
});

class TestController implements IDisposable {
	disposeCount = 0;

	constructor(readonly windowId: number) { }

	dispose(): void {
		this.disposeCount++;
	}
}
