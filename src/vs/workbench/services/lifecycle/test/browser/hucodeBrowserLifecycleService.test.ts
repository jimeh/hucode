/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from
	'../../../../../platform/storage/common/storage.js';
import { BrowserLifecycleService } from '../../browser/lifecycleService.js';

suite('Hucode BrowserLifecycleService two-phase shutdown', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	interface IShutdownCounts {
		beforeShutdown: number;
		willShutdown: number;
		didShutdown: number;
	}

	function createService(): {
		readonly service: BrowserLifecycleService;
		readonly counts: IShutdownCounts;
	} {
		const storageService = disposables.add(new InMemoryStorageService());
		const service = disposables.add(new BrowserLifecycleService(
			new NullLogService(),
			storageService
		));
		const counts: IShutdownCounts = {
			beforeShutdown: 0,
			willShutdown: 0,
			didShutdown: 0,
		};
		disposables.add(service.onBeforeShutdown(() => {
			counts.beforeShutdown++;
		}));
		disposables.add(service.onWillShutdown(() => { counts.willShutdown++; }));
		disposables.add(service.onDidShutdown(() => { counts.didShutdown++; }));
		return { service, counts };
	}

	test('shutdown() still ignores vetoes and unloads once', async () => {
		const { service, counts } = createService();
		disposables.add(service.onBeforeShutdown(event => {
			event.veto(true, 'test.veto');
		}));

		await service.shutdown();

		assert.deepStrictEqual({
			counts,
			willShutdown: service.willShutdown,
		}, {
			counts: { beforeShutdown: 1, willShutdown: 1, didShutdown: 1 },
			willShutdown: true,
		});
	});

	test('shutdown() unloads only once when called again', async () => {
		const { service, counts } = createService();

		await service.shutdown();
		await service.shutdown();

		assert.deepStrictEqual(counts, {
			beforeShutdown: 2,
			willShutdown: 1,
			didShutdown: 1,
		});
	});

	test('prepareShutdown() reports a veto and unloads nothing', async () => {
		const { service, counts } = createService();
		disposables.add(service.onBeforeShutdown(event => {
			event.veto(true, 'test.veto');
		}));

		const veto = await service.prepareShutdown();

		assert.deepStrictEqual({
			veto,
			counts,
			willShutdown: service.willShutdown,
		}, {
			veto: true,
			counts: { beforeShutdown: 1, willShutdown: 0, didShutdown: 0 },
			willShutdown: false,
		});
	});

	test('prepareShutdown() treats a promised veto answer as a veto',
		async () => {
			const { service } = createService();
			disposables.add(service.onBeforeShutdown(event => {
				event.veto(Promise.resolve(false), 'test.asyncVeto');
			}));

			assert.strictEqual(await service.prepareShutdown(), true);
		});

	test('prepareShutdown() reports no veto when nothing vetoes', async () => {
		const { service, counts } = createService();

		const veto = await service.prepareShutdown();

		assert.deepStrictEqual({ veto, counts }, {
			veto: false,
			counts: { beforeShutdown: 1, willShutdown: 0, didShutdown: 0 },
		});
	});

	test('commitShutdown() unloads without asking for a veto again',
		async () => {
			const { service, counts } = createService();

			await service.prepareShutdown();
			await service.commitShutdown();

			assert.deepStrictEqual({
				counts,
				willShutdown: service.willShutdown,
			}, {
				counts: { beforeShutdown: 1, willShutdown: 1, didShutdown: 1 },
				willShutdown: true,
			});
		});

	test('commitShutdown() unloads only once', async () => {
		const { service, counts } = createService();

		await service.prepareShutdown();
		await service.commitShutdown();
		await service.commitShutdown();

		assert.deepStrictEqual(counts, {
			beforeShutdown: 1,
			willShutdown: 1,
			didShutdown: 1,
		});
	});
});
