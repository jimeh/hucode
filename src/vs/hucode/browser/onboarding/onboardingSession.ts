/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { EditorMigrationFlowPhase, EditorMigrationFlowSession, IEditorMigrationFlowService } from '../migration/editorMigrationFlow.js';
import { shouldCancelEditorMigrationOnClose } from '../migration/editorMigrationSetupClose.js';
import { ONBOARDING_RECORD_VERSION, OnboardingRecordRoute, OnboardingStateStore, OnboardingStoredState } from './onboardingStateStore.js';

/**
 * Stages the session presents.
 *
 * `migrate` wraps an embedded `EditorMigrationFlowSession`; the other three are onboarding's own
 * screens. The record type names the same four stages.
 */
export type OnboardingStage = 'bring' | 'migrate' | 'appearance' | 'meetOmni';

export type OnboardingRoute = OnboardingRecordRoute;

/**
 * `first` is a fresh or resumable run. `rerun` means onboarding was already completed, skipped, or
 * recorded by a newer build, so reopening it must change nothing on its own.
 */
export type OnboardingMode = 'first' | 'rerun';

/**
 * What an earlier run left behind, shown by the `bring` stage in rerun mode.
 *
 * Acknowledged migration operations leave the durable journal, so the record is the only source
 * for this summary. A record a newer build owns reports `superseded` and nothing else.
 */
export interface OnboardingPreviousOutcome {
	readonly status: 'completed' | 'skipped' | 'superseded';
	readonly route?: OnboardingRoute;
	readonly completedAt?: number;
}

/** Immutable state the presentation mapper draws from. */
export interface OnboardingSessionState {
	readonly stage: OnboardingStage;
	readonly busy: boolean;
	readonly mode: OnboardingMode;
	/** Set once the user has left `bring` by one of its two choices. */
	readonly route?: OnboardingRoute;
	readonly previous?: OnboardingPreviousOutcome;
	readonly announcement?: string;
}

const FIRST_STAGE: OnboardingStage = 'bring';

/**
 * Migration phases before any source is chosen.
 *
 * Only here may Back leave the embedded migration for `bring`, and only here does the flow hold
 * nothing the user has decided; a later phase's Back belongs to the migration session.
 */
const MIGRATION_PHASES_BEFORE_SOURCE: ReadonlySet<EditorMigrationFlowPhase> = new Set<EditorMigrationFlowPhase>(['loading', 'recovery', 'application']);

/** True when onboarding, not the migration session, answers Back in this embedded phase. */
export function onboardingOwnsMigrationBack(phase: EditorMigrationFlowPhase): boolean {
	return MIGRATION_PHASES_BEFORE_SOURCE.has(phase);
}

/**
 * Maps a stored record onto the stage and route a reopened session lands on.
 *
 * Only `inProgress` resumes. `appearance` implies the Skip Import route; `meetOmni` restores the
 * route it was reached by. A record at `migrate` cannot restore a live migration session, so it
 * lands on `bring`: an operation that was admitted before the dismissal is still in the durable
 * journal, and choosing Import again surfaces it through the migration flow's own `recovery`
 * phase. Anything else, including no stage at all, lands on the first stage rather than failing
 * to open.
 */
export function onboardingResumePosition(stored: OnboardingStoredState): { readonly stage: OnboardingStage; readonly route?: OnboardingRoute } {
	if (stored.kind !== 'record' || stored.record.status !== 'inProgress') {
		return { stage: FIRST_STAGE };
	}
	const { stage, route } = stored.record;
	if (stage === 'appearance') {
		return { stage, route: 'skipImport' };
	}
	if (stage === 'meetOmni' && route !== undefined) {
		return { stage, route };
	}
	return { stage: FIRST_STAGE };
}

/** Whether a stored record means onboarding already ran to an end, or was written by a newer build. */
export function onboardingModeFor(stored: OnboardingStoredState): OnboardingMode {
	if (stored.kind === 'superseded') {
		return 'rerun';
	}
	return stored.record.status === 'completed' || stored.record.status === 'skipped' ? 'rerun' : 'first';
}

function onboardingPreviousOutcome(stored: OnboardingStoredState): OnboardingPreviousOutcome | undefined {
	if (stored.kind === 'superseded') {
		return { status: 'superseded' };
	}
	const { status, route, completedAt } = stored.record;
	if (status !== 'completed' && status !== 'skipped') {
		return undefined;
	}
	return { status, route, completedAt };
}

