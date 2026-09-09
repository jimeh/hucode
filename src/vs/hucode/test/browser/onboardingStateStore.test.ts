/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { ONBOARDING_STATE_STORAGE_KEY, OnboardingRecord, OnboardingStateStore } from '../../browser/onboarding/onboardingStateStore.js';

suite('OnboardingStateStore', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(raw?: string) {
		const storage = disposables.add(new InMemoryStorageService());
		if (raw !== undefined) {
			storage.store(ONBOARDING_STATE_STORAGE_KEY, raw, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		return { storage, store: new OnboardingStateStore(storage) };
	}

	test('reads a missing record as not started', () => {
		assert.deepStrictEqual(setup().store.read(), { kind: 'record', origin: 'missing', record: { version: 2, status: 'notStarted' } });
	});

	test('reads a malformed record as not started rather than failing to open', () => {
		for (const raw of ['{', '[]', '"skipped"', '{"status":"skipped"}', '{"version":0,"status":"skipped"}', '{"version":1,"status":"finished"}', '{"version":1,"status":"inProgress","stage":"done"}', '{"version":1,"status":"completed","completedAt":"yesterday"}']) {
			assert.deepStrictEqual(setup(raw).store.read(), { kind: 'record', origin: 'malformed', record: { version: 2, status: 'notStarted' } }, raw);
		}
	});

	test('round-trips a version 2 record under application scope and machine target', () => {
		const { storage, store } = setup();
		const record: OnboardingRecord = { version: 2, status: 'inProgress', stage: 'bring', route: 'skipImport', completedAt: 1700000000000 };

		store.write(record);

		assert.deepStrictEqual(store.read(), { kind: 'record', record });
		assert.strictEqual(storage.get(ONBOARDING_STATE_STORAGE_KEY, StorageScope.PROFILE), undefined, 'the record is installation-scoped, not profile-scoped');
		assert.ok(storage.keys(StorageScope.APPLICATION, StorageTarget.MACHINE).includes(ONBOARDING_STATE_STORAGE_KEY), 'the record must never sync');
		assert.ok(!storage.keys(StorageScope.APPLICATION, StorageTarget.USER).includes(ONBOARDING_STATE_STORAGE_KEY));
	});

	test('reports a newer schema as superseded and leaves it untouched', () => {
		const raw = '{"version":3,"status":"completed","stage":"finale","secret":true}';
		const { storage, store } = setup(raw);

		assert.deepStrictEqual(store.read(), { kind: 'superseded', version: 3 });
		assert.strictEqual(storage.get(ONBOARDING_STATE_STORAGE_KEY, StorageScope.APPLICATION), raw, 'reading must not rewrite a record a newer build owns');
	});
});
