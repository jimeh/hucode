/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { Event } from '../../../base/common/event.js';
import { IStorageDatabase, IUpdateRequest, Storage } from '../../../base/parts/storage/common/storage.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ONBOARDING_STATE_STORAGE_KEY as KEY } from '../../../platform/storage/common/hucodeOnboardingStorage.js';
import { IS_NEW_KEY, loadKeyTargets, StorageTarget } from '../../../platform/storage/common/storage.js';
import { initializeHucodeOnboardingStorage } from '../../../platform/storage/electron-main/hucodeOnboardingStorage.js';
import { OnboardingMain } from '../../electron-main/onboarding/onboardingMain.js';

class Database implements IStorageDatabase {
	readonly onDidChangeItemsExternal = Event.None;
	readonly items = new Map<string, string>();
	writes = 0;
	fail = false;
	loseWrite = false;
	memory = false;
	connection: Promise<boolean> | undefined;
	async isInMemory(): Promise<boolean> { return this.connection ?? this.memory; }
	async getItems(): Promise<Map<string, string>> { return new Map(this.items); }
	async updateItems(request: IUpdateRequest): Promise<void> {
		this.writes++;
		if (this.fail) { throw new Error('disk failed'); }
		if (this.loseWrite) { return; }
		request.insert?.forEach((value, key) => this.items.set(key, value));
		request.delete?.forEach(key => this.items.delete(key));
	}
	async optimize(): Promise<void> { }
	async close(): Promise<void> { }
}

suite('Hucode onboarding main checkpoints', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const progress = JSON.stringify({ version: 2, status: 'inProgress', stage: 'bring' });
	const completed = JSON.stringify({ version: 2, status: 'completed', completedAt: 42 });

	async function setup(raw?: string) {
		const database = new Database();
		if (raw !== undefined) { database.items.set(KEY, raw); }
		const storage = disposables.add(new Storage(database));
		await storage.init();
		const main = new OnboardingMain({
			storage,
			init: async () => { },
		});
		return { database, storage, main };
	}

	test('seeds new intent before a newness marker and marks it machine-only', async () => {
		const { storage, database } = await setup();
		await initializeHucodeOnboardingStorage(storage, true);
		assert.deepStrictEqual({ record: database.items.get(KEY), marker: database.items.get(IS_NEW_KEY), target: loadKeyTargets(storage)[KEY] }, { record: progress, marker: undefined, target: StorageTarget.MACHINE });
	});

	test('failed seeding leaves no newness marker and a later startup retry can persist intent', async () => {
		const { storage, database } = await setup();
		database.fail = true;
		await assert.rejects(initializeHucodeOnboardingStorage(storage, true), /disk failed/);
		assert.strictEqual(storage.get(IS_NEW_KEY), undefined);
		assert.strictEqual(storage.get(KEY), undefined);
		database.fail = false;
		await initializeHucodeOnboardingStorage(storage, true);
		assert.strictEqual(database.items.get(KEY), progress);
	});

	test('checkpoints preserve registered target metadata without rewriting it', async () => {
		const { storage, database, main } = await setup();
		await initializeHucodeOnboardingStorage(storage, true);
		const writes = database.writes;
		await main.checkpoint(completed);
		assert.strictEqual(database.writes - writes, 1);
		assert.strictEqual(loadKeyTargets(storage)[KEY], StorageTarget.MACHINE);
	});

	test('does not enroll existing application storage or overwrite malformed and future bytes', async () => {
		for (const raw of [undefined, '{broken', '{"version":99}']) {
			const { storage, database } = await setup(raw);
			await storage.set(IS_NEW_KEY, false);
			await initializeHucodeOnboardingStorage(storage, true);
			assert.strictEqual(database.items.get(KEY), raw);
		}
	});

	test('rejects failed checkpoints without publishing cache and retries the same value', async () => {
		const { storage, database } = await setup(progress);
		const changes: string[] = [];
		disposables.add(storage.onDidChangeStorage(e => changes.push(e.key)));
		database.fail = true;
		await assert.rejects(storage.setWithAcknowledgement(KEY, completed), /disk failed/);
		assert.deepStrictEqual({ cached: storage.get(KEY), changes }, { cached: progress, changes: [] });
		database.fail = false;
		await storage.setWithAcknowledgement(KEY, completed);
		assert.deepStrictEqual({ cached: storage.get(KEY), persisted: database.items.get(KEY), writes: database.writes }, { cached: completed, persisted: completed, writes: 2 });
	});

	test('detects a swallowed statement failure through database readback', async () => {
		const { storage, database } = await setup(progress);
		database.loseWrite = true;
		await assert.rejects(storage.setWithAcknowledgement(KEY, completed), /did not persist/);
		assert.strictEqual(storage.get(KEY), progress);
	});

	test('rejects fallback memory and closing during connection readiness', async () => {
		const { storage, database } = await setup();
		database.memory = true;
		await assert.rejects(storage.setWithAcknowledgement(KEY, progress), /Persistent storage/);
		const connection = new DeferredPromise<boolean>();
		database.connection = connection.p;
		const write = storage.setWithAcknowledgement(KEY, progress);
		await storage.close();
		connection.complete(false);
		await assert.rejects(write, /closing/);
		assert.strictEqual(database.items.get(KEY), undefined);
	});

	test('admits one shell, allows its reload, and releases without completion', async () => {
		const { main } = await setup(progress);
		assert.deepStrictEqual(await Promise.all([main.admit(1, () => true), main.admit(2, () => true)]), [true, false]);
		assert.strictEqual(await main.admit(1, () => true), true);
		main.release(1);
		assert.strictEqual(await main.admit(2, () => true), true);
	});

	test('rechecks current state and eligibility inside admission ordering', async () => {
		const { main } = await setup(progress);
		const terminal = main.checkpoint(completed);
		const admitted = main.admit(1, () => true);
		await terminal;
		assert.strictEqual(await admitted, false);
		assert.strictEqual(await main.admit(1, () => false), false);
	});

	test('never auto-opens missing, malformed, future, completed, or skipped records', async () => {
		for (const raw of [undefined, '{', '{"version":99}', completed, '{"version":2,"status":"skipped"}']) {
			const { main } = await setup(raw);
			assert.strictEqual(await main.admit(1, () => true), false, raw);
			assert.strictEqual(await main.read(), raw);
		}
	});

	test('failed completion remains resumable and completed state resists stale dismissal and skip', async () => {
		const { main, database } = await setup(progress);
		database.fail = true;
		await assert.rejects(main.checkpoint(completed));
		database.fail = false;
		assert.strictEqual(await main.admit(1, () => true), true);
		await main.checkpoint(completed);
		await main.checkpoint(progress);
		await main.checkpoint('{"version":2,"status":"skipped"}');
		assert.strictEqual(JSON.parse((await main.read())!).status, 'completed');
		assert.strictEqual(JSON.parse((await main.read())!).completedAt, 42);
	});
});
