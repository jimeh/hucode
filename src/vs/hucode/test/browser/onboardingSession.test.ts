/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { EditorMigrationFlowPhase, EditorMigrationFlowSession, EditorMigrationFlowState } from '../../browser/migration/editorMigrationFlow.js';
import { IOnboardingAppearanceAuthority, OnboardingAppearanceDraft, OnboardingAppearanceSnapshot } from '../../browser/onboarding/onboardingAppearance.js';
import { IOnboardingOmniAuthority, OnboardingOmniSnapshot } from '../../browser/onboarding/onboardingOmni.js';
import { EditorMigrationOperation } from '../../common/migration/editorMigrationApply.js';
import { OnboardingSession, OnboardingSessionState } from '../../browser/onboarding/onboardingSession.js';
import { ONBOARDING_STATE_STORAGE_KEY, OnboardingRecord, OnboardingStateStore } from '../../browser/onboarding/onboardingStateStore.js';

suite('OnboardingSession', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(raw?: string, options: {
		readonly manualAppearance?: boolean;
		readonly commandsFail?: boolean;
		readonly surfaceCloseTimeout?: number;
		readonly checkpoint?: (record: OnboardingRecord) => Promise<void>;
		readonly readAuthority?: () => Promise<string | undefined>;
	} = {}) {
		const storage = disposables.add(new InMemoryStorageService());
		if (raw !== undefined) {
			storage.store(ONBOARDING_STATE_STORAGE_KEY, raw, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		const migrations: MigrationStub[] = [];
		const appearance = new AppearanceStub(options.manualAppearance ?? false);
		const omni = new OmniStub(options.commandsFail ?? false);
		const session = disposables.add(new OnboardingSession(
			new OnboardingStateStore(storage, options.checkpoint, options.readAuthority),
			() => {
				const migration = new MigrationStub();
				migrations.push(migration);
				return migration as unknown as EditorMigrationFlowSession;
			},
			appearance,
			omni,
			new NullLogService(),
			() => 1_700_000_000_000,
			options.surfaceCloseTimeout,
		));
		const finished: number[] = [];
		const changes: OnboardingSessionState[] = [];
		// Finishing is logged beside the Omni calls so a test can assert what ran before and after it.
		disposables.add(session.onDidFinish(() => { finished.push(1); omni.calls.push(['finish']); }));
		disposables.add(session.onDidChangeState(state => changes.push(state)));
		session.initialize();
		const stored = () => storage.get(ONBOARDING_STATE_STORAGE_KEY, StorageScope.APPLICATION);
		const position = () => ({ stage: session.state.stage, route: session.state.route });
		/** What the appearance stage shows and has staged, in one comparable shape. */
		const appearanceView = () => ({
			stage: session.state.stage,
			busy: session.state.busy,
			loaded: session.state.appearance !== undefined,
			draft: session.state.appearanceDraft,
			error: session.state.error,
			announcement: session.state.announcement,
		});
		/** Walks the Skip Import route to Meet Omni. */
		const reachMeetOmni = async () => {
			session.chooseRoute('skipImport');
			await timeout(0);
			await session.continueStage();
			assert.strictEqual(session.state.stage, 'meetOmni');
		};
		return { session, stored, finished, changes, migrations, position, appearance, appearanceView, omni, reachMeetOmni };
	}

	test('repeated Skip while the initial authority read is pending does not read or finish again', async () => {
		const read = new DeferredPromise<string | undefined>();
		let reads = 0;
		let writes = 0;
		const { session, finished } = setup(undefined, {
			readAuthority: () => { reads++; return read.p; },
			checkpoint: async () => { writes++; },
		});
		await session.skip();
		await session.skip();
		assert.deepStrictEqual({ reads, writes, finished, busy: session.state.busy }, { reads: 1, writes: 0, finished: [], busy: true });
		read.complete('{"version":2,"status":"inProgress","stage":"bring"}');
		await timeout(0);
		assert.deepStrictEqual({ reads, writes, finished, busy: session.state.busy }, { reads: 1, writes: 0, finished: [], busy: false });
	});

	test('opens in first mode for a fresh or resumable record and rerun mode for an ended one', () => {
		assert.deepStrictEqual({
			missing: setup().session.state.mode,
			notStarted: setup('{"version":1,"status":"notStarted"}').session.state.mode,
			inProgress: setup('{"version":1,"status":"inProgress","stage":"bring"}').session.state.mode,
			skipped: setup('{"version":1,"status":"skipped"}').session.state.mode,
			completed: setup('{"version":1,"status":"completed","completedAt":1}').session.state.mode,
			superseded: setup('{"version":3,"status":"notStarted"}').session.state.mode,
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
			migrate: { stage: 'migrate', route: 'migrate' },
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
			superseded: setup('{"version":3,"status":"completed","route":"migrate","completedAt":5}').session.state.previous,
			first: setup().session.state.previous,
		}, {
			completed: { status: 'completed', route: 'migrate', completedAt: 5 },
			skipped: { status: 'skipped', route: undefined, completedAt: undefined },
			superseded: { status: 'superseded' },
			first: undefined,
		});
	});

	test('Skip Import opens the appearance stage without creating a migration session', async () => {
		const { session, migrations, position } = setup();

		session.chooseRoute('skipImport');
		assert.deepStrictEqual(position(), { stage: 'appearance', route: 'skipImport' });
		await timeout(0);
		await session.continueStage();
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

	test('Continue on concluded results disposes the migration without acknowledging and lands on Meet Omni', async () => {
		const { session, migrations, position, omni } = setup();
		session.chooseRoute('migrate');
		const migration = migrations[0];
		migration.publish({ phase: 'results', operation: concludedOperation() });

		await session.continueStage();

		assert.deepStrictEqual({
			calls: migration.calls,
			position: position(),
			disposed: migration.disposed,
			migration: session.migration,
			omniCalls: omni.calls,
		}, {
			// Nothing but discovery was ever asked of the migration: the recovery data stays in the journal.
			calls: [['initialize']],
			position: { stage: 'meetOmni', route: 'migrate' },
			disposed: true,
			migration: undefined,
			omniCalls: [['snapshot']],
		});
		assert.strictEqual(session.back(), false, 'the migration session is gone, so there is nothing to go back to');
		assert.deepStrictEqual(position(), { stage: 'meetOmni', route: 'migrate' });
	});

	test('Continue is refused inside the migration unless its results have concluded', async () => {
		const refused: Record<string, boolean> = {};
		const attempt = async (name: string, overrides: Partial<EditorMigrationFlowState>) => {
			const { session, migrations, position } = setup();
			session.chooseRoute('migrate');
			migrations[0].publish(overrides);
			await session.continueStage();
			refused[name] = position().stage === 'migrate' && !migrations[0].disposed;
		};
		for (const phase of ['loading', 'recovery', 'application', 'profile', 'target', 'review', 'publishers', 'apply'] as const) {
			await attempt(phase, { phase, operation: concludedOperation() });
		}
		await attempt('resultsWithoutOperation', { phase: 'results' });
		await attempt('resultsAdmitted', { phase: 'results', operation: { ...concludedOperation(), stage: 'admitted', aggregateOutcome: undefined } });
		await attempt('resultsBusy', { phase: 'results', operation: concludedOperation(), busy: true });
		await attempt('resultsCanceling', { phase: 'results', operation: concludedOperation(), canceling: true });
		assert.deepStrictEqual(refused, {
			loading: true, recovery: true, application: true, profile: true, target: true, review: true, publishers: true, apply: true,
			resultsWithoutOperation: true, resultsAdmitted: true, resultsBusy: true, resultsCanceling: true,
		});
	});

	test('Finish records completion with the route and the injected clock, once', async () => {
		const skipImport = setup();
		await skipImport.reachMeetOmni();
		await skipImport.session.finishForNow();
		await skipImport.session.finishForNow();
		assert.deepStrictEqual({ record: JSON.parse(skipImport.stored()!), finished: skipImport.finished }, {
			record: { version: 2, status: 'completed', route: 'skipImport', completedAt: 1_700_000_000_000 },
			finished: [1],
		});

		// Outside Meet Omni it is not offered, so it must not end the flow.
		const early = setup();
		early.session.chooseRoute('skipImport');
		await early.session.finishForNow();
		assert.deepStrictEqual({ record: JSON.parse(early.stored()!), finished: early.finished }, { record: { version: 2, status: 'inProgress', stage: 'appearance', route: 'skipImport' }, finished: [] });
	});

	test('entering Meet Omni retakes the Omni snapshot on every entry', async () => {
		const { session, omni, reachMeetOmni } = setup();
		await reachMeetOmni();
		assert.deepStrictEqual(session.state.omni, { shortcuts: [] });

		assert.strictEqual(session.back(), true);
		await timeout(0);
		await session.continueStage();
		assert.deepStrictEqual({ stage: session.state.stage, calls: omni.calls }, { stage: 'meetOmni', calls: [['snapshot'], ['snapshot']] });
	});

	test('each finish records completion, then runs its handoff after the surface has finished', async () => {
		const now = setup();
		await now.reachMeetOmni();
		await now.session.finishForNow();

		const project = setup();
		await project.reachMeetOmni();
		await project.session.addProject();

		const workbench = setup();
		await workbench.reachMeetOmni();
		await workbench.session.openFolderAsWorkbench();

		assert.deepStrictEqual({
			now: [now.omni.calls, JSON.parse(now.stored()!).status],
			project: [project.omni.calls, JSON.parse(project.stored()!).status],
			workbench: [workbench.omni.calls, JSON.parse(workbench.stored()!).status],
		}, {
			now: [[['snapshot'], ['finish']], 'completed'],
			// The command runs only after the surface has finished, so its dialog is not under the modal.
			project: [[['snapshot'], ['finish'], ['addProject']], 'completed'],
			workbench: [[['snapshot'], ['finish'], ['openFolderAsWorkbench']], 'completed'],
		});
	});

	test('a handoff waits for the bound surface to close, within a bound', async () => {
		const closed = setup();
		await closed.reachMeetOmni();
		const closing = disposables.add(new Emitter<void>());
		disposables.add(closed.session.bindSurface(closing.event));
		const handoff = closed.session.addProject();
		await timeout(0);
		const beforeClose = closed.omni.calls.slice();
		closing.fire();
		await handoff;

		const stuck = setup(undefined, { surfaceCloseTimeout: 1 });
		await stuck.reachMeetOmni();
		const never = disposables.add(new Emitter<void>());
		disposables.add(stuck.session.bindSurface(never.event));
		await stuck.session.openFolderAsWorkbench();

		assert.deepStrictEqual({ beforeClose, afterClose: closed.omni.calls, stuck: stuck.omni.calls }, {
			beforeClose: [['snapshot'], ['finish']],
			afterClose: [['snapshot'], ['finish'], ['addProject']],
			// A surface that never closes cannot swallow the command.
			stuck: [['snapshot'], ['finish'], ['openFolderAsWorkbench']],
		});
	});

	test('a rejected handoff command is not surfaced', async () => {
		const { session, omni, finished, stored, reachMeetOmni } = setup(undefined, { commandsFail: true });
		await reachMeetOmni();

		await session.addProject();

		assert.deepStrictEqual({ finished, calls: omni.calls, error: session.state.error, status: JSON.parse(stored()!).status }, {
			finished: [1],
			calls: [['snapshot'], ['finish'], ['addProject']],
			error: undefined,
			status: 'completed',
		});
	});

	test('dismissal on Meet Omni records the stage and its route', async () => {
		const { session, stored, reachMeetOmni } = setup();
		await reachMeetOmni();

		session.recordDismissal();

		assert.deepStrictEqual(JSON.parse(stored()!), { version: 2, status: 'inProgress', stage: 'meetOmni', route: 'skipImport' });
	});

	test('Finish never rewrites a record a newer build owns, but still finishes', async () => {
		const newer = '{"version":3,"status":"completed"}';
		const { session, stored, finished, reachMeetOmni } = setup(newer);
		await reachMeetOmni();

		await session.finishForNow();

		assert.deepStrictEqual({ raw: stored(), finished }, { raw: newer, finished: [1] });
	});

	test('skip records the choice and finishes once', async () => {
		const { session, stored, finished } = setup();

		await session.skip();
		await session.skip();

		assert.deepStrictEqual({ record: JSON.parse(stored()!), finished }, { record: { version: 2, status: 'skipped' }, finished: [1] });
	});

	test('skip from a completed record finishes without downgrading it', async () => {
		const completed = '{"version":1,"status":"completed","completedAt":1}';
		const { session, stored, finished } = setup(completed);

		await session.skip();

		assert.deepStrictEqual({ raw: stored(), finished }, { raw: completed, finished: [1] }, 'a completed installation keeps its record and its completedAt');
	});

	test('dismissal records the current stage and route as resumable', () => {
		const fresh = setup();
		fresh.session.recordDismissal();
		assert.deepStrictEqual(JSON.parse(fresh.stored()!), { version: 2, status: 'inProgress', stage: 'bring' });

		const appearance = setup();
		appearance.session.chooseRoute('skipImport');
		appearance.session.recordDismissal();
		assert.deepStrictEqual(JSON.parse(appearance.stored()!), { version: 2, status: 'inProgress', stage: 'appearance', route: 'skipImport' });

		const migrate = setup();
		migrate.session.chooseRoute('migrate');
		migrate.session.recordDismissal();
		assert.deepStrictEqual(JSON.parse(migrate.stored()!), { version: 2, status: 'inProgress', stage: 'migrate', route: 'migrate' });
	});

	test('every stage change records the stage before any dismissal, except in rerun mode', async () => {
		const { session, stored, reachMeetOmni } = setup();
		const records: (string | undefined)[] = [];
		session.chooseRoute('migrate');
		records.push(stored());
		session.back();
		records.push(stored());
		await reachMeetOmni();
		records.push(stored());

		const rerun = setup('{"version":1,"status":"skipped"}');
		rerun.session.chooseRoute('skipImport');
		await timeout(0);

		assert.deepStrictEqual({ records: records.map(raw => JSON.parse(raw!)), rerun: JSON.parse(rerun.stored()!) }, {
			// A window that exits without a dismissal still reopens where the user was.
			records: [
				{ version: 2, status: 'inProgress', stage: 'migrate', route: 'migrate' },
				{ version: 2, status: 'inProgress', stage: 'bring' },
				{ version: 2, status: 'inProgress', stage: 'meetOmni', route: 'skipImport' },
			],
			rerun: { version: 1, status: 'skipped' },
		});
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
		const migration = new MigrationStub();
		// Not added to the suite's disposables on purpose: the leak tracker proves the session
		// disposed it, and a leaked migration session would keep a cancellation token alive.
		const session = new OnboardingSession(new OnboardingStateStore(storage), () => migration as unknown as EditorMigrationFlowSession, new AppearanceStub(false), new OmniStub(false), new NullLogService());
		session.initialize();
		session.chooseRoute('migrate');
		migration.publish({ phase: 'apply' });

		session.dispose();

		assert.strictEqual(migration.disposed, true);
	});

	test('dismissal after skip changes nothing', async () => {
		const { session, stored } = setup();
		await session.skip();

		session.recordDismissal();

		assert.deepStrictEqual(JSON.parse(stored()!), { version: 2, status: 'skipped' });
	});

	test('dismissal in rerun mode leaves an ended record alone', () => {
		const completed = '{"version":1,"status":"completed","completedAt":1}';
		const { session, stored } = setup(completed);

		session.recordDismissal();

		assert.strictEqual(stored(), completed, 'looking at a completed onboarding again must not downgrade it');
	});

	test('never rewrites a record a newer build owns', async () => {
		const newer = '{"version":3,"status":"completed"}';
		const { session, stored, finished } = setup(newer);

		session.recordDismissal();
		await session.skip();

		assert.deepStrictEqual({ raw: stored(), finished }, { raw: newer, finished: [1] });
	});

	test('binds dismissal to the surface closing, not to renderer traffic', () => {
		const { session, stored } = setup();
		const closing = disposables.add(new Emitter<void>());
		disposables.add(session.bindSurface(closing.event));

		assert.deepStrictEqual(JSON.parse(stored()!), { version: 2, status: 'inProgress', stage: 'bring' });
		closing.fire();
		assert.deepStrictEqual(JSON.parse(stored()!), { version: 2, status: 'inProgress', stage: 'bring' });
	});

	test('entering appearance loads the snapshot while busy and prefills the draft from it', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });

		session.chooseRoute('skipImport');
		assert.deepStrictEqual(appearanceView(), { stage: 'appearance', busy: true, loaded: false, draft: undefined, error: undefined, announcement: undefined });
		assert.deepStrictEqual(session.selectMode('light'), false, 'nothing is staged before the choices exist');
		await session.continueStage();
		assert.strictEqual(session.state.stage, 'appearance', 'Continue waits for the load');

		await timeout(0);
		appearance.resolveSnapshot();
		await timeout(0);
		assert.deepStrictEqual(appearanceView(), {
			stage: 'appearance',
			busy: false,
			loaded: true,
			draft: { mode: 'dark', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' },
			error: undefined,
			announcement: 'Appearance choices loaded.',
		});
		assert.deepStrictEqual(appearance.calls, [['snapshot']]);
	});

	test('resuming on appearance and returning from Meet Omni both load the snapshot', async () => {
		const resumed = setup('{"version":1,"status":"inProgress","stage":"appearance","route":"skipImport"}');
		assert.deepStrictEqual([resumed.session.state.stage, resumed.session.state.busy], ['appearance', true]);
		await timeout(0);
		assert.deepStrictEqual(resumed.appearance.calls, [['snapshot']]);

		const returned = setup();
		returned.session.chooseRoute('skipImport');
		await timeout(0);
		await returned.session.continueStage();
		assert.strictEqual(returned.session.back(), true);
		assert.deepStrictEqual([returned.session.state.stage, returned.session.state.busy], ['appearance', true]);
		await timeout(0);
		assert.deepStrictEqual(returned.appearance.calls.map(call => call[0]), ['snapshot', 'snapshot'], 'nothing was chosen, so nothing was written');
	});

	test('a snapshot that arrives after the stage was left cannot overwrite the newer state', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		await timeout(0);
		const first = appearance.pendingSnapshot!;
		assert.strictEqual(session.back(), true);
		assert.deepStrictEqual(appearanceView(), { stage: 'bring', busy: false, loaded: false, draft: undefined, error: undefined, announcement: undefined });

		session.chooseRoute('skipImport');
		first.complete(snapshot());
		await timeout(0);
		assert.deepStrictEqual(appearanceView(), { stage: 'appearance', busy: true, loaded: false, draft: undefined, error: undefined, announcement: undefined }, 'the first load belongs to a stage that is gone');

		await timeout(0);
		appearance.resolveSnapshot();
		await timeout(0);
		assert.deepStrictEqual([appearanceView().busy, appearanceView().loaded], [false, true]);
	});

	test('choices accept only offered ids, are written together as they are made, and survive Back to bring', async () => {
		const { session, appearance, appearanceView } = setup();
		session.chooseRoute('skipImport');
		await timeout(0);

		assert.deepStrictEqual({
			mode: session.selectMode('light'),
			light: session.selectPreferredTheme('light', 'Quiet Light'),
			wrongList: session.selectPreferredTheme('light', 'Monokai'),
			unknown: session.selectPreferredTheme('dark', 'Nope'),
			dark: session.selectPreferredTheme('dark', 'Monokai'),
		}, { mode: true, light: true, wrongList: false, unknown: false, dark: true });
		assert.deepStrictEqual(appearanceView().draft, { mode: 'light', preferredLight: 'Quiet Light', preferredDark: 'Monokai' });
		await timeout(0);
		const chosen = { mode: 'light', preferredLight: 'Quiet Light', preferredDark: 'Monokai' };
		assert.deepStrictEqual(appearance.calls, [['snapshot'], ['apply', snapshot(), chosen]], 'choices made before the first write ran are written in one go');
		assert.deepStrictEqual(session.state.appearance, { ...snapshot(), ...chosen }, 'the written values are the next baseline');

		assert.strictEqual(session.back(), true);
		session.chooseRoute('skipImport');
		await timeout(0);
		assert.deepStrictEqual(appearanceView().draft, chosen, 'Back keeps the choices in memory');
		await session.continueStage();
		// The stub reads back the same fixed snapshot, so the choices are ahead of it again.
		assert.deepStrictEqual(appearance.calls, [['snapshot'], ['apply', snapshot(), chosen], ['snapshot'], ['apply', snapshot(), chosen]], 'Continue writes whatever the reloaded snapshot still lacks');
		assert.strictEqual(appearanceView().stage, 'meetOmni');
	});

	test('writes run one after another, each carrying what was chosen since, and Continue waits for them', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		await timeout(0);
		appearance.resolveSnapshot();
		await timeout(0);

		session.selectMode('system');
		await timeout(0);
		assert.deepStrictEqual(session.selectMode('dark'), true, 'a choice during a write is accepted');
		assert.deepStrictEqual([appearanceView().busy, appearanceView().error], [false, undefined], 'a write in flight does not block the stage');
		appearance.resolveApply();
		await timeout(0);
		assert.deepStrictEqual(session.state.appearance?.mode, 'system', 'the first write landed before the second started');

		const continued = session.continueStage();
		assert.deepStrictEqual([appearanceView().stage, appearanceView().busy], ['appearance', true]);
		assert.deepStrictEqual(session.selectMode('light'), false, 'nothing may change once Continue is waiting');
		appearance.resolveApply();
		await continued;

		assert.deepStrictEqual(appearance.calls, [
			['snapshot'],
			['apply', snapshot(), { mode: 'system', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }],
			['apply', { ...snapshot(), mode: 'system' }, { mode: 'dark', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }],
		]);
		assert.deepStrictEqual(appearanceView(), { stage: 'meetOmni', busy: false, loaded: true, draft: { mode: 'dark', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }, error: undefined, announcement: 'Appearance choices loaded.' });
	});

	test('a failed write shows its error and keeps the choice, and Continue writes it again', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		await timeout(0);
		appearance.resolveSnapshot();
		await timeout(0);
		session.selectMode('light');
		await timeout(0);

		appearance.rejectApply(new Error('settings file is read-only'));
		await timeout(0);
		assert.deepStrictEqual(appearanceView(), { stage: 'appearance', busy: false, loaded: true, draft: { mode: 'light', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }, error: 'settings file is read-only', announcement: 'settings file is read-only' });

		const continued = session.continueStage();
		assert.strictEqual(appearanceView().error, undefined, 'a retry clears the error');
		await timeout(0);
		appearance.resolveApply();
		await continued;
		assert.deepStrictEqual(appearance.calls.map(call => call[0]), ['snapshot', 'apply', 'apply'], 'the failed write left the snapshot behind, so Continue found the same difference');
		assert.deepStrictEqual([appearanceView().stage, appearanceView().error], ['meetOmni', undefined]);
	});

	test('a write that still fails under Continue stays on appearance with its error', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		await timeout(0);
		appearance.resolveSnapshot();
		await timeout(0);
		session.selectMode('light');
		await timeout(0);
		appearance.rejectApply(new Error('settings file is read-only'));
		await timeout(0);

		const continued = session.continueStage();
		await timeout(0);
		appearance.rejectApply(new Error('still read-only'));
		await continued;
		assert.deepStrictEqual(appearanceView(), { stage: 'appearance', busy: false, loaded: true, draft: { mode: 'light', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }, error: 'still read-only', announcement: 'still read-only' });
	});

	test('a failed snapshot leaves the stage passable and Continue writes nothing', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		await timeout(0);
		appearance.rejectSnapshot(new Error('theme registry unavailable'));
		await timeout(0);
		assert.deepStrictEqual(appearanceView(), { stage: 'appearance', busy: false, loaded: false, draft: undefined, error: 'theme registry unavailable', announcement: 'theme registry unavailable' });

		await session.continueStage();

		assert.deepStrictEqual([appearanceView().stage, appearanceView().error], ['meetOmni', undefined]);
		assert.deepStrictEqual(appearance.calls, [['snapshot']]);
	});

	test('re-entering appearance reads the snapshot only after a write from before Back has landed', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		await timeout(0);
		appearance.resolveSnapshot();
		await timeout(0);
		session.selectMode('light');
		await timeout(0);

		assert.strictEqual(session.back(), true);
		session.chooseRoute('skipImport');
		await timeout(0);
		const callsWhileWritePending = appearance.calls.map(call => call[0]);
		appearance.resolveApply();
		await timeout(0);

		assert.deepStrictEqual({ callsWhileWritePending, calls: appearance.calls.map(call => call[0]), busy: appearanceView().busy }, {
			// The reload would otherwise prefill from values the pending write is about to replace.
			callsWhileWritePending: ['snapshot', 'apply'],
			calls: ['snapshot', 'apply', 'snapshot'],
			busy: true,
		});
	});

	test('Back during a write leaves for bring and discards the write\'s result', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		await timeout(0);
		appearance.resolveSnapshot();
		await timeout(0);
		session.selectMode('light');
		await timeout(0);
		const continued = session.continueStage();

		assert.strictEqual(session.back(), true);
		appearance.rejectApply(new Error('settings file is read-only'));
		await continued;

		assert.deepStrictEqual(appearanceView(), { stage: 'bring', busy: false, loaded: true, draft: { mode: 'light', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }, error: undefined, announcement: 'Appearance choices loaded.' }, 'neither the failure nor Continue reached the stage that was left');
	});

	test('a migration change after the flow finished is still harmless', async () => {
		const { session, migrations, changes } = setup();
		session.chooseRoute('migrate');
		const migration = migrations[0];
		await session.skip();
		await timeout(0);

		const before = changes.length;
		migration.publish({ phase: 'application' });
		assert.strictEqual(changes.length, before, 'a disposed migration no longer reaches the onboarding session');
	});
	test('native navigation waits for acknowledgement before loading appearance', async () => {
		const pending = new DeferredPromise<void>();
		const { session, appearance } = setup('{"version":2,"status":"inProgress","stage":"bring"}', { checkpoint: () => pending.p });
		session.chooseRoute('skipImport');
		assert.deepStrictEqual({ stage: session.state.stage, busy: session.state.busy, loads: appearance.calls.length }, { stage: 'bring', busy: true, loads: 0 });
		pending.complete();
		await timeout(0);
		assert.deepStrictEqual({ stage: session.state.stage, busy: session.state.busy, loaded: !!session.state.appearance }, { stage: 'appearance', busy: false, loaded: true });
	});

	test('restored appearance cannot be overwritten by a delayed navigation checkpoint', async () => {
		let writes = 0;
		const { session } = setup('{"version":2,"status":"inProgress","stage":"appearance","route":"skipImport"}', { checkpoint: async () => { writes++; } });
		await timeout(0);
		assert.deepStrictEqual({ writes, stage: session.state.stage, loaded: !!session.state.appearance, busy: session.state.busy }, { writes: 0, stage: 'appearance', loaded: true, busy: false });
	});

	test('failed terminal checkpoint stays visible and retry performs another write before finishing', async () => {
		let writes = 0;
		const { session, finished } = setup('{"version":2,"status":"inProgress","stage":"meetOmni","route":"skipImport"}', { checkpoint: async () => { if (++writes === 1) { throw new Error('disk unavailable'); } } });
		await session.finishForNow();
		assert.deepStrictEqual({ finished: [...finished], error: session.state.error, busy: session.state.busy }, { finished: [], error: 'disk unavailable', busy: false });
		await session.finishForNow();
		assert.deepStrictEqual({ writes, finished }, { writes: 2, finished: [1] });
	});

	test('failed Skip stays resumable and does not close the surface', async () => {
		const { session, finished } = setup('{"version":2,"status":"inProgress","stage":"bring"}', { checkpoint: async () => { throw new Error('disk unavailable'); } });
		await session.skip();
		assert.deepStrictEqual({ finished, error: session.state.error, busy: session.state.busy }, { finished: [], error: 'disk unavailable', busy: false });
	});

	test('a session disposed during terminal acknowledgement never starts its handoff', async () => {
		const pending = new DeferredPromise<void>();
		const { session, finished, omni } = setup('{"version":2,"status":"inProgress","stage":"meetOmni","route":"skipImport"}', { checkpoint: () => pending.p });
		const completing = session.addProject();
		session.dispose();
		pending.complete();
		await completing;
		assert.deepStrictEqual({ finished, calls: omni.calls }, { finished: [], calls: [['snapshot']] });
	});

	test('immediate reopen reads accepted completion before the renderer storage mirror catches up', async () => {
		const stale = '{"version":2,"status":"inProgress","stage":"meetOmni","route":"skipImport"}';
		let accepted = stale;
		const options = { checkpoint: async (record: OnboardingRecord) => { accepted = JSON.stringify(record); }, readAuthority: async () => accepted };
		const first = setup(stale, options);
		await timeout(0);
		await first.session.finishForNow();
		const reopened = setup(stale, options);
		await timeout(0);
		assert.deepStrictEqual({ mode: reopened.session.state.mode, previous: reopened.session.state.previous?.status }, { mode: 'rerun', previous: 'completed' });
	});

	test('restored migrate starts recovery discovery without another Import click or mutation', () => {
		const { session, migrations } = setup('{"version":2,"status":"inProgress","stage":"migrate","route":"migrate"}');
		assert.strictEqual(session.state.stage, 'migrate');
		assert.strictEqual(migrations.length, 1);
		assert.deepStrictEqual(migrations[0].calls, [['initialize']]);
	});

	test('handoff references use the attached target and exclude rollback and pending targets', async () => {
		for (const operation of [
			concludedOperation(),
			{ ...concludedOperation(), aggregateOutcome: 'recoverable' as const },
			{ ...concludedOperation(), aggregateOutcome: 'completedWithIssues' as const },
			{ ...concludedOperation(), stage: 'rolledBack' as const, aggregateOutcome: 'rolledBack' as const },
			{ ...concludedOperation(), aggregateOutcome: 'rolledBack' as const },
			{ ...concludedOperation(), target: { state: 'pending' as const } },
		]) {
			const { session, migrations, stored } = setup();
			session.chooseRoute('migrate');
			migrations[0].publish({ phase: 'results', operation, busy: false });
			await session.continueStage();
			assert.strictEqual(JSON.parse(stored()!).handoffProfileId, operation.stage === 'settled' && operation.aggregateOutcome !== 'rolledBack' && operation.target.state === 'attached' ? 'imported' : undefined);
			assert.strictEqual(session.state.importHadIssues, operation.aggregateOutcome === 'recoverable' || operation.aggregateOutcome === 'completedWithIssues');
		}
	});

	test('malformed bytes survive manual open until an explicit route choice', () => {
		const { session, stored } = setup('{broken');
		assert.strictEqual(stored(), '{broken');
		session.chooseRoute('migrate');
		assert.strictEqual(JSON.parse(stored()!).stage, 'migrate');
	});

});

