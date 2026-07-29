/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { InMemoryStorageService } from
	'../../../platform/storage/common/storage.js';
import { ILifecycleService } from
	'../../../workbench/services/lifecycle/common/lifecycle.js';
import { BrowserLifecycleService } from
	'../../../workbench/services/lifecycle/browser/lifecycleService.js';
import { HucodeHostedOmniWebUnloadCoordinator } from
	'../../browser/hostedOmniWebUnload.js';

suite('HucodeHostedOmniWebUnloadCoordinator', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	interface IShutdownCounts {
		beforeShutdown: number;
		willShutdown: number;
		didShutdown: number;
	}

	function createLifecycleService(): {
		readonly lifecycleService: BrowserLifecycleService;
		readonly counts: IShutdownCounts;
		readonly storageService: InMemoryStorageService;
	} {
		const storageService = disposables.add(new InMemoryStorageService());
		const lifecycleService = disposables.add(new BrowserLifecycleService(
			new NullLogService(),
			storageService
		));
		const counts: IShutdownCounts = {
			beforeShutdown: 0,
			willShutdown: 0,
			didShutdown: 0,
		};
		disposables.add(lifecycleService.onBeforeShutdown(() => {
			counts.beforeShutdown++;
		}));
		disposables.add(lifecycleService.onWillShutdown(() => {
			counts.willShutdown++;
		}));
		disposables.add(lifecycleService.onDidShutdown(() => {
			counts.didShutdown++;
		}));
		return { lifecycleService, counts, storageService };
	}

	function createCoordinator(
		lifecycleService: ILifecycleService
	): HucodeHostedOmniWebUnloadCoordinator {
		return new HucodeHostedOmniWebUnloadCoordinator(
			lifecycleService,
			new NullLogService()
		);
	}

	test('reports a veto without shutting the workbench down', async () => {
		const { lifecycleService, counts } = createLifecycleService();
		disposables.add(lifecycleService.onBeforeShutdown(event => {
			event.veto(true, 'test.unsavedWorkingCopy');
		}));
		const coordinator = createCoordinator(lifecycleService);

		const prepared = await coordinator.prepareUnload();

		assert.deepStrictEqual({
			prepared,
			willShutdown: lifecycleService.willShutdown,
			counts,
		}, {
			prepared: false,
			willShutdown: false,
			counts: { beforeShutdown: 1, willShutdown: 0, didShutdown: 0 },
		});
	});

	test('asks the workbench again on the attempt after a veto', async () => {
		const { lifecycleService, counts } = createLifecycleService();
		let veto = true;
		disposables.add(lifecycleService.onBeforeShutdown(event => {
			event.veto(veto, 'test.unsavedWorkingCopy');
		}));
		const coordinator = createCoordinator(lifecycleService);

		const firstAttempt = await coordinator.prepareUnload();
		veto = false;
		const secondAttempt = await coordinator.prepareUnload();

		assert.deepStrictEqual({
			firstAttempt,
			secondAttempt,
			beforeShutdown: counts.beforeShutdown,
			willShutdown: counts.willShutdown,
		}, {
			firstAttempt: false,
			secondAttempt: true,
			beforeShutdown: 2,
			willShutdown: 0,
		});
	});

	test('refuses a commit that no preparation asked for', async () => {
		const { lifecycleService, counts } = createLifecycleService();
		const coordinator = createCoordinator(lifecycleService);

		const committed = await coordinator.commitUnload();

		assert.deepStrictEqual({ committed, counts }, {
			committed: false,
			counts: { beforeShutdown: 0, willShutdown: 0, didShutdown: 0 },
		});
	});

	test('refuses a commit after its preparation was vetoed', async () => {
		const { lifecycleService, counts } = createLifecycleService();
		disposables.add(lifecycleService.onBeforeShutdown(event => {
			event.veto(true, 'test.unsavedWorkingCopy');
		}));
		const coordinator = createCoordinator(lifecycleService);

		await coordinator.prepareUnload();
		const committed = await coordinator.commitUnload();

		assert.deepStrictEqual({
			committed,
			willShutdown: counts.willShutdown,
			didShutdown: counts.didShutdown,
		}, {
			committed: false,
			willShutdown: 0,
			didShutdown: 0,
		});
	});

	test('shuts down once and stays shut down', async () => {
		const { lifecycleService, counts } = createLifecycleService();
		const coordinator = createCoordinator(lifecycleService);

		const prepared = await coordinator.prepareUnload();
		const committed = await coordinator.commitUnload();
		const recommitted = await coordinator.commitUnload();

		assert.deepStrictEqual({
			prepared,
			committed,
			recommitted,
			counts,
		}, {
			prepared: true,
			committed: true,
			recommitted: true,
			counts: { beforeShutdown: 1, willShutdown: 1, didShutdown: 1 },
		});
	});

	test('propagates commit failure so the shell can fail open', async () => {
		const { lifecycleService, counts, storageService } =
			createLifecycleService();
		const coordinator = createCoordinator(lifecycleService);
		const commitError = new Error('storage flush failed');

		assert.strictEqual(await coordinator.prepareUnload(), true);
		storageService.flush = async () => {
			throw commitError;
		};

		await assert.rejects(coordinator.commitUnload(), commitError);
		assert.deepStrictEqual(counts, {
			beforeShutdown: 1,
			willShutdown: 0,
			didShutdown: 0,
		});
	});

	test('does not re-ask a workbench it has already shut down', async () => {
		const { lifecycleService, counts } = createLifecycleService();
		const coordinator = createCoordinator(lifecycleService);

		await coordinator.prepareUnload();
		await coordinator.commitUnload();
		// The shell retries an unload whose commit it never saw confirmed.
		const prepared = await coordinator.prepareUnload();
		const committed = await coordinator.commitUnload();

		assert.deepStrictEqual({ prepared, committed, counts }, {
			prepared: true,
			committed: true,
			counts: { beforeShutdown: 1, willShutdown: 1, didShutdown: 1 },
		});
	});

	test('runs shutdown listeners even when preparation is abandoned',
		async () => {
			const { lifecycleService, counts } = createLifecycleService();
			let listenerRan = false;
			disposables.add(lifecycleService.onBeforeShutdown(event => {
				listenerRan = true;
				event.veto(true, 'test.unsavedWorkingCopy');
			}));
			const coordinator = createCoordinator(lifecycleService);

			const prepared = await coordinator.prepareUnload();

			// "Still usable" is the claim, not "untouched": listeners that
			// latch state have already latched it by the time a veto comes
			// back.
			assert.deepStrictEqual({
				prepared,
				listenerRan,
				willShutdown: lifecycleService.willShutdown,
				willShutdownFired: counts.willShutdown,
			}, {
				prepared: false,
				listenerRan: true,
				willShutdown: false,
				willShutdownFired: 0,
			});
		});

	test('refuses to unload without two-phase lifecycle support', async () => {
		let shutdowns = 0;
		const lifecycleService = {
			async shutdown() {
				shutdowns++;
			},
		} as unknown as ILifecycleService;
		const coordinator = createCoordinator(lifecycleService);

		assert.deepStrictEqual({
			prepared: await coordinator.prepareUnload(),
			committed: await coordinator.commitUnload(),
			shutdowns,
		}, {
			prepared: false,
			committed: false,
			shutdowns: 0,
		});
	});

	test('reports a failed preparation as a refusal', async () => {
		const lifecycleService = {
			async prepareShutdown(): Promise<boolean> {
				throw new Error('preparation failed');
			},
			async commitShutdown(): Promise<void> { },
		} as unknown as ILifecycleService;
		const coordinator = createCoordinator(lifecycleService);

		assert.deepStrictEqual({
			prepared: await coordinator.prepareUnload(),
			committed: await coordinator.commitUnload(),
		}, {
			prepared: false,
			committed: false,
		});
	});
});
