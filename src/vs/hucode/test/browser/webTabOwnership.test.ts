/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import {
	HucodeWebTabLockAdmission,
	HucodeWebTabOwnershipCoordinator,
	HucodeWebTabOwnershipMessage,
	IHucodeWebTabLockProvider,
	IHucodeWebTabOwnershipChannel,
	IHucodeWebTabOwnershipClock,
} from '../../browser/webTabOwnership.js';

suite('HucodeWebTabOwnershipCoordinator', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('admits one simultaneous owner and activates it from the losing tab',
		async () => {
			const environment = new FakeOwnershipEnvironment();
			const first = disposables.add(environment.create('profile', 'tab-1'));
			const second = disposables.add(environment.create('profile', 'tab-2'));
			const firstRequest = first.admit('/srv/project');
			const secondRequest = second.admit('/srv/project');
			const winnerAdmission = await firstRequest;
			assert.strictEqual(winnerAdmission.kind, 'acquired');
			if (winnerAdmission.kind !== 'acquired') {
				return;
			}
			let activations = 0;
			assert.strictEqual(first.publish(
				winnerAdmission.claim,
				'instance-1',
				async () => {
					activations++;
					return true;
				}
			), true);

			const result = await secondRequest;
			assert.deepStrictEqual({
				kind: result.kind,
				owner: result.kind === 'owned-elsewhere'
					? result.owner?.instanceId
					: undefined,
				focusAccepted: result.kind === 'owned-elsewhere'
					? result.focusAccepted
					: undefined,
				activations,
			}, {
				kind: 'owned-elsewhere',
				owner: 'instance-1',
				focusAccepted: true,
				activations: 1,
			});
		});

	test('joins simultaneous admissions from the same tab reservation',
		async () => {
			const environment = new FakeOwnershipEnvironment();
			const coordinator = disposables.add(
				environment.create('profile', 'tab')
			);
			const first = coordinator.admit('/srv/project');
			const second = coordinator.admit('/srv/project');
			await environment.waitForMessages();
			environment.runAllTimers();

			assert.deepStrictEqual([
				(await first).kind,
				(await second).kind,
			], ['acquired', 'reserved-here']);
		});

	test('reports denied focus without granting duplicate ownership', async () => {
		const environment = new FakeOwnershipEnvironment();
		const owner = disposables.add(environment.create('profile', 'owner'));
		const requester = disposables.add(environment.create('profile', 'requester'));
		const admission = await owner.admit('/srv/project');
		assert.strictEqual(admission.kind, 'acquired');
		if (admission.kind !== 'acquired') {
			return;
		}
		owner.publish(admission.claim, 'instance', async () => false);

		const result = await requester.admit('/srv/project');
		assert.strictEqual(result.kind, 'owned-elsewhere');
		assert.strictEqual(
			result.kind === 'owned-elsewhere' && result.focusAccepted,
			false
		);
	});

	test('does not create a duplicate when the owner cannot confirm activation',
		async () => {
			const environment = new FakeOwnershipEnvironment();
			const owner = disposables.add(environment.create('profile', 'owner'));
			const requester = disposables.add(environment.create('profile', 'requester'));
			const admission = await owner.admit('/srv/project');
			assert.strictEqual(admission.kind, 'acquired');

			const resultPromise = requester.admit('/srv/project');
			await environment.waitForMessages();
			environment.runAllTimers();
			const result = await resultPromise;
			assert.deepStrictEqual(result, {
				kind: 'owned-elsewhere',
				owner: undefined,
				focusAccepted: undefined,
			});
		});

	test('releases on close and ignores a stale generation release', async () => {
		const environment = new FakeOwnershipEnvironment();
		const first = disposables.add(environment.create('profile', 'first'));
		const second = disposables.add(environment.create('profile', 'second'));
		const firstAdmission = await first.admit('/srv/project');
		assert.strictEqual(firstAdmission.kind, 'acquired');
		if (firstAdmission.kind !== 'acquired') {
			return;
		}
		assert.strictEqual(first.release({
			...firstAdmission.claim,
			generation: 'stale',
		}), false);
		const blocked = second.admit('/srv/project');
		await environment.waitForMessages();
		environment.runAllTimers();
		assert.strictEqual((await blocked).kind, 'owned-elsewhere');
		assert.strictEqual(first.release(firstAdmission.claim), true);
		assert.strictEqual((await second.admit('/srv/project')).kind, 'acquired');
	});

	test('automatically releases locks when an owner tab crashes', async () => {
		const environment = new FakeOwnershipEnvironment();
		const owner = environment.create('profile', 'owner');
		const replacement = disposables.add(environment.create('profile', 'replacement'));
		assert.strictEqual((await owner.admit('/srv/project')).kind, 'acquired');

		owner.dispose();

		assert.strictEqual((await replacement.admit('/srv/project')).kind,
			'acquired');
	});

	test('rejects a late activation reply from a replaced generation', async () => {
		const environment = new FakeOwnershipEnvironment();
		const owner = disposables.add(environment.create('profile', 'owner'));
		const requester = disposables.add(environment.create('profile', 'requester'));
		const admission = await owner.admit('/srv/project');
		assert.strictEqual(admission.kind, 'acquired');
		if (admission.kind !== 'acquired') {
			return;
		}
		let finishActivation!: (value: boolean) => void;
		owner.publish(admission.claim, 'old-instance', () =>
			new Promise(resolve => finishActivation = resolve));
		const request = requester.admit('/srv/project');
		await environment.waitForMessages();
		owner.release(admission.claim);
		const replacement = await owner.admit('/srv/project');
		assert.strictEqual(replacement.kind, 'acquired');
		finishActivation(true);
		environment.runAllTimers();

		const result = await request;
		assert.strictEqual(result.kind, 'owned-elsewhere');
		assert.strictEqual(result.kind === 'owned-elsewhere' && result.owner,
			undefined);
	});

	test('allows unrelated paths and separate browser profiles independently',
		async () => {
			const environment = new FakeOwnershipEnvironment();
			const first = disposables.add(environment.create('profile-1', 'first'));
			const second = disposables.add(environment.create('profile-1', 'second'));
			const isolated = disposables.add(environment.create('profile-2', 'isolated'));

			assert.deepStrictEqual([
				(await first.admit('/srv/one')).kind,
				(await second.admit('/srv/two')).kind,
				(await isolated.admit('/srv/one')).kind,
			], ['acquired', 'acquired', 'acquired']);
		});
});

