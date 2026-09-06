/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { ONBOARDING_RECORD_VERSION, OnboardingStateStore, OnboardingStoredState } from './onboardingStateStore.js';

/**
 * Stages the session can present. Later steps add `migrate`, `appearance`, and `meetOmni`; the
 * record type already names them so a resumed record can name a stage this build cannot show.
 */
export type OnboardingStage = 'bring';

/**
 * `first` is a fresh or resumable run. `rerun` means onboarding was already completed, skipped, or
 * recorded by a newer build, so reopening it must change nothing on its own.
 */
export type OnboardingMode = 'first' | 'rerun';

/** Immutable state the presentation mapper draws from. */
export interface OnboardingSessionState {
	readonly stage: OnboardingStage;
	readonly busy: boolean;
	readonly mode: OnboardingMode;
	readonly announcement?: string;
}

const FIRST_STAGE: OnboardingStage = 'bring';

/** Stages this build can present. A later step adds each stage here as it lands. */
const PRESENTABLE_STAGES: ReadonlySet<string> = new Set<OnboardingStage>([FIRST_STAGE]);

/**
 * Maps a stored record onto the stage a reopened session lands on.
 *
 * Only `inProgress` resumes. A recorded stage this build cannot present, or no stage at all,
 * lands on the first stage rather than failing to open.
 */
export function onboardingResumeStage(stored: OnboardingStoredState): OnboardingStage {
	if (stored.kind !== 'record' || stored.record.status !== 'inProgress') {
		return FIRST_STAGE;
	}
	const recorded = stored.record.stage;
	return recorded !== undefined && PRESENTABLE_STAGES.has(recorded) ? recorded as OnboardingStage : FIRST_STAGE;
}

/** Whether a stored record means onboarding already ran to an end, or was written by a newer build. */
export function onboardingModeFor(stored: OnboardingStoredState): OnboardingMode {
	if (stored.kind === 'superseded') {
		return 'rerun';
	}
	return stored.record.status === 'completed' || stored.record.status === 'skipped' ? 'rerun' : 'first';
}

/**
 * Host-neutral onboarding state machine.
 *
 * One session lives for exactly one open of the onboarding surface. It owns stage navigation and
 * the durable record; the modal input owns the session's lifetime.
 */
export class OnboardingSession extends Disposable {
	private readonly _onDidChangeState = this._register(new Emitter<OnboardingSessionState>());
	readonly onDidChangeState: Event<OnboardingSessionState> = this._onDidChangeState.event;

	private readonly _onDidFinish = this._register(new Emitter<void>());
	/** Fires once, when the user ends the flow and the surface hosting it should close. */
	readonly onDidFinish: Event<void> = this._onDidFinish.event;

	private _state: OnboardingSessionState = Object.freeze({ stage: FIRST_STAGE, busy: false, mode: 'first' as const, announcement: undefined });
	private stored: OnboardingStoredState | undefined;
	private finished = false;

	constructor(private readonly store: OnboardingStateStore) {
		super();
	}

	get state(): OnboardingSessionState {
		return this._state;
	}

	/** Loads the record and lands on the stage it names. */
	initialize(): void {
		this.stored = this.store.read();
		this.setState({
			stage: onboardingResumeStage(this.stored),
			busy: false,
			mode: onboardingModeFor(this.stored),
			announcement: undefined,
		});
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
		this._onDidFinish.fire();
	}

	/**
	 * Records the current stage as resumable when the surface is dismissed.
	 *
	 * Escape, an outside click, the close button, and Do This Later all end here. Nothing is
	 * written once the flow has finished, when a newer build owns the record, or in rerun mode,
	 * where a completed or skipped record must survive being looked at again.
	 */
	recordDismissal(): void {
		if (this.finished || !this.stored || this.stored.kind === 'superseded' || this._state.mode === 'rerun') {
			return;
		}
		this.store.write({ version: ONBOARDING_RECORD_VERSION, status: 'inProgress', stage: this._state.stage });
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

	constructor(@IStorageService private readonly storageService: IStorageService) { }

	createSession(): OnboardingSession {
		return new OnboardingSession(new OnboardingStateStore(this.storageService));
	}
}

registerSingleton(IOnboardingService, OnboardingService, InstantiationType.Delayed);
