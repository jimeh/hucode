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
import { ISetupWebviewPresenter, SetupWebviewDispatchableIntent, SetupWebviewIntentOutcome } from '../migration/editorMigrationSetupPresenter.js';
import { onboardingPresentation } from './onboardingPresentation.js';
import { OnboardingSession } from './onboardingSession.js';

/**
 * Presents an `OnboardingSession` through the setup webview.
 *
 * The admission policy is the protocol's: only `skip` may act in the `bring` stage, so every
 * migration intent arriving here is superseded before it could reach anything.
 */
export class OnboardingSetupPresenter implements ISetupWebviewPresenter {
	readonly onDidChangeState: Event<unknown>;
	readonly onDidFinish: Event<void>;
	readonly title = localize('onboarding.editorName', "Hucode Onboarding");
	readonly bootstrapText = localize('onboarding.setup.bootstrap', "Starting Hucode onboarding...");

	constructor(private readonly session: OnboardingSession) {
		this.onDidChangeState = session.onDidChangeState;
		this.onDidFinish = session.onDidFinish;
	}

	presentation(revision: number): EditorMigrationSetupPresentation {
		return onboardingPresentation(this.session.state, revision);
	}

	isPendingChangeCoalescable(): boolean {
		// Onboarding publishes no progress stream; every change is a stage or mode boundary.
		return false;
	}

	handleIntent(intent: SetupWebviewDispatchableIntent, isCurrentRevision: boolean): SetupWebviewIntentOutcome {
		const state = this.session.state;
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
			default:
				// A migration intent. None is admitted in an onboarding stage, so the guard above
				// has already answered; nothing here forwards to a migration session yet.
				return 'unresolvable';
		}
	}
}
