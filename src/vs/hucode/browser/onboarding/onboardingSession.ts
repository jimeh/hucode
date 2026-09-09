/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { isWeb } from '../../../base/common/platform.js';
import { IHucodeShellControllerService } from '../../../platform/window/common/hucodeShellControllerService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { editorMigrationOperationConcluded } from '../../common/migration/editorMigrationApply.js';
import { EditorMigrationFlowPhase, EditorMigrationFlowSession, EditorMigrationFlowState, IEditorMigrationFlowService } from '../migration/editorMigrationFlow.js';
import { shouldCancelEditorMigrationOnClose } from '../migration/editorMigrationSetupClose.js';
import {
	IOnboardingAppearanceAuthority,
	OnboardingAppearanceAuthority,
	OnboardingAppearanceDraft,
	OnboardingAppearanceMode,
	OnboardingAppearanceSnapshot,
	OnboardingColorScheme,
	isOnboardingAppearanceApplied,
	onboardingThemesFor,
} from './onboardingAppearance.js';
import { IOnboardingOmniAuthority, OnboardingOmniAuthority, OnboardingOmniSnapshot } from './onboardingOmni.js';
import { ONBOARDING_RECORD_VERSION, OnboardingRecord, OnboardingRecordRoute, OnboardingStateStore, OnboardingStoredState } from './onboardingStateStore.js';

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
	readonly handoffProfileId?: string;
	readonly importHadIssues?: boolean;
	readonly previous?: OnboardingPreviousOutcome;
	readonly announcement?: string;
	/** The last failed load or write, shown on the stage it belongs to until the next attempt. */
	readonly error?: string;
	/**
	 * The appearance stage's themes and the values as last read or written, present once its
	 * load succeeded. Absent while the stage is loading, after a failed load, and outside the
	 * Skip Import route.
	 */
	readonly appearance?: OnboardingAppearanceSnapshot;
	/**
	 * The user's appearance choices. Each is written as it is made; a choice whose write failed
	 * stays here, ahead of the snapshot, until a later write or Continue lands it. They outlive
	 * Back to `bring` for the session's lifetime.
	 */
	readonly appearanceDraft?: OnboardingAppearanceDraft;
	/** The shortcuts Meet Omni mentions, taken whenever the stage is entered. */
	readonly omni?: OnboardingOmniSnapshot;
}

const FIRST_STAGE: OnboardingStage = 'bring';

/** How long a handoff waits for the surface to close before running anyway. */
const SURFACE_CLOSE_TIMEOUT = 5_000;

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
 * True when the embedded migration's Results may be left for Meet Omni.
 *
 * The condition is the standalone Results screen's for offering Done: the operation has a final
 * outcome and the session is neither working nor canceling. Leaving acknowledges nothing, so the
 * rollback snapshots and recovery data stay in the journal exactly as Done leaves them, reachable
 * later through the import command.
 */
export function onboardingMigrationCanContinue(state: EditorMigrationFlowState): boolean {
	return state.phase === 'results' && !state.busy && !state.canceling && state.operation !== undefined && editorMigrationOperationConcluded(state.operation);
}

/**
 * Maps a stored record onto the stage and route a reopened session lands on.
 *
 * Only `inProgress` resumes. `appearance` implies the Skip Import route; `meetOmni` restores the
 * route it was reached by. A record at `migrate` resumes the migration flow directly, where an
 * admitted operation is surfaced through its durable journal and explicit `recovery` phase.
 * Anything else, including no stage at all, lands on the first stage rather than failing to open.
 */
