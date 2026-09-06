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
import { IOnboardingOmniAuthority, OnboardingDensity, OnboardingOmniSnapshot } from '../../browser/onboarding/onboardingOmni.js';
import { OnboardingSession, OnboardingSessionState, bindOnboardingDismissal } from '../../browser/onboarding/onboardingSession.js';
import { ONBOARDING_STATE_STORAGE_KEY, OnboardingStateStore } from '../../browser/onboarding/onboardingStateStore.js';

suite('OnboardingSession', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(raw?: string, options: {
		readonly acknowledged?: boolean;
		readonly manualAppearance?: boolean;
		readonly omniDensity?: OnboardingDensity;
		readonly manualOmni?: boolean;
		readonly commandsFail?: boolean;
	} = {}) {
		const storage = disposables.add(new InMemoryStorageService());
		if (raw !== undefined) {
			storage.store(ONBOARDING_STATE_STORAGE_KEY, raw, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		const migrations: MigrationStub[] = [];
		const appearance = new AppearanceStub(options.manualAppearance ?? false);
		const omni = new OmniStub(options.omniDensity ?? 'default', options.manualOmni ?? false, options.commandsFail ?? false);
		const session = disposables.add(new OnboardingSession(
			new OnboardingStateStore(storage),
			() => {
				const migration = new MigrationStub(options.acknowledged ?? true);
				migrations.push(migration);
				return migration as unknown as EditorMigrationFlowSession;
			},
			appearance,
			omni,
			new NullLogService(),
			() => 1_700_000_000_000,
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
		/** Where Meet Omni stands: the draft against the snapshot, and whether a write is in flight. */
		const omniView = () => ({
			stage: session.state.stage,
			busy: session.state.busy,
			snapshot: session.state.omni?.density,
			density: session.state.density,
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
		return { session, stored, finished, changes, migrations, position, appearance, appearanceView, omni, omniView, reachMeetOmni };
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

	test('Finish for Now records completion with the route, the density, and the injected clock, once', async () => {
		const skipImport = setup();
		await skipImport.reachMeetOmni();
		await skipImport.session.finishForNow();
		await skipImport.session.finishForNow();
		assert.deepStrictEqual({ record: JSON.parse(skipImport.stored()!), finished: skipImport.finished }, {
			record: { version: 1, status: 'completed', route: 'skipImport', density: 'default', completedAt: 1_700_000_000_000 },
			finished: [1],
		});

		// Outside Meet Omni it is not offered, so it must not end the flow.
		const early = setup();
		early.session.chooseRoute('skipImport');
		await early.session.finishForNow();
		assert.deepStrictEqual({ stored: early.stored(), finished: early.finished }, { stored: undefined, finished: [] });
	});

	test('entering Meet Omni takes the Omni snapshot and seeds the density draft from it only once', async () => {
		const { session, omni, omniView, reachMeetOmni } = setup(undefined, { omniDensity: 'compact' });
		await reachMeetOmni();
		assert.deepStrictEqual(omniView(), { stage: 'meetOmni', busy: false, snapshot: 'compact', density: 'compact', error: undefined, announcement: 'Appearance choices loaded.' });

		// Back keeps the draft and writes nothing; coming forward again retakes the snapshot.
		assert.strictEqual(session.setDensity('default'), true);
		assert.strictEqual(session.back(), true);
		assert.deepStrictEqual([omniView().stage, omniView().density], ['appearance', 'default']);
		await timeout(0);
		await session.continueStage();
		assert.deepStrictEqual([omniView().stage, omniView().density, omniView().snapshot], ['meetOmni', 'default', 'compact']);
		assert.deepStrictEqual(omni.calls, [['snapshot'], ['snapshot']]);

		// The migrate route enters Meet Omni through acknowledged results and seeds the same way.
		const migrate = setup(undefined, { omniDensity: 'compact' });
		migrate.session.chooseRoute('migrate');
		migrate.migrations[0].publish({ phase: 'results', operation: { id: 'operation' } as EditorMigrationFlowState['operation'] });
		await migrate.session.acknowledgeMigration();
		assert.deepStrictEqual([migrate.omniView().stage, migrate.omniView().density], ['meetOmni', 'compact']);
	});

	test('resuming on Meet Omni prefers the recorded density over the snapshot', () => {
		const recorded = setup('{"version":1,"status":"inProgress","stage":"meetOmni","route":"migrate","density":"compact"}');
		const unrecorded = setup('{"version":1,"status":"inProgress","stage":"meetOmni","route":"migrate"}');
		const appearance = setup('{"version":1,"status":"inProgress","stage":"appearance","route":"skipImport","density":"compact"}');
		assert.deepStrictEqual({
			recorded: [recorded.omniView().stage, recorded.omniView().density, recorded.omniView().snapshot],
			unrecorded: [unrecorded.omniView().stage, unrecorded.omniView().density, unrecorded.omniView().snapshot],
			// A record left on appearance carries its staged density forward without a snapshot yet.
			appearance: [appearance.omniView().stage, appearance.omniView().density, appearance.omniView().snapshot],
		}, {
			recorded: ['meetOmni', 'compact', 'default'],
			unrecorded: ['meetOmni', 'default', 'default'],
			appearance: ['appearance', 'compact', undefined],
		});
	});

	test('setDensity stages the draft with its announcement, only on Meet Omni and not during a write', async () => {
		const { session, omni, omniView, reachMeetOmni } = setup(undefined, { manualOmni: true });
		assert.strictEqual(session.setDensity('compact'), false, 'nothing to stage before Meet Omni');
		await reachMeetOmni();

		assert.strictEqual(session.setDensity('compact'), true);
		assert.deepStrictEqual(omniView(), { stage: 'meetOmni', busy: false, snapshot: 'default', density: 'compact', error: undefined, announcement: 'Showing compact lists.' });
		const finishing = session.finishForNow();
		assert.strictEqual(session.setDensity('default'), false, 'the draft is frozen while it is being written');
		omni.resolveApply();
		await finishing;
		assert.strictEqual(session.setDensity('default'), false, 'the flow has finished');
	});

	test('each finish writes the density only where it differs, then records completion with it', async () => {
		const unchanged = setup();
		await unchanged.reachMeetOmni();
		await unchanged.session.finishForNow();

		const changed = setup();
		await changed.reachMeetOmni();
		changed.session.setDensity('compact');
		await changed.session.finishForNow();

		const project = setup(undefined, { omniDensity: 'compact' });
		await project.reachMeetOmni();
		project.session.setDensity('default');
		await project.session.addProject();

		const workbench = setup();
		await workbench.reachMeetOmni();
		await workbench.session.openFolderAsWorkbench();

		assert.deepStrictEqual({
			unchanged: [unchanged.omni.calls, JSON.parse(unchanged.stored()!).density],
			changed: [changed.omni.calls, JSON.parse(changed.stored()!).density],
			project: [project.omni.calls, JSON.parse(project.stored()!).density],
			workbench: [workbench.omni.calls, JSON.parse(workbench.stored()!).density],
		}, {
			unchanged: [[['snapshot'], ['finish']], 'default'],
			changed: [[['snapshot'], ['applyDensity', 'compact'], ['finish']], 'compact'],
			// The command runs only after the surface has finished, so its dialog is not under the modal.
			project: [[['snapshot'], ['applyDensity', 'default'], ['finish'], ['addProject']], 'default'],
			workbench: [[['snapshot'], ['finish'], ['openFolderAsWorkbench']], 'default'],
		});
	});

	test('a handoff waits for the density write, and a rejected command is not surfaced', async () => {
		const { session, omni, finished, stored, reachMeetOmni } = setup(undefined, { manualOmni: true, commandsFail: true });
		await reachMeetOmni();
		session.setDensity('compact');

		const handoff = session.addProject();
		await timeout(0);
		assert.deepStrictEqual({ finished, stored: stored(), busy: session.state.busy }, { finished: [], stored: undefined, busy: true }, 'nothing ends while the write is in flight');
		assert.strictEqual(await session.openFolderAsWorkbench(), undefined, 'a second finish is refused while busy');
		omni.resolveApply();
		await handoff;

		assert.deepStrictEqual({ finished, calls: omni.calls, error: session.state.error, status: JSON.parse(stored()!).status }, {
			finished: [1],
			calls: [['snapshot'], ['applyDensity', 'compact'], ['finish'], ['addProject']],
			error: undefined,
			status: 'completed',
		});
	});

	test('a failed density write stays on Meet Omni with its error and records nothing until a retry succeeds', async () => {
		const { session, omni, omniView, finished, stored, reachMeetOmni } = setup(undefined, { manualOmni: true });
		await reachMeetOmni();
		session.setDensity('compact');

		const first = session.finishForNow();
		omni.rejectApply(new Error('settings file is read-only'));
		await first;
		assert.deepStrictEqual({ view: omniView(), finished, stored: stored() }, {
			view: { stage: 'meetOmni', busy: false, snapshot: 'default', density: 'compact', error: 'settings file is read-only', announcement: 'settings file is read-only' },
			finished: [],
			stored: undefined,
		});

		const second = session.finishForNow();
		assert.strictEqual(omniView().error, undefined, 'a retry clears the error');
		omni.resolveApply();
		await second;
		assert.deepStrictEqual({ finished, density: JSON.parse(stored()!).density }, { finished: [1], density: 'compact' });
	});

	test('Back during a density write leaves for appearance and discards the write\'s result', async () => {
		const { session, omni, omniView, finished, stored, reachMeetOmni } = setup(undefined, { manualOmni: true });
		await reachMeetOmni();
		session.setDensity('compact');
		const finishing = session.finishForNow();

		assert.strictEqual(session.back(), true);
		omni.resolveApply();
		await finishing;

		assert.deepStrictEqual({ stage: omniView().stage, density: omniView().density, finished, stored: stored() }, { stage: 'appearance', density: 'compact', finished: [], stored: undefined });
	});

	test('dismissal records the staged density', async () => {
		const { session, stored, reachMeetOmni } = setup();
		await reachMeetOmni();
		session.setDensity('compact');

		session.recordDismissal();

		assert.deepStrictEqual(JSON.parse(stored()!), { version: 1, status: 'inProgress', stage: 'meetOmni', route: 'skipImport', density: 'compact' });
	});

	test('Finish for Now never rewrites a record a newer build owns, but still finishes', async () => {
		const newer = '{"version":2,"status":"completed"}';
		const { session, stored, finished, reachMeetOmni } = setup(newer);
		await reachMeetOmni();

		await session.finishForNow();

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
		const session = new OnboardingSession(new OnboardingStateStore(storage), () => migration as unknown as EditorMigrationFlowSession, new AppearanceStub(false), new OmniStub('default', false, false), new NullLogService());
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

	test('entering appearance loads the snapshot while busy and prefills the draft from it', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });

		session.chooseRoute('skipImport');
		assert.deepStrictEqual(appearanceView(), { stage: 'appearance', busy: true, loaded: false, draft: undefined, error: undefined, announcement: undefined });
		assert.deepStrictEqual(session.selectMode('light'), false, 'nothing is staged before the choices exist');
		await session.continueStage();
		assert.strictEqual(session.state.stage, 'appearance', 'Continue waits for the load');

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
		assert.deepStrictEqual(returned.appearance.calls.map(call => call[0]), ['snapshot', 'apply', 'snapshot']);
	});

	test('a snapshot that arrives after the stage was left cannot overwrite the newer state', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		const first = appearance.pendingSnapshot!;
		assert.strictEqual(session.back(), true);
		assert.deepStrictEqual(appearanceView(), { stage: 'bring', busy: false, loaded: false, draft: undefined, error: undefined, announcement: undefined });

		session.chooseRoute('skipImport');
		first.complete(snapshot());
		await timeout(0);
		assert.deepStrictEqual(appearanceView(), { stage: 'appearance', busy: true, loaded: false, draft: undefined, error: undefined, announcement: undefined }, 'the first load belongs to a stage that is gone');

		appearance.resolveSnapshot();
		await timeout(0);
		assert.deepStrictEqual([appearanceView().busy, appearanceView().loaded], [false, true]);
	});

	test('draft changes accept only offered ids and survive Back to bring', async () => {
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

		assert.strictEqual(session.back(), true);
		session.chooseRoute('skipImport');
		await timeout(0);
		assert.deepStrictEqual(appearanceView().draft, { mode: 'light', preferredLight: 'Quiet Light', preferredDark: 'Monokai' }, 'Back keeps the draft in memory');
		assert.deepStrictEqual(appearance.calls.filter(call => call[0] === 'apply'), [], 'Back writes nothing');
	});

	test('Continue applies the draft against its snapshot and moves to Meet Omni', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		appearance.resolveSnapshot();
		await timeout(0);
		session.selectMode('system');

		const continued = session.continueStage();
		assert.deepStrictEqual([appearanceView().stage, appearanceView().busy], ['appearance', true]);
		assert.deepStrictEqual(session.selectMode('dark'), false, 'nothing may change under a write in flight');
		appearance.resolveApply();
		await continued;

		assert.deepStrictEqual(appearance.calls, [['snapshot'], ['apply', snapshot(), { mode: 'system', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }]]);
		assert.deepStrictEqual(appearanceView(), { stage: 'meetOmni', busy: false, loaded: true, draft: { mode: 'system', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }, error: undefined, announcement: 'Appearance choices loaded.' });
	});

	test('a failed write stays on appearance with its error until a retry succeeds', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		appearance.resolveSnapshot();
		await timeout(0);
		session.selectMode('light');

		const first = session.continueStage();
		appearance.rejectApply(new Error('settings file is read-only'));
		await first;
		assert.deepStrictEqual(appearanceView(), { stage: 'appearance', busy: false, loaded: true, draft: { mode: 'light', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }, error: 'settings file is read-only', announcement: 'settings file is read-only' });

		const second = session.continueStage();
		assert.strictEqual(appearanceView().error, undefined, 'a retry clears the error');
		appearance.resolveApply();
		await second;
		assert.deepStrictEqual([appearanceView().stage, appearanceView().error], ['meetOmni', undefined]);
	});

	test('a failed snapshot leaves the stage passable and Continue writes nothing', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		appearance.rejectSnapshot(new Error('theme registry unavailable'));
		await timeout(0);
		assert.deepStrictEqual(appearanceView(), { stage: 'appearance', busy: false, loaded: false, draft: undefined, error: 'theme registry unavailable', announcement: 'theme registry unavailable' });

		await session.continueStage();

		assert.deepStrictEqual([appearanceView().stage, appearanceView().error], ['meetOmni', undefined]);
		assert.deepStrictEqual(appearance.calls, [['snapshot']]);
	});

	test('Back during a write leaves for bring and discards the write\'s result', async () => {
		const { session, appearance, appearanceView } = setup(undefined, { manualAppearance: true });
		session.chooseRoute('skipImport');
		appearance.resolveSnapshot();
		await timeout(0);
		const continued = session.continueStage();

		assert.strictEqual(session.back(), true);
		appearance.resolveApply();
		await continued;

		assert.deepStrictEqual([appearanceView().stage, appearanceView().busy], ['bring', false]);
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

	apply(current: OnboardingAppearanceSnapshot, draft: OnboardingAppearanceDraft): Promise<void> {
		this.calls.push(['apply', current, draft]);
		if (!this.manual) {
			return Promise.resolve();
		}
		this.pendingApply = new DeferredPromise();
		return this.pendingApply.p;
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
 * The snapshot is synchronous, as the real one is. Automatic mode answers every write at once;
 * manual mode leaves it pending until the test settles it. Commands record their call and either
 * resolve or, when the stub was built to fail them, reject.
 */
class OmniStub implements IOnboardingOmniAuthority {
	readonly calls: (readonly unknown[])[] = [];
	pendingApply: DeferredPromise<void> | undefined;

	constructor(private readonly density: OnboardingDensity, private readonly manual: boolean, private readonly commandsFail: boolean) { }

	snapshot(): OnboardingOmniSnapshot {
		this.calls.push(['snapshot']);
		return { density: this.density, shortcuts: [] };
	}

	applyDensity(density: OnboardingDensity): Promise<void> {
		this.calls.push(['applyDensity', density]);
		if (!this.manual) {
			return Promise.resolve();
		}
		this.pendingApply = new DeferredPromise();
		return this.pendingApply.p;
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

	resolveApply(): void {
		void this.pendingApply!.complete();
	}

	rejectApply(error: Error): void {
		void this.pendingApply!.error(error);
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