/**
 * Host-neutral onboarding state machine.
 *
 * One session lives for exactly one open of the onboarding surface. It owns stage navigation, the
 * durable record, and, on the Import route, the embedded migration session; the modal input owns
 * the session's lifetime.
 */
export class OnboardingSession extends Disposable {
	private readonly _onDidChangeState = this._register(new Emitter<OnboardingSessionState>());
	readonly onDidChangeState: Event<OnboardingSessionState> = this._onDidChangeState.event;

	private readonly _onDidFinish = this._register(new Emitter<void>());
	/** Fires once, when the user ends the flow and the surface hosting it should close. */
	readonly onDidFinish: Event<void> = this._onDidFinish.event;

	private _state: OnboardingSessionState = Object.freeze({ stage: FIRST_STAGE, busy: false, mode: 'first' as const });
	private stored: OnboardingStoredState | undefined;
	private finished = false;
	/** The embedded migration session and its state subscription, alive only on the Import route. */
	private readonly migrationLifetime = this._register(new MutableDisposable<DisposableStore>());
	private _migration: EditorMigrationFlowSession | undefined;

	constructor(
		private readonly store: OnboardingStateStore,
		private readonly createMigrationSession: () => EditorMigrationFlowSession,
		private readonly now: () => number = Date.now,
	) {
		super();
	}

	get state(): OnboardingSessionState {
		return this._state;
	}

	/** The embedded migration session while the `migrate` stage is active. */
	get migration(): EditorMigrationFlowSession | undefined {
		return this._migration;
	}

	/** Loads the record and lands on the stage it names. */
	initialize(): void {
		this.stored = this.store.read();
		const position = onboardingResumePosition(this.stored);
		this.setState({
			stage: position.stage,
			route: position.route,
			busy: false,
			mode: onboardingModeFor(this.stored),
			previous: onboardingPreviousOutcome(this.stored),
		});
	}

	/**
	 * Leaves `bring` by one of its two choices.
	 *
	 * Import creates the embedded migration session and starts its discovery; that session's
	 * state changes are re-announced as this session's so the host re-reads. Skip Import creates
	 * nothing and opens the appearance stage.
	 */
	chooseRoute(route: OnboardingRoute): void {
		if (this.finished || this._state.stage !== 'bring') {
			return;
		}
		if (route === 'skipImport') {
			this.setState({ ...this._state, stage: 'appearance', route });
			return;
		}
		const migration = this.createMigrationSession();
		const lifetime = new DisposableStore();
		lifetime.add(migration);
		lifetime.add(migration.onDidChangeState(() => this._onDidChangeState.fire(this._state)));
		this.migrationLifetime.value = lifetime;
		this._migration = migration;
		this.setState({ ...this._state, stage: 'migrate', route });
		void migration.initialize();
	}

	/**
	 * Moves one stage back. Returns false where the current stage offers no Back.
	 *
	 * Out of the embedded migration, Back is onboarding's only while no source has been chosen;
	 * it disposes the migration session and clears the route, which is what makes a later Import
	 * start over. Later migration phases hand Back to the migration session instead. From
	 * `meetOmni` on the Import route there is nowhere to go: the results were acknowledged and the
	 * operation is gone.
	 */
	back(): boolean {
		if (this.finished) {
			return false;
		}
		switch (this._state.stage) {
			case 'migrate': {
				if (!this._migration || !onboardingOwnsMigrationBack(this._migration.state.phase)) {
					return false;
				}
				this.disposeMigration();
				this.setState({ ...this._state, stage: 'bring', route: undefined });
				return true;
			}
			case 'appearance':
				this.setState({ ...this._state, stage: 'bring', route: undefined });
				return true;
			case 'meetOmni':
				if (this._state.route !== 'skipImport') {
					return false;
				}
				this.setState({ ...this._state, stage: 'appearance' });
				return true;
			case 'bring':
				return false;
		}
	}

	/** Continue from `appearance`. The stage's writes arrive with its content in a later step. */
	continueStage(): void {
		if (this.finished || this._state.stage !== 'appearance') {
			return;
		}
		this.setState({ ...this._state, stage: 'meetOmni' });
	}