/**
 * Stands in for the embedded migration session.
 *
 * The onboarding session may only create it, start it, read its state, ask it to cancel, and
 * dispose it; the stub records those calls and runs no migration behaviour. It is a `Disposable`
 * so the suite's leak tracker sees whether onboarding disposed it.
 */
class MigrationStub extends Disposable {
	readonly calls: (readonly unknown[])[] = [];
	disposed = false;
	private readonly emitter = this._register(new Emitter<EditorMigrationFlowState>());
	readonly onDidChangeState = this.emitter.event;
	private current: EditorMigrationFlowState = flowState({});

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

	requestCancellation(): void {
		this.calls.push(['requestCancellation']);
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}

function snapshot(): OnboardingAppearanceSnapshot {
	return {
		mode: 'dark',
		colorTheme: 'Dark 2026',
		preferredLight: 'Light 2026',
		preferredDark: 'Dark 2026',
		lightThemes: [{ id: 'Light 2026', label: 'Light 2026' }, { id: 'Quiet Light', label: 'Quiet Light' }],
		darkThemes: [{ id: 'Dark 2026', label: 'Dark 2026' }, { id: 'Monokai', label: 'Monokai' }],
	};
}

/**
 * Stands in for the appearance authority.
 *
 * Automatic mode answers every call at once with the fixed snapshot; manual mode leaves each call
 * pending until the test settles it, which is how the ordering cases are driven.
 */
class AppearanceStub implements IOnboardingAppearanceAuthority {
	readonly calls: (readonly unknown[])[] = [];
	pendingSnapshot: DeferredPromise<OnboardingAppearanceSnapshot> | undefined;
	pendingApply: DeferredPromise<void> | undefined;

