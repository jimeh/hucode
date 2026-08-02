/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { Event } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { IBaseSerializableStorageRequest, ISerializableItemsChangeEvent } from '../../../platform/storage/common/storageIpc.js';
import { HucodeWebUserDataStorageHost } from '../../node/hucodeWebUserDataStorage.js';

suite('HucodeWebUserDataStorage', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let testHome: string;
	let host: HucodeWebUserDataStorageHost;

	setup(async () => {
		testHome = await fs.mkdtemp(join(tmpdir(), 'hucode-web-user-data-storage-'));
		host = disposables.add(new HucodeWebUserDataStorageHost(testHome, id => id === 'known-profile', new NullLogService()));
	});

	teardown(async () => {
		await host.close();
		host.dispose();
		await fs.rm(testHome, { recursive: true, force: true });
	});

	test('persists application state across hosts', async () => {
		const request = applicationRequest();
		await host.updateItems({ ...request, insert: [['theme', 'dark']] });
		await reopenHost();

		assert.deepStrictEqual(await host.getItems(request), [['theme', 'dark']]);
	});

	test('persists application-shared state across hosts', async () => {
		const request: IBaseSerializableStorageRequest = {
			profile: undefined,
			workspace: undefined,
			applicationShared: true,
		};
		await host.updateItems({ ...request, insert: [['shared', 'enabled']] });
		await reopenHost();

		assert.deepStrictEqual(await host.getItems(request), [['shared', 'enabled']]);
	});

	test('persists known-profile state across hosts', async () => {
		const request: IBaseSerializableStorageRequest = {
			profile: { id: 'known-profile' } as never,
			workspace: undefined,
		};
		await host.updateItems({ ...request, insert: [['profile.theme', 'light']] });
		await reopenHost(id => id === 'known-profile');

		assert.deepStrictEqual(await host.getItems(request), [['profile.theme', 'light']]);
	});

	test('persists workspace state across hosts', async () => {
		const request: IBaseSerializableStorageRequest = {
			profile: undefined,
			workspace: { id: 'workspace-one' },
		};
		await host.updateItems({ ...request, insert: [['layout', 'wide']] });
		await reopenHost();

		assert.deepStrictEqual(await host.getItems(request), [['layout', 'wide']]);
	});

	test('close drains admitted writes and rejects new operations', async () => {
		const request = applicationRequest();
		const admittedWrite = host.updateItems({ ...request, insert: [['theme', 'dark']] });
		const close = host.close();

		await assert.rejects(host.updateItems({ ...request, insert: [['late', 'rejected']] }), /storage is shutting down/);
		await Promise.all([admittedWrite, close]);
		await reopenHost();

		assert.deepStrictEqual(await host.getItems(request), [['theme', 'dark']]);
	});

	test('serializes compare-and-swap writers', async () => {
		const request = applicationRequest();
		const results = await Promise.all([
			host.compareAndSwap({ ...request, key: 'migration', expectedValue: undefined, newValue: 'first' }),
			host.compareAndSwap({ ...request, key: 'migration', expectedValue: undefined, newValue: 'second' }),
		]);

		assert.strictEqual(results.filter(result => result.swapped).length, 1);
		assert.strictEqual(results.filter(result => !result.swapped).length, 1);
		assert.strictEqual(await host.getValue({ ...request, key: 'migration' }), results.find(result => result.swapped)?.currentValue);
	});

	test('emits changes for workspace state', async () => {
		const request: IBaseSerializableStorageRequest = {
			profile: undefined,
			workspace: { id: 'workspace-one' },
		};
		const changed = Event.toPromise(host.getChangeEvent(request));

		await host.updateItems({ ...request, insert: [['layout', 'wide']] });

		assert.deepStrictEqual(await changed, { changed: [['layout', 'wide']] } satisfies ISerializableItemsChangeEvent);
	});

	test('retries entry creation after a transient parent failure', async () => {
		const applicationHome = join(testHome, 'application');
		await fs.writeFile(applicationHome, 'blocks directory creation');
		const request = applicationRequest();

		await assert.rejects(host.getItems(request));
		await fs.rm(applicationHome);
		await host.updateItems({ ...request, insert: [['theme', 'dark']] });

		assert.deepStrictEqual(await host.getItems(request), [['theme', 'dark']]);
	});

	test('rejects SQLite fallback to memory', async () => {
		const databasePath = join(testHome, 'application', 'state.vscdb');
		await fs.mkdir(databasePath, { recursive: true });

		await assert.rejects(
			host.getItems(applicationRequest()),
			/Serve-web user-data database could not be opened/,
		);
	});

	test('recreates entry event ownership after repeated resets', async () => {
		const request = applicationRequest();
		const events: ISerializableItemsChangeEvent[] = [];
		const listener = disposables.add(host.getChangeEvent(request)(event => events.push(event)));

		await host.updateItems({ ...request, insert: [['theme', 'dark']] });
		await host.reset();
		await host.updateItems({ ...request, insert: [['theme', 'light']] });
		await host.reset();
		listener.dispose();

		assert.deepStrictEqual(events, [
			{ changed: [['theme', 'dark']] },
			{ deleted: ['theme'] },
			{ changed: [['theme', 'light']] },
			{ deleted: ['theme'] },
		]);
	});

	test('rejects unknown profiles and invalid workspace identifiers', async () => {
		await assert.rejects(
			host.getItems({ profile: { id: 'unknown' } as never, workspace: undefined }),
			/Unknown web user-data profile/,
		);
		await assert.rejects(
			host.getItems({ profile: undefined, workspace: { id: 'invalid\0workspace' } }),
			/Invalid workspace storage identifier/,
		);
	});

	async function reopenHost(isKnownProfile: (id: string) => boolean = () => false): Promise<void> {
		await host.close();
		host.dispose();
		host = disposables.add(new HucodeWebUserDataStorageHost(testHome, isKnownProfile, new NullLogService()));
	}
});

function applicationRequest(): IBaseSerializableStorageRequest {
	return { profile: undefined, workspace: undefined };
}