	/**
	 * Acknowledges the embedded migration's results and moves on to Meet Omni.
	 *
	 * The migration session deletes the recovery data without restarting discovery, which is what
	 * its standalone Results screen would do next. Only a confirmed deletion moves the stage: a
	 * failure stays on Results with the migration flow's own error, and a duplicate press is
	 * absorbed by the migration session's one-shot guard.
	 */
	async acknowledgeMigration(): Promise<void> {
		const migration = this._migration;
		if (this.finished || this._state.stage !== 'migrate' || !migration) {
			return;
		}
		const acknowledged = await migration.acknowledge(false);
		if (!acknowledged || this.finished || this._migration !== migration) {
			return;
		}
		this.disposeMigration();
		this.setState({ ...this._state, stage: 'meetOmni' });
	}

	/**
	 * Ends onboarding from Meet Omni and records the installation as completed.
	 *
	 * A record a newer build owns is never rewritten; the surface still finishes.
	 */
	finishForNow(): void {
		if (this.finished || this._state.stage !== 'meetOmni') {
			return;
		}
		this.finished = true;
		if (this.stored?.kind === 'record') {
			this.store.write({ version: ONBOARDING_RECORD_VERSION, status: 'completed', route: this._state.route, completedAt: this.now() });
		}
		this.disposeMigration();
		this._onDidFinish.fire();
	}

	/**
	 * Ends onboarding without going through it.
	 *
	 * Recorded as `skipped` unless a newer build owns the record or the installation already
	 * completed onboarding; a completed record, with its `completedAt`, must survive being reopened
	 * and skipped. The surface finishes in every case.
	 */
	skip(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		if (this.stored?.kind === 'record' && this.stored.record.status !== 'completed') {
			this.store.write({ version: ONBOARDING_RECORD_VERSION, status: 'skipped' });
		}
		this.disposeMigration();
		this._onDidFinish.fire();
	}

	/**
	 * Records the current stage as resumable when the surface is dismissed.
	 *
	 * Escape, an outside click, the close button, and Do This Later all end here. An admitted
	 * Apply is asked to cancel first, exactly as closing the standalone import command does; the
	 * operation continues to its next durable checkpoint on its own, so the migration session can
	 * be disposed with the input afterwards. Nothing is written once the flow has finished, when a
	 * newer build owns the record, or in rerun mode, where a completed or skipped record must
	 * survive being looked at again.
	 */
	recordDismissal(): void {
		if (this._migration && shouldCancelEditorMigrationOnClose(this._migration.state)) {
			this._migration.requestCancellation();
		}
		if (this.finished || !this.stored || this.stored.kind === 'superseded' || this._state.mode === 'rerun') {
			return;
		}
		this.store.write({ version: ONBOARDING_RECORD_VERSION, status: 'inProgress', stage: this._state.stage, route: this._state.route });
	}

	private disposeMigration(): void {
		this._migration = undefined;
		this.migrationLifetime.clear();
	}

	private setState(next: OnboardingSessionState): void {
		this._state = Object.freeze({ ...next });
		this._onDidChangeState.fire(this._state);
	}
}

/**
 * Records a dismissal when the onboarding surface is genuinely closed.
 *
 * The signal has to be the editor input's own disposal, not the pane's `clearInput`, which also
 * fires when the singleton input is merely hidden and later reshown.
 */
export function bindOnboardingDismissal(session: Pick<OnboardingSession, 'recordDismissal'>, onWillClose: Event<void>): IDisposable {
	const listener = onWillClose(() => session.recordDismissal());
	return toDisposable(() => listener.dispose());
}

export const IOnboardingService = createDecorator<IOnboardingService>('hucodeOnboardingService');

/** Creates onboarding sessions. Each open of the surface owns exactly one. */
export interface IOnboardingService {
	readonly _serviceBrand: undefined;
	createSession(): OnboardingSession;
}

class OnboardingService implements IOnboardingService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IEditorMigrationFlowService private readonly migrationFlowService: IEditorMigrationFlowService,
	) { }

	createSession(): OnboardingSession {
		return new OnboardingSession(new OnboardingStateStore(this.storageService), () => this.migrationFlowService.createSession());
	}
}

registerSingleton(IOnboardingService, OnboardingService, InstantiationType.Delayed);