	constructor(private readonly manual: boolean) { }

	snapshot(): Promise<OnboardingAppearanceSnapshot> {
		this.calls.push(['snapshot']);
		if (!this.manual) {
			return Promise.resolve(snapshot());
		}
		this.pendingSnapshot = new DeferredPromise();
		return this.pendingSnapshot.p;
	}

	apply(current: OnboardingAppearanceSnapshot, draft: OnboardingAppearanceDraft): Promise<OnboardingAppearanceSnapshot> {
		this.calls.push(['apply', current, draft]);
		const next = { ...current, ...draft };
		if (!this.manual) {
			return Promise.resolve(next);
		}
		this.pendingApply = new DeferredPromise();
		return this.pendingApply.p.then(() => next);
	}

	resolveSnapshot(): void {
		void this.pendingSnapshot!.complete(snapshot());
	}

	rejectSnapshot(error: Error): void {
		void this.pendingSnapshot!.error(error);
	}

	resolveApply(): void {
		void this.pendingApply!.complete();
	}

	rejectApply(error: Error): void {
		void this.pendingApply!.error(error);
	}
}

/**
 * Stands in for the Omni authority.
 *
 * The snapshot is synchronous, as the real one is. Commands record their call and either resolve
 * or, when the stub was built to fail them, reject.
 */
class OmniStub implements IOnboardingOmniAuthority {
	readonly calls: (readonly unknown[])[] = [];

	constructor(private readonly commandsFail: boolean) { }

	snapshot(): OnboardingOmniSnapshot {
		this.calls.push(['snapshot']);
		return { shortcuts: [] };
	}

	addProject(): Promise<void> {
		return this.command('addProject');
	}

	openFolderAsWorkbench(): Promise<void> {
		return this.command('openFolderAsWorkbench');
	}

	private command(name: string): Promise<void> {
		this.calls.push([name]);
		return this.commandsFail ? Promise.reject(new Error(`${name} was cancelled`)) : Promise.resolve();
	}
}

/** The least of a settled operation the session reads: its stage and outcome. */
function concludedOperation(): EditorMigrationOperation {
	return { id: 'operation', stage: 'settled', aggregateOutcome: 'completed', target: { state: 'attached', profileId: 'imported' } } as EditorMigrationOperation;
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
