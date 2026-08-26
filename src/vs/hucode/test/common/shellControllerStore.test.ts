/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { ShellControllerStore } from '../../common/shellControllerStore.js';

suite('ShellControllerStore', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('creates controllers lazily and caches their identity', () => {
		const created: number[] = [];
		const resolved: number[] = [];
		const destroyed = disposables.add(new Emitter<number>());
		const store = disposables.add(createTestStore(
			windowId => {
				created.push(windowId);
				return new TestController(windowId);
			},
			destroyed,
			windowId => {
				resolved.push(windowId);
				return testHost(windowId);
			}
		));

		assert.strictEqual(store.get(7), undefined);
		assert.deepStrictEqual(created, []);
		assert.deepStrictEqual(resolved, []);

		const first = store.getOrCreate(7);
		const second = store.getOrCreate(7);

		assert.strictEqual(first, second);
		assert.strictEqual(store.get(7), first);
		assert.deepStrictEqual(created, [7]);
		assert.deepStrictEqual(resolved, [7]);
	});

	test('owns independent controllers for independent window IDs', () => {
		const destroyed = disposables.add(new Emitter<number>());
		const store = disposables.add(createTestStore(
			windowId => new TestController(windowId),
			destroyed
		));

		const first = store.getOrCreate(1);
		const second = store.getOrCreate(2);

		assert.notStrictEqual(first, second);
		assert.strictEqual(first.windowId, 1);
		assert.strictEqual(second.windowId, 2);
	});

	test('window destruction disposes its controller and allows ID reuse', () => {
		const created: TestController[] = [];
		const destroyed = disposables.add(new Emitter<number>());
		const store = disposables.add(createTestStore(
			windowId => {
				const controller = new TestController(windowId);
				created.push(controller);
				return controller;
			},
			destroyed
		));
		const first = store.getOrCreate(5);

		destroyed.fire(5);

		assert.strictEqual(first.disposeCount, 1);
		assert.strictEqual(store.get(5), undefined);

		const replacement = store.getOrCreate(5);

		assert.notStrictEqual(replacement, first);
		assert.deepStrictEqual(created, [first, replacement]);

		store.dispose();
		assert.strictEqual(first.disposeCount, 1);
		assert.strictEqual(replacement.disposeCount, 1);
	});

	test('window close and later destruction release a controller exactly once',
		() => {
			const closed = disposables.add(new Emitter<void>());
			const destroyed = disposables.add(new Emitter<number>());
			const store = disposables.add(createTestStore(
				windowId => new TestController(windowId),
				destroyed,
				windowId => testHost(windowId, true, closed.event)
			));
			const controller = store.getOrCreate(5);

			closed.fire();

			assert.strictEqual(controller.disposeCount, 1);
			assert.strictEqual(store.get(5), undefined);

			destroyed.fire(5);
			assert.strictEqual(controller.disposeCount, 1);
		});

	test('destruction of an absent window remains non-creating', () => {
		const created: number[] = [];
		const destroyed = disposables.add(new Emitter<number>());
		const store = disposables.add(createTestStore(
			windowId => {
				created.push(windowId);
				return new TestController(windowId);
			},
			destroyed
		));

		destroyed.fire(404);

		assert.strictEqual(store.get(404), undefined);
		assert.deepStrictEqual(created, []);
	});

	test('rejects a missing window before calling or caching the factory', () => {
		const created: number[] = [];
		const destroyed = disposables.add(new Emitter<number>());
		const store = disposables.add(createTestStore(
			windowId => {
				created.push(windowId);
				return new TestController(windowId);
			},
			destroyed,
			() => undefined
		));

		assert.throws(
			() => store.getOrCreate(10),
			/Window 10 is not a Hucode Omni-window/
		);
		assert.deepStrictEqual(created, []);
		assert.strictEqual(store.get(10), undefined);
	});

	test('rejects a non-Omni window before calling or caching the factory', () => {
		const created: number[] = [];
		const destroyed = disposables.add(new Emitter<number>());
		const store = disposables.add(createTestStore(
			windowId => {
				created.push(windowId);
				return new TestController(windowId);
			},
			destroyed,
			windowId => testHost(windowId, false)
		));

		assert.throws(
			() => store.getOrCreate(11),
			/Window 11 is not a Hucode Omni-window/
		);
		assert.deepStrictEqual(created, []);
		assert.strictEqual(store.get(11), undefined);
	});

	test('does not cache a controller when its factory throws', () => {
		let attempts = 0;
		const destroyed = disposables.add(new Emitter<number>());
		const store = disposables.add(createTestStore(
			windowId => {
				attempts++;
				if (attempts === 1) {
					throw new Error('factory failed');
				}
				return new TestController(windowId);
			},
			destroyed
		));

		assert.throws(() => store.getOrCreate(9), /factory failed/);
		assert.strictEqual(store.get(9), undefined);

		const controller = store.getOrCreate(9);

		assert.strictEqual(controller.windowId, 9);
		assert.strictEqual(attempts, 2);
	});

	test('disposing the store disposes controllers and its event subscription', () => {
		const destroyed = disposables.add(new Emitter<number>());
		const store = disposables.add(createTestStore(
			windowId => new TestController(windowId),
			destroyed
		));
		const first = store.getOrCreate(1);
		const second = store.getOrCreate(2);
		assert.strictEqual(destroyed.hasListeners(), true);

		store.dispose();
		store.dispose();

		assert.strictEqual(first.disposeCount, 1);
		assert.strictEqual(second.disposeCount, 1);
		assert.strictEqual(store.get(1), undefined);
		assert.strictEqual(store.get(2), undefined);
		assert.strictEqual(destroyed.hasListeners(), false);
	});
});

interface TestHost {
	readonly windowId: number;
	readonly isOmniWindow?: boolean;
	readonly onDidClose?: Event<void>;
}

class TestController implements IDisposable {
	disposeCount = 0;

	constructor(readonly windowId: number) { }

	dispose(): void {
		this.disposeCount++;
	}
}

function testHost(
	windowId: number,
	isOmniWindow = true,
	onDidClose: Event<void> = Event.None
): TestHost {
	return { windowId, isOmniWindow, onDidClose };
}

function createTestStore(
	createController: (
		windowId: number,
		host: TestHost
	) => TestController,
	destroyed: Emitter<number>,
	getWindowById: (windowId: number) => TestHost | undefined = testHost
): ShellControllerStore<TestHost, TestController> {
	return new ShellControllerStore(
		getWindowById,
		createController,
		destroyed.event
	);
}
