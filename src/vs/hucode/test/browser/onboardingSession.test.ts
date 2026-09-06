/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { OnboardingSession, bindOnboardingDismissal } from '../../browser/onboarding/onboardingSession.js';
import { ONBOARDING_STATE_STORAGE_KEY, OnboardingStateStore } from '../../browser/onboarding/onboardingStateStore.js';

suite('OnboardingSession', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(raw?: string) {
		const storage = disposables.add(new InMemoryStorageService());
		if (raw !== undefined) {
			storage.store(ONBOARDING_STATE_STORAGE_KEY, raw, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		const session = disposables.add(new OnboardingSession(new OnboardingStateStore(storage)));
		const finished: number[] = [];
		disposables.add(session.onDidFinish(() => finished.push(1)));
		session.initialize();
		const stored = () => storage.get(ONBOARDING_STATE_STORAGE_KEY, StorageScope.APPLICATION);
		return { session, stored, finished };
	}

	test('opens in first mode for a fresh or resumable record and rerun mode for an ended one', () => {
		assert.deepStrictEqual({
			missing: setup().session.state.mode,
			notStarted: setup('{"version":1,"status":"notStarted"}').session.state.mode,
			inProgress: setup('{"version":1,"status":"inProgress","stage":"bring"}').session.state.mode,
			skipped: setup('{"version":1,"status":"skipped"}').session.state.mode,
			completed: setup('{"version":1,"status":"completed","completedAt":1}').session.state.mode,
			superseded: setup('{"version":2,"status":"notStarted"}').session.state.mode,
		}, {
			missing: 'first',
			notStarted: 'first',
			inProgress: 'first',
			skipped: 'rerun',
			completed: 'rerun',
			superseded: 'rerun',
		});
	});

	test('resumes the recorded stage and lands on the first stage for anything else', () => {
		assert.deepStrictEqual({
			resumed: setup('{"version":1,"status":"inProgress","stage":"bring"}').session.state.stage,
			// A stage the record type names but this build cannot present yet.
			unpresentable: setup('{"version":1,"status":"inProgress","stage":"meetOmni"}').session.state.stage,
			noStage: setup('{"version":1,"status":"inProgress"}').session.state.stage,
			fresh: setup().session.state.stage,
		}, {
			resumed: 'bring',
			unpresentable: 'bring',
			noStage: 'bring',
			fresh: 'bring',
		});
	});

	test('skip records the choice and finishes once', () => {
		const { session, stored, finished } = setup();

		session.skip();
		session.skip();

		assert.deepStrictEqual({ record: JSON.parse(stored()!), finished }, { record: { version: 1, status: 'skipped' }, finished: [1] });
	});

	test('skip from a completed record finishes without downgrading it', () => {
		const completed = '{"version":1,"status":"completed","completedAt":1}';
		const { session, stored, finished } = setup(completed);

		session.skip();

		assert.deepStrictEqual({ raw: stored(), finished }, { raw: completed, finished: [1] }, 'a completed installation keeps its record and its completedAt');
	});

	test('dismissal records the current stage as resumable', () => {
		const { session, stored } = setup();

		session.recordDismissal();

		assert.deepStrictEqual(JSON.parse(stored()!), { version: 1, status: 'inProgress', stage: 'bring' });
	});

	test('dismissal after skip changes nothing', () => {
		const { session, stored } = setup();
		session.skip();

		session.recordDismissal();

		assert.deepStrictEqual(JSON.parse(stored()!), { version: 1, status: 'skipped' });
	});

	test('dismissal in rerun mode leaves an ended record alone', () => {
		const completed = '{"version":1,"status":"completed","completedAt":1}';
		const { session, stored } = setup(completed);

		session.recordDismissal();

		assert.strictEqual(stored(), completed, 'looking at a completed onboarding again must not downgrade it');
	});

	test('never rewrites a record a newer build owns', () => {
		const newer = '{"version":2,"status":"completed"}';
		const { session, stored, finished } = setup(newer);

		session.recordDismissal();
		session.skip();

		assert.deepStrictEqual({ raw: stored(), finished }, { raw: newer, finished: [1] });
	});

	test('binds dismissal to the input closing, not to renderer traffic', () => {
		const { session, stored } = setup();
		const closing = disposables.add(new Emitter<void>());
		disposables.add(bindOnboardingDismissal(session, closing.event));

		assert.strictEqual(stored(), undefined);
		closing.fire();
		assert.deepStrictEqual(JSON.parse(stored()!), { version: 1, status: 'inProgress', stage: 'bring' });
	});
});