class FakeOwnershipEnvironment {
	private readonly locks = new Map<string, string>();
	private readonly channels = new Map<string, Set<FakeChannel>>();
	private readonly timers = new Set<() => void>();

	create(scope: string, tabId: string): HucodeWebTabOwnershipCoordinator {
		return new HucodeWebTabOwnershipCoordinator(
			scope,
			tabId,
			new FakeLockProvider(scope, tabId, this.locks),
			new FakeChannel(scope, this.channels),
			this.clock,
			10
		);
	}

	readonly clock: IHucodeWebTabOwnershipClock = {
		setTimeout: callback => {
			this.timers.add(callback);
			return callback;
		},
		clearTimeout: handle => {
			this.timers.delete(handle as () => void);
		},
	};

	runAllTimers(): void {
		const timers = [...this.timers];
		this.timers.clear();
		for (const timer of timers) {
			timer();
		}
	}

	async waitForMessages(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
	}
}

class FakeLockProvider implements IHucodeWebTabLockProvider {
	constructor(
		private readonly scope: string,
		private readonly tabId: string,
		private readonly locks: Map<string, string>
	) { }

	async acquire(name: string): Promise<HucodeWebTabLockAdmission> {
		const key = `${this.scope}:${name}`;
		if (this.locks.has(key)) {
			return { kind: 'held' };
		}
		this.locks.set(key, this.tabId);
		return {
			kind: 'acquired',
			handle: toDisposable(() => {
				if (this.locks.get(key) === this.tabId) {
					this.locks.delete(key);
				}
			}),
		};
	}
}

class FakeChannel extends DisposableStore implements IHucodeWebTabOwnershipChannel {
	private readonly emitter = this.add(new Emitter<HucodeWebTabOwnershipMessage>());
	readonly onDidReceiveMessage = this.emitter.event;

	constructor(
		private readonly scope: string,
		private readonly channels: Map<string, Set<FakeChannel>>
	) {
		super();
		let peers = channels.get(scope);
		if (!peers) {
			peers = new Set();
			channels.set(scope, peers);
		}
		peers.add(this);
		this.add(toDisposable(() => peers?.delete(this)));
	}

	postMessage(message: HucodeWebTabOwnershipMessage): void {
		for (const peer of this.channels.get(this.scope) ?? []) {
			if (peer !== this) {
				queueMicrotask(() => peer.emitter.fire(message));
			}
		}
	}
}