export function onboardingResumePosition(stored: OnboardingStoredState): { readonly stage: OnboardingStage; readonly route?: OnboardingRoute } {
	if (stored.kind !== 'record' || stored.record.status !== 'inProgress') {
		return { stage: FIRST_STAGE };
	}
	const { stage, route } = stored.record;
	if (stage === 'migrate') {
		return { stage, route: 'migrate' };
	}
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
	private checkpointPending = false;
	/** The embedded migration session and its state subscription, alive only on the Import route. */
	private readonly migrationLifetime = this._register(new MutableDisposable<DisposableStore>());
	private _migration: EditorMigrationFlowSession | undefined;
	/**
	 * Advanced by every stage change, appearance load, and Continue, so an asynchronous result
	 * may only land on the state it was started from.
	 */
	private generation = 0;
	/**
	 * Appearance writes run one after another in the order the choices were made. Each diffs the
	 * current draft against the current snapshot when its turn comes, so choices made during a
	 * write are carried by the next one and a write that failed is retried by it.
	 */
	private appearanceWrites: Promise<void> = Promise.resolve();
	/** Settles when the bound surface closes; absent until a surface is bound. */
	private surfaceClosed: Promise<void> | undefined;

	constructor(
		private readonly store: OnboardingStateStore,
		private readonly createMigrationSession: () => EditorMigrationFlowSession,
		private readonly appearance: IOnboardingAppearanceAuthority,
		private readonly omni: IOnboardingOmniAuthority,
		private readonly logService: ILogService,
		private readonly now: () => number = Date.now,
		private readonly surfaceCloseTimeout: number = SURFACE_CLOSE_TIMEOUT,
	) {
		super();
	}

	/**
	 * Binds the surface showing this session, for the session's lifetime or until disposed.
	 *
	 * The signal has to be the editor input's own disposal, not the pane's `clearInput`, which
	 * also fires when the singleton input is merely hidden and later reshown. Closing records the
	 * dismissal, and a handoff chosen on Meet Omni waits for it so the command's dialog opens
	 * over the shell rather than under the modal.
	 */
	bindSurface(onWillClose: Event<void>): IDisposable {
		const closed = new DeferredPromise<void>();
		this.surfaceClosed = closed.p;
		const listener = onWillClose(() => {
			this.recordDismissal();
			closed.complete();
		});
		return toDisposable(() => {
			listener.dispose();
			// An unbound surface can no longer close; a handoff waiting for it must not hang.
			closed.complete();
		});
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
		const stored = this.store.readAccepted();
		if (stored instanceof Promise) {
			this.setState({ ...this._state, busy: true, error: undefined });
			void stored.then(value => this.initializeFrom(value), error => this.checkpointFailed(error));
		} else {
			this.initializeFrom(stored);
		}
	}

	private initializeFrom(stored: OnboardingStoredState): void {
		if (this.finished || this._store.isDisposed) { return; }
		this.stored = stored;
		const position = onboardingResumePosition(stored);
		const state: OnboardingSessionState = {
			stage: position.stage,
			route: position.route,
			handoffProfileId: stored.kind === 'record' && stored.record.status === 'inProgress' ? stored.record.handoffProfileId : undefined,
			importHadIssues: stored.kind === 'record' && stored.record.status === 'inProgress' && position.stage === 'meetOmni' && position.route === 'migrate' ? stored.record.importHadIssues : undefined,
			busy: false,
			mode: onboardingModeFor(stored),
			previous: onboardingPreviousOutcome(stored),
			omni: position.stage === 'meetOmni' ? this.omni.snapshot() : undefined,
		};
		if (stored.kind === 'record' && stored.origin !== 'malformed' && stored.record.status === 'notStarted') {
			void this.commitStage(state);
			return;
		}
		this.setState(state);
		if (position.stage === 'migrate') { this.startMigration(); }
		if (position.stage === 'appearance') { void this.loadAppearance(); }
	}

	/**
	 * Leaves `bring` by one of its two choices.
	 *
	 * Import creates the embedded migration session and starts its discovery; that session's
	 * state changes are re-announced as this session's so the host re-reads. Skip Import creates
	 * nothing and opens the appearance stage.
	 */
	chooseRoute(route: OnboardingRoute): void {
		if (this.finished || this._state.busy || this._state.stage !== 'bring') {
			return;
		}
		if (!this.stored) { this.initialize(); return; }
		if (route === 'skipImport') {
			void this.commitStage({ ...this._state, stage: 'appearance', route, handoffProfileId: undefined, importHadIssues: undefined }, () => { void this.loadAppearance(); });
			return;
		}
		void this.commitStage({ ...this._state, stage: 'migrate', route, handoffProfileId: undefined, importHadIssues: undefined }, () => this.startMigration());
	}

	private startMigration(): void {
		const migration = this.createMigrationSession();
		const lifetime = new DisposableStore();
		lifetime.add(migration);
		lifetime.add(migration.onDidChangeState(() => this._onDidChangeState.fire(this._state)));
		this.migrationLifetime.value = lifetime;
		this._migration = migration;
		void migration.initialize();
	}

	/**
	 * Moves one stage back. Returns false where the current stage offers no Back.
	 *
	 * Out of the embedded migration, Back is onboarding's only while no source has been chosen;
	 * it disposes the migration session and clears the route, which is what makes a later Import
	 * start over. Later migration phases hand Back to the migration session instead. From
	 * `meetOmni` on the Import route there is nowhere to go: the migration session that showed
	 * the results is gone.
	 */
	back(): boolean {
		if (this.finished || this.checkpointPending) {
			return false;
		}
		switch (this._state.stage) {
			case 'migrate': {
				if (!this._migration || !onboardingOwnsMigrationBack(this._migration.state.phase)) {
					return false;
				}
				void this.commitStage({ ...this._state, stage: 'bring', route: undefined, handoffProfileId: undefined, importHadIssues: undefined }, () => this.disposeMigration());
				return true;
			}
			case 'appearance':
				// Choices already written stay written. The draft stays in memory; a write in flight
				// lands or fails on its own and its result is discarded, because the snapshot it
				// diffed against is replaced when the stage is entered again.
				void this.commitStage({ ...this._state, stage: 'bring', route: undefined, importHadIssues: undefined, busy: false, error: undefined });
				return true;
			case 'meetOmni':
				if (this._state.route !== 'skipImport') {
					return false;
				}
				void this.commitStage({ ...this._state, stage: 'appearance' }, () => { void this.loadAppearance(); });
				return true;
			case 'bring':
				return false;
		}
	}

	/**
	 * Loads the themes and current values for the appearance stage.
	 *
	 * An existing draft is kept where its ids are still offered, so Back to `bring` and forward
	 * again shows what the user chose; anything no longer installed falls back to the current
	 * value. A failed load leaves the stage without choices but still passable: Continue then
	 * writes nothing.
	 */
	private async loadAppearance(): Promise<void> {
		const generation = ++this.generation;
		this.setState({ ...this._state, busy: true, error: undefined, announcement: undefined, appearance: undefined });
		let snapshot: OnboardingAppearanceSnapshot;
		try {
			// A write still in flight from before Back lands in the configuration after this
			// point; reading first would prefill from values it is about to replace.
			await this.appearanceWrites;
			snapshot = await this.appearance.snapshot();
		} catch (error) {
			if (this.isCurrent(generation)) {
				this.logService.error(error instanceof Error ? error : String(error));
				const message = errorMessage(error);
				this.setState({ ...this._state, busy: false, error: message, announcement: message });
			}
			return;
		}
		if (!this.isCurrent(generation)) {
			return;
		}
		const previous = this._state.appearanceDraft;
		const offered = (scheme: OnboardingColorScheme, id: string | undefined) => id !== undefined && onboardingThemesFor(snapshot, scheme).some(theme => theme.id === id);
		const draft: OnboardingAppearanceDraft = {
			mode: previous?.mode ?? snapshot.mode,
			preferredLight: offered('light', previous?.preferredLight) ? previous!.preferredLight : snapshot.preferredLight,
			preferredDark: offered('dark', previous?.preferredDark) ? previous!.preferredDark : snapshot.preferredDark,
		};
		this.setState({
			...this._state,
			busy: false,
			appearance: snapshot,
			appearanceDraft: draft,
			announcement: localize('onboarding.appearance.loaded', "Appearance choices loaded."),
		});
	}

	/**
	 * Chooses a mode and writes it. Returns false where the stage offers no choices, or a load or
	 * Continue is in flight.
	 */
	selectMode(mode: OnboardingAppearanceMode): boolean {
		const draft = this._state.appearanceDraft;
		if (this.finished || this._state.stage !== 'appearance' || this._state.busy || !this._state.appearance || !draft) {
			return false;
		}
		this.setState({ ...this._state, appearanceDraft: { ...draft, mode } });
		void this.queueAppearanceWrite();
		return true;
	}

	/** Chooses a preferred theme and writes it. Returns false unless the id is one the snapshot offers for that scheme. */
	selectPreferredTheme(scheme: OnboardingColorScheme, themeId: string): boolean {
		const draft = this._state.appearanceDraft;
		const snapshot = this._state.appearance;
		if (this.finished || this._state.stage !== 'appearance' || this._state.busy || !snapshot || !draft) {
			return false;
		}
		if (!onboardingThemesFor(snapshot, scheme).some(theme => theme.id === themeId)) {
			return false;
		}
		this.setState({
			...this._state,
			appearanceDraft: scheme === 'light' ? { ...draft, preferredLight: themeId } : { ...draft, preferredDark: themeId },
		});
		void this.queueAppearanceWrite();
		return true;
	}

	/** Appends one write to the chain and resolves once it has run, whether or not it wrote. */
	private queueAppearanceWrite(): Promise<void> {
		const write = this.appearanceWrites.then(() => this.writeAppearance());
		this.appearanceWrites = write;
		return write;
	}

	/**
	 * Writes whatever the draft holds beyond the snapshot, and makes the result the new snapshot.
	 *
	 * The choices show at once in the theme service as each write lands. A failed write keeps the
	 * old snapshot, so the next write, or Continue, carries the same difference again; its error
	 * shows on the stage until then. Both outcomes are dropped when the snapshot they diffed
	 * against is no longer the state's, which is what a reload after Back or a finished session
	 * leaves behind.
	 */
	private async writeAppearance(): Promise<void> {
		const { appearance: snapshot, appearanceDraft: draft } = this._state;
		if (!snapshot || !draft || !this.appearanceWriteLands(snapshot) || isOnboardingAppearanceApplied(snapshot, draft)) {
			return;
		}
		let next: OnboardingAppearanceSnapshot;
		try {
			next = await this.appearance.apply(snapshot, draft);
		} catch (error) {
			if (this.appearanceWriteLands(snapshot)) {
				this.logService.error(error instanceof Error ? error : String(error));
				const message = errorMessage(error);
				this.setState({ ...this._state, error: message, announcement: message });
			}
			return;
		}
		if (this.appearanceWriteLands(snapshot)) {
			this.setState({ ...this._state, appearance: next, error: undefined });
		}
	}

	/** True while the stage a write started from is still shown with the snapshot it diffed against. */
	private appearanceWriteLands(snapshot: OnboardingAppearanceSnapshot): boolean {
		return this._state.stage === 'appearance' && this._state.appearance === snapshot && !this.finished && !this._store.isDisposed;
	}

	/**
	 * Continue to Meet Omni from the two stages that offer it.
	 *
	 * From `appearance` it waits for the queued writes and lands any choice whose write failed. A
	 * write that still fails stays on the stage with its error so the user can retry or go back.
	 * Without a loaded snapshot there is nothing to compare against, so nothing is written and the
	 * stage is simply passed; the user can still finish onboarding.
	 *
	 * From the embedded migration it is offered only on concluded Results, and it disposes the
	 * migration session without acknowledging: the recovery data stays in the journal for the
	 * import command, as the standalone Done leaves it.
	 */
	async continueStage(): Promise<void> {
		if (this.finished || this._state.busy) {
			return;
		}
		if (this._state.stage === 'migrate') {
			if (this._migration && onboardingMigrationCanContinue(this._migration.state)) {
				const operation = this._migration.state.operation!;
				const handoffProfileId = operation.stage === 'settled' && operation.aggregateOutcome !== 'rolledBack' && operation.target.state === 'attached' ? operation.target.profileId : undefined;
				const importHadIssues = operation.aggregateOutcome === 'completedWithIssues' || operation.aggregateOutcome === 'recoverable' || undefined;
				await this.enterMeetOmni({ ...this._state, handoffProfileId, importHadIssues }, () => this.disposeMigration());
			}
			return;
		}
		if (this._state.stage !== 'appearance') {
			return;
		}
		if (this._state.appearance && this._state.appearanceDraft) {
			const generation = ++this.generation;
			this.setState({ ...this._state, busy: true, error: undefined });
			await this.queueAppearanceWrite();
			if (!this.isCurrent(generation)) {
				return;
			}
			if (this._state.error !== undefined) {
				this.setState({ ...this._state, busy: false });
				return;
			}
		}
		await this.enterMeetOmni({ ...this._state, busy: false, error: undefined });
	}

	/** Lands on Meet Omni with a fresh Omni snapshot, so a keybinding changed between visits shows. */
	private enterMeetOmni(state: OnboardingSessionState, after?: () => void): void | Promise<void> {
		return this.commitStage({ ...state, stage: 'meetOmni', omni: this.omni.snapshot() }, after);
	}

	/** Ends onboarding from Meet Omni with no handoff. */
	finishForNow(): Promise<void> {
		return this.complete();
	}

	/** Ends onboarding from Meet Omni, then runs Add Project in the Omni shell. */
	addProject(): Promise<void> {
		return this.complete(() => this.omni.addProject(this._state.handoffProfileId));
	}

	/** Ends onboarding from Meet Omni, then runs Add Workbench in the Omni shell. */
	openFolderAsWorkbench(): Promise<void> {
		return this.complete(() => this.omni.openFolderAsWorkbench(this._state.handoffProfileId));
	}

	/**
	 * The one way out of Meet Omni: records the installation as completed, finishes, and only then
	 * runs the handoff.
	 *
	 * The order matters. The surface must be gone before a handoff command opens its dialog, so
	 * that dialog is not under the modal: finishing asks the surface to close, and the handoff
	 * waits for the bound surface's close signal, within a bound so a surface that will not close
	 * cannot swallow the command. The command runs after onboarding is complete, so a command that
	 * fails or is cancelled is logged rather than shown on a stage that no longer exists. A record
	 * a newer build owns is never rewritten; the surface still finishes.
	 */
	private async complete(handoff?: () => Promise<void>): Promise<void> {
		if (this.finished || this._state.stage !== 'meetOmni' || this._state.busy) {
			return;
		}
		this.checkpointPending = true;
		this.setState({ ...this._state, busy: true, error: undefined });
		if (this.stored?.kind === 'record') {
			const record: OnboardingRecord = { version: ONBOARDING_RECORD_VERSION, status: 'completed', route: this._state.route, completedAt: this.now() };
			try {
				await this.store.write(record);
			} catch (error) {
				this.checkpointFailed(error);
				return;
			}
		}
		if (this._store.isDisposed) { return; }
		this.finished = true;
		this.disposeMigration();
		this._onDidFinish.fire();
		if (handoff) {
			if (this.surfaceClosed) {
				await raceTimeout(this.surfaceClosed, this.surfaceCloseTimeout, () => this.logService.warn('Onboarding surface did not close in time; running the handoff anyway.'));
			}
			try {
				await handoff();
			} catch (error) {
				this.logService.error(error instanceof Error ? error : String(error));
			}
		}
	}

	/**
	 * Ends onboarding without going through it.
	 *
	 * Recorded as `skipped` unless a newer build owns the record or the installation already
	 * completed onboarding; a completed record, with its `completedAt`, must survive being reopened
	 * and skipped. The surface finishes in every case.
	 */
	async skip(): Promise<void> {
		if (this.finished || this._state.busy) { return; }
		if (!this.stored) { this.initialize(); return; }
		this.checkpointPending = true;
		this.setState({ ...this._state, busy: true, error: undefined });
		try {
			if (this.stored?.kind === 'record' && this.stored.record.status !== 'completed') {
				await this.store.write({ version: ONBOARDING_RECORD_VERSION, status: 'skipped' });
			}
		} catch (error) {
			this.checkpointFailed(error);
			return;
		}
		if (this._store.isDisposed) { return; }
		this.finished = true;
		this.disposeMigration();
		this._onDidFinish.fire();
	}

	/**
	 * Records the current stage as resumable when the surface is dismissed.
	 *
	 * Escape, an outside click, the close button, and Do This Later all end here. An admitted
	 * Apply is asked to cancel first, exactly as closing the standalone import command does; the
	 * operation continues to its next durable checkpoint on its own, so the migration session can
	 * be disposed with the input afterwards. The stage was already recorded when it was entered;
	 * writing it again here keeps the dismissal path independent of that.
	 */
	recordDismissal(): void {
		if (this._migration && shouldCancelEditorMigrationOnClose(this._migration.state)) {
			this._migration.requestCancellation();
		}
		this.recordProgress();
	}

	/**
	 * Writes the current stage and route as resumable, so a window that exits without a dismissal
	 * still reopens where the user was. Nothing is written once the flow has finished, when a
	 * newer build owns the record, or in rerun mode, where a completed or skipped record must
	 * survive being looked at again.
	 */
	private recordProgress(): void {
		if (this.finished || this.checkpointPending || !this.stored || this.stored.kind === 'superseded' || this.stored.origin === 'malformed' || this._state.mode === 'rerun') {
			return;
		}
		void this.commitStage(this._state);
	}

	private commitStage(next: OnboardingSessionState, after?: () => void): void | Promise<void> {
		const accept = () => {
			this.checkpointPending = false;
			if (this.finished || this._store.isDisposed) { return; }
			if (next.mode === 'first') {
				this.stored = { kind: 'record', record: { version: ONBOARDING_RECORD_VERSION, status: 'inProgress', stage: next.stage, route: next.route, handoffProfileId: next.handoffProfileId, importHadIssues: next.importHadIssues } };
			}
			this.setState({ ...next, busy: false, error: undefined });
			after?.();
		};
		if (!this.stored || this.stored.kind === 'superseded' || next.mode === 'rerun') {
			accept();
			return;
		}
		try {
			const write = this.store.write({ version: ONBOARDING_RECORD_VERSION, status: 'inProgress', stage: next.stage, route: next.route, handoffProfileId: next.handoffProfileId, importHadIssues: next.importHadIssues });
			if (write) {
				this.checkpointPending = true;
				this.setState({ ...this._state, busy: true, error: undefined });
				return write.then(accept, error => this.checkpointFailed(error));
			}
			accept();
		} catch (error) {
			this.checkpointFailed(error);
		}
	}

	private checkpointFailed(error: unknown): void {
		this.checkpointPending = false;
		if (this._store.isDisposed) { return; }
		this.logService.error(error instanceof Error ? error : String(error));
		const message = errorMessage(error);
		this.setState({ ...this._state, busy: false, error: message, announcement: message });
	}

	private disposeMigration(): void {
		this._migration = undefined;
		this.migrationLifetime.clear();
	}

	private isCurrent(generation: number): boolean {
		return generation === this.generation && !this.finished && !this._store.isDisposed;
	}

	private setState(next: OnboardingSessionState): void {
		const stageChanged = next.stage !== this._state.stage;
		if (stageChanged) {
			this.generation++;
		}
		this._state = Object.freeze({ ...next });
		this._onDidChangeState.fire(this._state);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
		@IHucodeShellControllerService private readonly shellService: IHucodeShellControllerService,
		@IStorageService private readonly storageService: IStorageService,
		@IEditorMigrationFlowService private readonly migrationFlowService: IEditorMigrationFlowService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) { }

	createSession(): OnboardingSession {
		return new OnboardingSession(
			new OnboardingStateStore(this.storageService, isWeb ? undefined : record => this.shellService.checkpointOnboarding(JSON.stringify(record)), isWeb ? undefined : () => this.shellService.readOnboarding()),
			() => this.migrationFlowService.createSession(),
			this.instantiationService.createInstance(OnboardingAppearanceAuthority),
			this.instantiationService.createInstance(OnboardingOmniAuthority),
			this.logService,
		);
	}
}

registerSingleton(IOnboardingService, OnboardingService, InstantiationType.Delayed);
