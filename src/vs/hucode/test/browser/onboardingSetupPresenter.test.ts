/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../platform/storage/common/storage.js';
import { EditorMigrationFlowSession, EditorMigrationFlowState } from '../../browser/migration/editorMigrationFlow.js';
import { SetupWebviewIntentOutcome } from '../../browser/migration/editorMigrationSetupPresenter.js';
import { OnboardingSession } from '../../browser/onboarding/onboardingSession.js';
import { OnboardingSetupPresenter } from '../../browser/onboarding/onboardingSetupPresenter.js';
import { OnboardingStateStore } from '../../browser/onboarding/onboardingStateStore.js';
import { EditorMigrationApplyProgress } from '../../common/migration/editorMigrationApply.js';

suite('OnboardingSetupPresenter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const storage = disposables.add(new InMemoryStorageService());
		const migrations: MigrationStub[] = [];
		const session = disposables.add(new OnboardingSession(new OnboardingStateStore(storage), () => {
			const migration = new MigrationStub();
			migrations.push(migration);
			return migration as unknown as EditorMigrationFlowSession;
		}));
		session.initialize();
		const presenter = new OnboardingSetupPresenter(session);
		const migration = () => migrations[0];
		return { session, presenter, migration };
	}

	test('drives the onboarding stages from its own intents and refuses migration intents outside them', () => {
		const { session, presenter } = setup();
		const outcomes: Record<string, SetupWebviewIntentOutcome> = {};

		outcomes.migrationInBring = presenter.handleIntent({ type: 'startImport' }, true);
		outcomes.backInBring = presenter.handleIntent({ type: 'back' }, true);
		outcomes.staleRoute = presenter.handleIntent({ type: 'chooseRoute', route: 'skipImport' }, false);
		outcomes.route = presenter.handleIntent({ type: 'chooseRoute', route: 'skipImport' }, true);
		outcomes.continue = presenter.handleIntent({ type: 'continueStage' }, true);
		outcomes.migrationInMeetOmni = presenter.handleIntent({ type: 'acknowledge' }, true);
		outcomes.back = presenter.handleIntent({ type: 'back' }, true);
		outcomes.finishEarly = presenter.handleIntent({ type: 'finishForNow' }, true);
		assert.strictEqual(session.state.stage, 'appearance');
		presenter.handleIntent({ type: 'continueStage' }, true);
		outcomes.finish = presenter.handleIntent({ type: 'finishForNow' }, true);

		assert.deepStrictEqual(outcomes, {
			migrationInBring: 'superseded',
			backInBring: 'superseded',
			staleRoute: 'staleRevision',
			route: 'accepted',
			continue: 'accepted',
			migrationInMeetOmni: 'superseded',
			back: 'accepted',
			finishEarly: 'superseded',
			finish: 'accepted',
		});
		assert.strictEqual(presenter.presentation(1).phase, 'meetOmni');
	});

	test('answers Back on the migrate route\'s Meet Omni as unresolvable, not as a stage move', async () => {
		const { session, presenter, migration } = setup();
		presenter.handleIntent({ type: 'chooseRoute', route: 'migrate' }, true);
		migration().publish({ phase: 'results', operation: { id: 'operation' } as EditorMigrationFlowState['operation'] });
		presenter.handleIntent({ type: 'acknowledge' }, true);
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

	test('intercepts acknowledgement so the flow moves on instead of restarting discovery', async () => {
		const { session, presenter, migration } = setup();
		presenter.handleIntent({ type: 'chooseRoute', route: 'migrate' }, true);
		const first = migration();
		first.publish({ phase: 'apply', busy: true });
		assert.strictEqual(presenter.handleIntent({ type: 'acknowledge' }, true), 'superseded', 'acknowledgement is never legal outside Results');

		first.publish({ phase: 'results', busy: false });
		assert.strictEqual(presenter.handleIntent({ type: 'acknowledge' }, true), 'unresolvable', 'Results without an operation offers nothing to acknowledge');

		first.publish({ operation: { id: 'operation' } as EditorMigrationFlowState['operation'] });
		assert.strictEqual(presenter.handleIntent({ type: 'acknowledge' }, true), 'accepted');
		await timeout(0);
		assert.deepStrictEqual(first.calls.filter(call => call[0] === 'acknowledge'), [['acknowledge', false]]);
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

	async acknowledge(restart = true): Promise<boolean> {
		this.calls.push(['acknowledge', restart]);
		return true;
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
