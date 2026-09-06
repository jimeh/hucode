/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { localize } from '../../../nls.js';
import {
	EditorMigrationSetupPresentation,
	editorMigrationSetupPhaseAdmits,
	isEditorMigrationSetupRevisionBound,
} from '../../common/migration/editorMigrationSetupProtocol.js';
import { EditorMigrationFlowSession } from '../migration/editorMigrationFlow.js';
import {
	EditorMigrationSetupPresenter,
	ISetupWebviewPresenter,
	SetupWebviewDispatchableIntent,
	SetupWebviewIntentOutcome,
} from '../migration/editorMigrationSetupPresenter.js';
import { onboardingPresentation } from './onboardingPresentation.js';
import { OnboardingSession, onboardingOwnsMigrationBack } from './onboardingSession.js';

/**
 * Presents an `OnboardingSession` through the setup webview.
 *
 * Outside the `migrate` stage the admission policy is the protocol's, keyed on the onboarding
 * stage, so every migration intent is superseded before it could reach anything. Inside it, an
 * inner migration presenter built over the embedded session answers every migration intent
 * unchanged, except the two onboarding intercepts: Back while no source is chosen, which returns
 * to `bring`, and acknowledging results, which moves on to Meet Omni.
 */
export class OnboardingSetupPresenter implements ISetupWebviewPresenter {
	readonly onDidChangeState: Event<unknown>;
	readonly onDidFinish: Event<void>;
	readonly title = localize('onboarding.editorName', "Hucode Onboarding");
	readonly bootstrapText = localize('onboarding.setup.bootstrap', "Starting Hucode onboarding...");
	private inner: { readonly session: EditorMigrationFlowSession; readonly presenter: EditorMigrationSetupPresenter } | undefined;

	constructor(private readonly session: OnboardingSession) {
		this.onDidChangeState = session.onDidChangeState;
		this.onDidFinish = session.onDidFinish;
	}

	presentation(revision: number): EditorMigrationSetupPresentation {
		const inner = this.innerPresenter();
		return onboardingPresentation(this.session.state, revision, inner?.presentation(revision));
	}

	isPendingChangeCoalescable(): boolean {
		// Onboarding publishes no progress stream of its own; only the embedded migration does.
		return this.innerPresenter()?.isPendingChangeCoalescable() ?? false;
	}

	handleIntent(intent: SetupWebviewDispatchableIntent, isCurrentRevision: boolean): SetupWebviewIntentOutcome {
		const state = this.session.state;
		if (state.stage === 'migrate') {
			const inner = this.innerPresenter();
			return inner ? this.handleMigrationIntent(intent, isCurrentRevision, inner) : 'superseded';
		}
		if (!editorMigrationSetupPhaseAdmits(intent.type, state.stage, state.busy)) {
			return 'superseded';
		}
		if (isEditorMigrationSetupRevisionBound(intent.type) && !isCurrentRevision) {
			return 'staleRevision';
		}
		switch (intent.type) {
			case 'skip':
				this.session.skip();
				return 'accepted';
			case 'chooseRoute':
				this.session.chooseRoute(intent.route);
				return 'accepted';
			case 'continueStage':
				this.session.continueStage();
				return 'accepted';
			case 'finishForNow':
				this.session.finishForNow();
				return 'accepted';
			case 'back':
				return this.session.back() ? 'accepted' : 'unresolvable';
			default:
				// A migration intent. None is admitted in an onboarding stage, so the guard above
				// has already answered.
				return 'unresolvable';
		}
	}

	/**
	 * Inside the embedded migration, the migration presenter's admission is the law, with two
	 * intercepts decided before it is consulted.
	 */
	private handleMigrationIntent(intent: SetupWebviewDispatchableIntent, isCurrentRevision: boolean, inner: EditorMigrationSetupPresenter): SetupWebviewIntentOutcome {
		const migration = this.session.migration!.state;
		if (intent.type === 'back' && onboardingOwnsMigrationBack(migration.phase)) {
			// The import route never offers Back here, so the protocol's table refuses it; the
			// onboarding footer does, and the same revision binding as every other Back applies.
			if (!isCurrentRevision) {
				return 'staleRevision';
			}
			return this.session.back() ? 'accepted' : 'unresolvable';
		}
		if (intent.type === 'acknowledge') {
			if (!editorMigrationSetupPhaseAdmits(intent.type, migration.phase, migration.busy)) {
				return 'superseded';
			}
			if (!migration.operation) {
				return 'unresolvable';
			}
			void this.session.acknowledgeMigration();
			return 'accepted';
		}
		return inner.handleIntent(intent, isCurrentRevision);
	}

	/** The migration presenter for the current embedded session, kept across calls for coalescing. */
	private innerPresenter(): EditorMigrationSetupPresenter | undefined {
		const session = this.session.migration;
		if (!session) {
			this.inner = undefined;
			return undefined;
		}
		if (this.inner?.session !== session) {
			this.inner = { session, presenter: new EditorMigrationSetupPresenter(session) };
		}
		return this.inner.presenter;
	}
}
