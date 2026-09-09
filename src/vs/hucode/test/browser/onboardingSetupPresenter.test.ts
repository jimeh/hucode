/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../platform/storage/common/storage.js';
import { EditorMigrationFlowSession, EditorMigrationFlowState } from '../../browser/migration/editorMigrationFlow.js';
import { SetupWebviewIntentOutcome } from '../../browser/migration/editorMigrationSetupPresenter.js';
import { IOnboardingAppearanceAuthority, OnboardingAppearanceDraft, OnboardingAppearanceSnapshot } from '../../browser/onboarding/onboardingAppearance.js';
import { IOnboardingOmniAuthority, OnboardingOmniSnapshot } from '../../browser/onboarding/onboardingOmni.js';
import { OnboardingSession } from '../../browser/onboarding/onboardingSession.js';
import { OnboardingSetupPresenter } from '../../browser/onboarding/onboardingSetupPresenter.js';
import { OnboardingStateStore } from '../../browser/onboarding/onboardingStateStore.js';
import { EditorMigrationApplyProgress, EditorMigrationOperation } from '../../common/migration/editorMigrationApply.js';

suite('OnboardingSetupPresenter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const storage = disposables.add(new InMemoryStorageService());
		const migrations: MigrationStub[] = [];
		const appearance = new AppearanceStub();
		const omni = new OmniStub();
		const session = disposables.add(new OnboardingSession(new OnboardingStateStore(storage), () => {
			const migration = new MigrationStub();
			migrations.push(migration);
			return migration as unknown as EditorMigrationFlowSession;
		}, appearance, omni, new NullLogService()));
		session.initialize();
		const presenter = new OnboardingSetupPresenter(session);
		const migration = () => migrations[0];
		return { session, presenter, migration, appearance, omni };
	}

	test('drives the onboarding stages from its own intents and refuses migration intents outside them', async () => {
		const { session, presenter } = setup();
		const outcomes: Record<string, SetupWebviewIntentOutcome> = {};

		outcomes.migrationInBring = presenter.handleIntent({ type: 'startImport' }, true);
		outcomes.backInBring = presenter.handleIntent({ type: 'back' }, true);
		outcomes.staleRoute = presenter.handleIntent({ type: 'chooseRoute', route: 'skipImport' }, false);
		outcomes.route = presenter.handleIntent({ type: 'chooseRoute', route: 'skipImport' }, true);
		outcomes.continueWhileLoading = presenter.handleIntent({ type: 'continueStage' }, true);
		await timeout(0);
		outcomes.continue = presenter.handleIntent({ type: 'continueStage' }, true);
		await timeout(0);
		outcomes.migrationInMeetOmni = presenter.handleIntent({ type: 'acknowledge' }, true);
		outcomes.back = presenter.handleIntent({ type: 'back' }, true);
		outcomes.finishEarly = presenter.handleIntent({ type: 'finishForNow' }, true);
		assert.strictEqual(session.state.stage, 'appearance');
		await timeout(0);
		presenter.handleIntent({ type: 'continueStage' }, true);
		await timeout(0);
		outcomes.finish = presenter.handleIntent({ type: 'finishForNow' }, true);

		assert.deepStrictEqual(outcomes, {
			migrationInBring: 'superseded',
			backInBring: 'superseded',
			staleRoute: 'staleRevision',
			route: 'accepted',
			continueWhileLoading: 'superseded',
			continue: 'accepted',
			migrationInMeetOmni: 'superseded',
			back: 'accepted',
			finishEarly: 'superseded',
			finish: 'accepted',
		});
		assert.strictEqual(presenter.presentation(1).phase, 'meetOmni');
	});

	test('writes appearance choices as they are made and refuses ids the snapshot does not offer', async () => {
		const { session, presenter, appearance } = setup();
		presenter.handleIntent({ type: 'chooseRoute', route: 'skipImport' }, true);
		const whileLoading = presenter.handleIntent({ type: 'selectMode', mode: 'light' }, true);
		await timeout(0);

		assert.deepStrictEqual({
			whileLoading,
			mode: presenter.handleIntent({ type: 'selectMode', mode: 'light' }, true),
			staleMode: presenter.handleIntent({ type: 'selectMode', mode: 'dark' }, false),
			theme: presenter.handleIntent({ type: 'selectPreferredTheme', scheme: 'light', themeId: 'Quiet Light' }, true),
			wrongList: presenter.handleIntent({ type: 'selectPreferredTheme', scheme: 'light', themeId: 'Monokai' }, true),
			unknown: presenter.handleIntent({ type: 'selectPreferredTheme', scheme: 'dark', themeId: 'Nope' }, true),
			staleTheme: presenter.handleIntent({ type: 'selectPreferredTheme', scheme: 'dark', themeId: 'Monokai' }, false),
			draft: session.state.appearanceDraft,
		}, {
			whileLoading: 'superseded',
			mode: 'accepted',
			staleMode: 'staleRevision',
			theme: 'accepted',
			wrongList: 'unresolvable',
			unknown: 'unresolvable',
			staleTheme: 'staleRevision',
			draft: { mode: 'light', preferredLight: 'Quiet Light', preferredDark: 'Dark 2026' },
		});

		assert.strictEqual(presenter.handleIntent({ type: 'continueStage' }, true), 'accepted');
		await timeout(0);
		assert.deepStrictEqual(appearance.calls.map(call => call[0]), ['snapshot', 'apply'], 'the choices were written once, before Continue, which found nothing left');
		assert.strictEqual(presenter.presentation(2).phase, 'meetOmni');
	});

	test('hands each finish on Meet Omni to its own session method, once', async () => {
		const finish = async (type: 'finishForNow' | 'addProject' | 'openFolderAsWorkbench') => {
			const { session, presenter, omni } = setup();
			const outcomes: Record<string, SetupWebviewIntentOutcome> = {};
			outcomes.finishInBring = presenter.handleIntent({ type }, true);
			presenter.handleIntent({ type: 'chooseRoute', route: 'skipImport' }, true);
			await timeout(0);
			presenter.handleIntent({ type: 'continueStage' }, true);
			await timeout(0);
			assert.strictEqual(session.state.stage, 'meetOmni');
			outcomes.finish = presenter.handleIntent({ type }, true);
			// The stage still admits a duplicate press; the session's one-shot guard absorbs it,
			// which the single handoff call below shows.
			presenter.handleIntent({ type }, true);
			await timeout(0);
			return { outcomes, calls: omni.calls };
		};
		const expected = (command?: string) => ({
			outcomes: { finishInBring: 'superseded', finish: 'accepted' },
			calls: [['snapshot'], ...(command ? [[command]] : [])],
		});
		assert.deepStrictEqual({
			finishForNow: await finish('finishForNow'),
			addProject: await finish('addProject'),
			openFolderAsWorkbench: await finish('openFolderAsWorkbench'),
		}, {
			finishForNow: expected(),
			addProject: expected('addProject'),
			openFolderAsWorkbench: expected('openFolderAsWorkbench'),
		});
	});

	test('answers Back on the migrate route\'s Meet Omni as unresolvable, not as a stage move', async () => {
		const { session, presenter, migration } = setup();
		presenter.handleIntent({ type: 'chooseRoute', route: 'migrate' }, true);
		migration().publish({ phase: 'results', operation: concludedOperation() });
		presenter.handleIntent({ type: 'continueStage' }, true);
		await timeout(0);

		assert.strictEqual(session.state.stage, 'meetOmni');
		assert.strictEqual(presenter.handleIntent({ type: 'back' }, true), 'unresolvable');
		assert.strictEqual(session.state.stage, 'meetOmni');
	});

	test('forwards migration intents to an inner presenter over the embedded session', () => {
		const { presenter, migration } = setup();
		presenter.handleIntent({ type: 'chooseRoute', route: 'migrate' }, true);
		migration().publish({ phase: 'application', applications: [{ id: 'cursor', productName: 'Cursor', channel: 'stable', profiles: [] }] });

		assert.deepStrictEqual({
			select: presenter.handleIntent({ type: 'selectApplication', applicationId: 'cursor' }, true),
			unknown: presenter.handleIntent({ type: 'selectApplication', applicationId: 'zed' }, true),
			stale: presenter.handleIntent({ type: 'selectApplication', applicationId: 'cursor' }, false),
			refresh: presenter.handleIntent({ type: 'refreshDiscovery' }, false),
			// Onboarding's own intents are refused by the migration phase they arrive in.
			route: presenter.handleIntent({ type: 'chooseRoute', route: 'skipImport' }, true),
			skip: presenter.handleIntent({ type: 'skip' }, true),
			calls: migration().calls,
		}, {
			select: 'accepted',
			unknown: 'unresolvable',
			stale: 'staleRevision',
			refresh: 'accepted',
			route: 'superseded',
			skip: 'superseded',
			calls: [['initialize'], ['selectApplication', 'cursor'], ['refreshDiscovery']],
		});
		assert.deepStrictEqual(presenter.presentation(3).steps.map(step => [step.id, step.current]), [['bring', true], ['review', false], ['meetOmni', false]]);
		assert.strictEqual(presenter.presentation(3).panels[0].kind, 'applications');
	});

	test('intercepts Back before a source is chosen and hands it to the migration afterwards', () => {
		const { session, presenter, migration } = setup();
		presenter.handleIntent({ type: 'chooseRoute', route: 'migrate' }, true);
		const first = migration();
		first.publish({ phase: 'profile' });

		assert.strictEqual(presenter.handleIntent({ type: 'back' }, true), 'accepted');
		assert.deepStrictEqual(first.calls.at(-1), ['back'], 'a chosen source means the migration owns Back');
		assert.strictEqual(session.state.stage, 'migrate');

		first.publish({ phase: 'application' });
		assert.strictEqual(presenter.handleIntent({ type: 'back' }, false), 'staleRevision', 'onboarding\'s Back is revision bound like every other Back');
		assert.strictEqual(presenter.handleIntent({ type: 'back' }, true), 'accepted');
		assert.strictEqual(session.state.stage, 'bring');
		assert.strictEqual(first.disposed, true);
		assert.strictEqual(first.calls.filter(call => call[0] === 'back').length, 1, 'the migration session is not asked to go back to bring');
	});

	test('admits Continue on concluded results only, and never lets acknowledgement reach the migration', async () => {
		const { session, presenter, migration } = setup();
		presenter.handleIntent({ type: 'chooseRoute', route: 'migrate' }, true);
		const first = migration();
		const outcomes: Record<string, SetupWebviewIntentOutcome> = {};

		first.publish({ phase: 'apply', busy: true });
		outcomes.apply = presenter.handleIntent({ type: 'continueStage' }, true);
		first.publish({ phase: 'results', busy: false });
		outcomes.noOperation = presenter.handleIntent({ type: 'continueStage' }, true);
		first.publish({ operation: { ...concludedOperation(), stage: 'admitted', aggregateOutcome: undefined } });
		outcomes.admitted = presenter.handleIntent({ type: 'continueStage' }, true);
		first.publish({ operation: concludedOperation(), busy: true });
		outcomes.busy = presenter.handleIntent({ type: 'continueStage' }, true);
		first.publish({ busy: false, canceling: true });
		outcomes.canceling = presenter.handleIntent({ type: 'continueStage' }, true);
		first.publish({ canceling: false });
		outcomes.acknowledge = presenter.handleIntent({ type: 'acknowledge' }, true);
		assert.strictEqual(session.state.stage, 'migrate');
		outcomes.continue = presenter.handleIntent({ type: 'continueStage' }, true);
		await timeout(0);

		assert.deepStrictEqual(outcomes, {
			apply: 'superseded',
			noOperation: 'unresolvable',
			admitted: 'unresolvable',
			busy: 'superseded',
			canceling: 'unresolvable',
			acknowledge: 'unresolvable',
			continue: 'accepted',
		});
		assert.deepStrictEqual(first.calls.filter(call => call[0] === 'acknowledge'), [], 'the recovery data stays in the journal');
		assert.strictEqual(first.disposed, true);
		assert.strictEqual(session.state.stage, 'meetOmni');
		assert.strictEqual(presenter.presentation(9).phase, 'meetOmni');
	});

	test('coalesces only the embedded migration\'s progress stream', () => {
		const { presenter, migration } = setup();
		assert.strictEqual(presenter.isPendingChangeCoalescable(), false);
		presenter.handleIntent({ type: 'chooseRoute', route: 'migrate' }, true);
		migration().publish({ phase: 'apply', progress: progress('applying', 1) });
		presenter.presentation(1);

		migration().publish({ progress: progress('applying', 2) });
		assert.strictEqual(presenter.isPendingChangeCoalescable(), true, 'progress-only migration changes may wait a frame');
		presenter.presentation(2);
		migration().publish({ phase: 'results' });
		assert.strictEqual(presenter.isPendingChangeCoalescable(), false, 'a phase boundary crosses at once');
	});
});

