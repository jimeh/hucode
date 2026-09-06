/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { EditorMigrationFlowPhase, EditorMigrationFlowSession, EditorMigrationFlowState } from '../../browser/migration/editorMigrationFlow.js';
import { OnboardingSession, OnboardingSessionState, bindOnboardingDismissal } from '../../browser/onboarding/onboardingSession.js';
import { ONBOARDING_STATE_STORAGE_KEY, OnboardingStateStore } from '../../browser/onboarding/onboardingStateStore.js';

suite('OnboardingSession', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(raw?: string, options: { readonly acknowledged?: boolean } = {}) {
		const storage = disposables.add(new InMemoryStorageService());
		if (raw !== undefined) {
			storage.store(ONBOARDING_STATE_STORAGE_KEY, raw, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		const migrations: MigrationStub[] = [];
		const session = disposables.add(new OnboardingSession(
			new OnboardingStateStore(storage),
			() => {
				const migration = new MigrationStub(options.acknowledged ?? true);
				migrations.push(migration);
				return migration as unknown as EditorMigrationFlowSession;
			},
			() => 1_700_000_000_000,
		));
		const finished: number[] = [];
		const changes: OnboardingSessionState[] = [];
		disposables.add(session.onDidFinish(() => finished.push(1)));
		disposables.add(session.onDidChangeState(state => changes.push(state)));
		session.initialize();
		const stored = () => storage.get(ONBOARDING_STATE_STORAGE_KEY, StorageScope.APPLICATION);
		const position = () => ({ stage: session.state.stage, route: session.state.route });
		return { session, stored, finished, changes, migrations, position };
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

	test('resumes appearance and Meet Omni with their route, and lands on bring for anything else', () => {
		assert.deepStrictEqual({
			bring: setup('{"version":1,"status":"inProgress","stage":"bring"}').position(),
			appearance: setup('{"version":1,"status":"inProgress","stage":"appearance","route":"skipImport"}').position(),
			meetOmniSkip: setup('{"version":1,"status":"inProgress","stage":"meetOmni","route":"skipImport"}').position(),
			meetOmniMigrate: setup('{"version":1,"status":"inProgress","stage":"meetOmni","route":"migrate"}').position(),
			// A live migration session cannot be restored; the journal keeps any admitted operation
			// and the migration flow's own recovery phase surfaces it once Import is chosen again.
			migrate: setup('{"version":1,"status":"inProgress","stage":"migrate","route":"migrate"}').position(),
			meetOmniNoRoute: setup('{"version":1,"status":"inProgress","stage":"meetOmni"}').position(),
			noStage: setup('{"version":1,"status":"inProgress"}').position(),
			completedAtMeetOmni: setup('{"version":1,"status":"completed","stage":"meetOmni","route":"migrate"}').position(),
			fresh: setup().position(),
		}, {
			bring: { stage: 'bring', route: undefined },
			appearance: { stage: 'appearance', route: 'skipImport' },
			meetOmniSkip: { stage: 'meetOmni', route: 'skipImport' },
			meetOmniMigrate: { stage: 'meetOmni', route: 'migrate' },
			migrate: { stage: 'bring', route: undefined },
			meetOmniNoRoute: { stage: 'bring', route: undefined },
			noStage: { stage: 'bring', route: undefined },
			completedAtMeetOmni: { stage: 'bring', route: undefined },
			fresh: { stage: 'bring', route: undefined },
		});
	});

	test('carries the earlier outcome into rerun mode for the bring summary', () => {
		assert.deepStrictEqual({
			completed: setup('{"version":1,"status":"completed","route":"migrate","completedAt":5}').session.state.previous,
			skipped: setup('{"version":1,"status":"skipped"}').session.state.previous,
			superseded: setup('{"version":2,"status":"completed","route":"migrate","completedAt":5}').session.state.previous,
			first: setup().session.state.previous,
		}, {
			completed: { status: 'completed', route: 'migrate', completedAt: 5 },
			skipped: { status: 'skipped', route: undefined, completedAt: undefined },
			superseded: { status: 'superseded' },
			first: undefined,
		});
	});

	test('Skip Import opens the appearance stage without creating a migration session', () => {
		const { session, migrations, position } = setup();

		session.chooseRoute('skipImport');
		assert.deepStrictEqual(position(), { stage: 'appearance', route: 'skipImport' });
		session.continueStage();
		assert.deepStrictEqual(position(), { stage: 'meetOmni', route: 'skipImport' });
		assert.deepStrictEqual(migrations, []);

		// Back retraces the route one stage at a time, and bring has nowhere to go.
		assert.strictEqual(session.back(), true);
		assert.deepStrictEqual(position(), { stage: 'appearance', route: 'skipImport' });
		assert.strictEqual(session.back(), true);
		assert.deepStrictEqual(position(), { stage: 'bring', route: undefined });
		assert.strictEqual(session.back(), false);
		assert.deepStrictEqual(position(), { stage: 'bring', route: undefined });
	});

	test('Import creates one migration session, starts it, and re-announces its state changes', () => {
		const { session, migrations, changes, position } = setup();

		session.chooseRoute('migrate');
		assert.deepStrictEqual(position(), { stage: 'migrate', route: 'migrate' });
		assert.strictEqual(migrations.length, 1);
		assert.deepStrictEqual(migrations[0].calls, [['initialize']]);
		assert.strictEqual(session.migration, migrations[0] as unknown as EditorMigrationFlowSession);

		const before = changes.length;
		migrations[0].publish({ phase: 'application' });
		assert.strictEqual(changes.length, before + 1, 'a migration change is announced as an onboarding change');
		assert.deepStrictEqual(position(), { stage: 'migrate', route: 'migrate' });

		// Choosing again from inside the flow must not start a second discovery.
		session.chooseRoute('migrate');
		session.chooseRoute('skipImport');
		assert.strictEqual(migrations.length, 1);
	});

	test('Back leaves the migration for bring only before a source is chosen, disposing the session', () => {
		const { session, migrations, position } = setup();
		session.chooseRoute('migrate');
		const first = migrations[0];

		const gated: Partial<Record<EditorMigrationFlowPhase, boolean>> = {};
		for (const phase of ['profile', 'target', 'review', 'publishers', 'apply', 'results'] as const) {
			first.publish({ phase });
			gated[phase] = session.back();
		}
		assert.deepStrictEqual(gated, { profile: false, target: false, review: false, publishers: false, apply: false, results: false });
		assert.deepStrictEqual(position(), { stage: 'migrate', route: 'migrate' });
		assert.strictEqual(first.disposed, false);

		for (const phase of ['loading', 'recovery', 'application'] as const) {
			first.publish({ phase });
			assert.strictEqual(session.back(), true, `${phase} offers Back to bring`);
			assert.deepStrictEqual(position(), { stage: 'bring', route: undefined });
			assert.strictEqual(session.migration, undefined);
			assert.strictEqual(first.disposed, true);
			// Re-enter for the next phase; each Import is a fresh session.
			session.chooseRoute('migrate');
			assert.strictEqual(session.migration, migrations.at(-1) as unknown as EditorMigrationFlowSession);
			assert.notStrictEqual(session.migration, first);
		}
	});

	test('acknowledging results deletes recovery data without a restart and moves to Meet Omni', async () => {
		const { session, migrations, position } = setup();
		session.chooseRoute('migrate');
		const migration = migrations[0];
		migration.publish({ phase: 'results', operation: { id: 'operation' } as EditorMigrationFlowState['operation'] });

		await session.acknowledgeMigration();

		assert.deepStrictEqual(migration.calls, [['initialize'], ['acknowledge', false]]);
		assert.deepStrictEqual(position(), { stage: 'meetOmni', route: 'migrate' });
		assert.strictEqual(migration.disposed, true);
		assert.strictEqual(session.back(), false, 'the operation is gone, so there is nothing to go back to');
		assert.deepStrictEqual(position(), { stage: 'meetOmni', route: 'migrate' });
	});

	test('a refused acknowledgement stays on the migration results', async () => {
		const { session, migrations, position } = setup(undefined, { acknowledged: false });
		session.chooseRoute('migrate');
		migrations[0].publish({ phase: 'results', operation: { id: 'operation' } as EditorMigrationFlowState['operation'] });

		await session.acknowledgeMigration();

		assert.deepStrictEqual(position(), { stage: 'migrate', route: 'migrate' });
		assert.strictEqual(migrations[0].disposed, false);
	});

	test('Finish for Now records completion with the route and the injected clock, once', () => {
		const skipImport = setup();
		skipImport.session.chooseRoute('skipImport');
		skipImport.session.continueStage();
		skipImport.session.finishForNow();
		skipImport.session.finishForNow();
		assert.deepStrictEqual({ record: JSON.parse(skipImport.stored()!), finished: skipImport.finished }, {
			record: { version: 1, status: 'completed', route: 'skipImport', completedAt: 1_700_000_000_000 },
			finished: [1],
		});

		// Outside Meet Omni it is not offered, so it must not end the flow.
		const early = setup();
		early.session.chooseRoute('skipImport');
		early.session.finishForNow();
		assert.deepStrictEqual({ stored: early.stored(), finished: early.finished }, { stored: undefined, finished: [] });
	});

	test('Finish for Now never rewrites a record a newer build owns, but still finishes', () => {
		const newer = '{"version":2,"status":"completed"}';
		const { session, stored, finished } = setup(newer);
		session.chooseRoute('skipImport');
		session.continueStage();

		session.finishForNow();

		assert.deepStrictEqual({ raw: stored(), finished }, { raw: newer, finished: [1] });
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

	test('dismissal records the current stage and route as resumable', () => {
		const fresh = setup();
		fresh.session.recordDismissal();
		assert.deepStrictEqual(JSON.parse(fresh.stored()!), { version: 1, status: 'inProgress', stage: 'bring' });

		const appearance = setup();
		appearance.session.chooseRoute('skipImport');
		appearance.session.recordDismissal();
		assert.deepStrictEqual(JSON.parse(appearance.stored()!), { version: 1, status: 'inProgress', stage: 'appearance', route: 'skipImport' });

		const migrate = setup();
		migrate.session.chooseRoute('migrate');
		migrate.session.recordDismissal();
		assert.deepStrictEqual(JSON.parse(migrate.stored()!), { version: 1, status: 'inProgress', stage: 'migrate', route: 'migrate' });
	});

	test('dismissal during an admitted Apply asks the migration to cancel, and only then', () => {
		const phases: Partial<Record<EditorMigrationFlowPhase, number>> = {};
		for (const phase of ['loading', 'recovery', 'application', 'profile', 'target', 'review', 'publishers', 'apply', 'results'] as const) {
			const { session, migrations } = setup();
			session.chooseRoute('migrate');
			migrations[0].publish({ phase });
			session.recordDismissal();
			phases[phase] = migrations[0].calls.filter(call => call[0] === 'requestCancellation').length;
		}
		assert.deepStrictEqual(phases, { loading: 0, recovery: 0, application: 0, profile: 0, target: 0, review: 0, publishers: 0, apply: 1, results: 0 });
	});

	test('dismissal in rerun mode still cancels an admitted Apply while leaving the record alone', () => {
		const completed = '{"version":1,"status":"completed","completedAt":1}';
		const { session, stored, migrations } = setup(completed);
		session.chooseRoute('migrate');
		migrations[0].publish({ phase: 'apply' });

		session.recordDismissal();

		assert.deepStrictEqual(migrations[0].calls.at(-1), ['requestCancellation']);
		assert.strictEqual(stored(), completed, 'looking at a completed onboarding again must not downgrade it');
	});

	test('disposing the onboarding session disposes an embedded migration in flight', () => {
		const storage = disposables.add(new InMemoryStorageService());
		const migration = new MigrationStub(true);
		// Not added to the suite's disposables on purpose: the leak tracker proves the session
		// disposed it, and a leaked migration session would keep a cancellation token alive.
		const session = new OnboardingSession(new OnboardingStateStore(storage), () => migration as unknown as EditorMigrationFlowSession);
		session.initialize();
		session.chooseRoute('migrate');
		migration.publish({ phase: 'apply' });

		session.dispose();

		assert.strictEqual(migration.disposed, true);
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

	test('a migration change after the flow finished is still harmless', async () => {
		const { session, migrations, changes } = setup();
		session.chooseRoute('migrate');
		const migration = migrations[0];
		session.skip();
		await timeout(0);

		const before = changes.length;
		migration.publish({ phase: 'application' });
		assert.strictEqual(changes.length, before, 'a disposed migration no longer reaches the onboarding session');
	});
});

/**
 * Stands in for the embedded migration session.
 *
 * The onboarding session may only create it, start it, read its state, ask it to acknowledge or
 * cancel, and dispose it; the stub records those calls and runs no migration behaviour. It is a
 * `Disposable` so the suite's leak tracker sees whether onboarding disposed it.
 */
class MigrationStub extends Disposable {
	readonly calls: (readonly unknown[])[] = [];
	disposed = false;
	private readonly emitter = this._register(new Emitter<EditorMigrationFlowState>());
	readonly onDidChangeState = this.emitter.event;
	private current: EditorMigrationFlowState = flowState({});

	constructor(private readonly acknowledged: boolean) {
		super();
	}

	get state(): EditorMigrationFlowState {
		return this.current;
	}

	publish(overrides: Partial<EditorMigrationFlowState>): void {
		this.current = { ...this.current, ...overrides };
		this.emitter.fire(this.current);
	}

	async initialize(): Promise<void> {
		this.calls.push(['initialize']);
	}

	async acknowledge(restart = true): Promise<boolean> {
		this.calls.push(['acknowledge', restart]);
		return this.acknowledged;
	}

	requestCancellation(): void {
		this.calls.push(['requestCancellation']);
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}

function flowState(overrides: Partial<EditorMigrationFlowState>): EditorMigrationFlowState {
	return {
		phase: 'loading',
		busy: false,
		canceling: false,
		recoveries: [],
		applications: [],
		discoveryDiagnostics: [],
		targets: [],
		selectedCategories: [],
		decisions: {},
		publishers: [],
		reviewNeedsRebuild: false,
		...overrides,
	};
}