class AppearanceStub implements IOnboardingAppearanceAuthority {
	readonly calls: (readonly unknown[])[] = [];

	async snapshot(): Promise<OnboardingAppearanceSnapshot> {
		this.calls.push(['snapshot']);
		return {
			mode: 'dark',
			colorTheme: 'Dark 2026',
			preferredLight: 'Light 2026',
			preferredDark: 'Dark 2026',
			lightThemes: [{ id: 'Light 2026', label: 'Light 2026' }, { id: 'Quiet Light', label: 'Quiet Light' }],
			darkThemes: [{ id: 'Dark 2026', label: 'Dark 2026' }, { id: 'Monokai', label: 'Monokai' }],
		};
	}

	async apply(current: OnboardingAppearanceSnapshot, draft: OnboardingAppearanceDraft): Promise<OnboardingAppearanceSnapshot> {
		this.calls.push(['apply', current, draft]);
		return { ...current, ...draft };
	}
}

class OmniStub implements IOnboardingOmniAuthority {
	readonly calls: (readonly unknown[])[] = [];

	snapshot(): OnboardingOmniSnapshot {
		this.calls.push(['snapshot']);
		return { shortcuts: [] };
	}

	async addProject(): Promise<void> {
		this.calls.push(['addProject']);
	}

	async openFolderAsWorkbench(): Promise<void> {
		this.calls.push(['openFolderAsWorkbench']);
	}
}

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

	async acknowledge(): Promise<void> {
		this.calls.push(['acknowledge']);
	}

	selectApplication(applicationId: string): void {
		this.calls.push(['selectApplication', applicationId]);
	}

	async refreshDiscovery(): Promise<void> {
		this.calls.push(['refreshDiscovery']);
	}

	back(): void {
		this.calls.push(['back']);
	}

	requestCancellation(): void {
		this.calls.push(['requestCancellation']);
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}

/** The least of a settled operation the presenter and session read: its stage and outcome. */
function concludedOperation(): EditorMigrationOperation {
	return { id: 'operation', stage: 'settled', aggregateOutcome: 'completed', target: { state: 'attached', profileId: 'imported' } } as EditorMigrationOperation;
}

function progress(stage: EditorMigrationApplyProgress['stage'], recorded: number): EditorMigrationApplyProgress {
	return {
		operationId: 'operation',
		revision: recorded,
		stage,
		target: { profileId: 'work', name: 'Work' },
		selectedItemCount: 10,
		results: Array.from({ length: recorded }, (_, index) => ({ id: `item-${index}`, category: 'settings' as const, outcome: 'completed' as const, attempts: 1 })),
		cancellationRequested: false,
	} as unknown as EditorMigrationApplyProgress;
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
