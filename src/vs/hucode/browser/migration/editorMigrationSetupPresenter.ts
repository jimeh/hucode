/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { localize } from '../../../nls.js';
import { EditorMigrationCategory } from '../../common/migration/editorMigrationSource.js';
import {
	EditorMigrationSetupIntent,
	EditorMigrationSetupPresentation,
	editorMigrationSetupPhaseAdmits,
	isEditorMigrationSetupRevisionBound,
} from '../../common/migration/editorMigrationSetupProtocol.js';
import { EditorMigrationFlowSession, EditorMigrationFlowState } from './editorMigrationFlow.js';
import { editorMigrationRollbackEligibleCategories } from './editorMigrationFlowSections.js';
import { editorMigrationSetupPresentation } from './editorMigrationSetupPresentation.js';

/** Intents the host hands to a presenter. `ready` and `close` are lifecycle and never reach it. */
export type SetupWebviewDispatchableIntent = Exclude<EditorMigrationSetupIntent, { type: 'ready' } | { type: 'close' }>;

/**
 * How a presenter answered one renderer intent.
 *
 * `superseded` means the surface has moved past the screen the gesture came from, which the host
 * answers with the current snapshot and no error. `staleRevision` and `unresolvable` are refusals
 * with a localized reason. Only `accepted` ran a session method.
 */
export type SetupWebviewIntentOutcome = 'accepted' | 'superseded' | 'staleRevision' | 'unresolvable';

/**
 * What the setup webview host needs from whatever it is presenting.
 *
 * The host owns asset probing, CSP, the ready deadline, revision numbering, coalescing, and the
 * failure surface. A presenter owns the session behind the snapshot: it maps state to the wire
 * presentation, decides which intents the current state admits, and calls the session methods.
 * Nothing about the webview reaches a presenter, and nothing about a session reaches the host.
 */
export interface ISetupWebviewPresenter {
	/** Fires whenever the presented state changes. The payload is ignored; the host re-reads. */
	readonly onDidChangeState: Event<unknown>;
	/** Fires once the surface has finished and the framing that hosts it should close. */
	readonly onDidFinish: Event<void>;
	/** Localized title of the webview document. */
	readonly title: string;
	/** Localized fallback shown while the renderer bundle is still starting. */
	readonly bootstrapText: string;
	/** Snapshot of the current state, stamped with the revision the host assigned to it. */
	presentation(revision: number): EditorMigrationSetupPresentation;
	/**
	 * Whether the change since the last `presentation()` call may wait for the next animation
	 * frame. Phase changes, errors, and terminal states must answer false so they cross at once.
	 */
	isPendingChangeCoalescable(): boolean;
	/** Resolves one intent against current state. `isCurrentRevision` is the host's stamp check. */
	handleIntent(intent: SetupWebviewDispatchableIntent, isCurrentRevision: boolean): SetupWebviewIntentOutcome;
}

/**
 * Presents an `EditorMigrationFlowSession` through the setup webview.
 *
 * Every privileged action still runs through the session, and the renderer can express nothing
 * outside the protocol's closed intent union.
 */
export class EditorMigrationSetupPresenter implements ISetupWebviewPresenter {
	readonly onDidChangeState: Event<unknown>;
	readonly onDidFinish = Event.None;
	readonly title = localize('editorMigration.editorName', "Import Editor Setup");
	readonly bootstrapText = localize('editorMigration.setup.bootstrap', "Starting the editor setup import...");
	private presented: EditorMigrationFlowState | undefined;

	constructor(private readonly session: EditorMigrationFlowSession) {
		this.onDidChangeState = session.onDidChangeState;
	}

	presentation(revision: number): EditorMigrationSetupPresentation {
		const state = this.session.state;
		this.presented = state;
		return editorMigrationSetupPresentation(state, revision);
	}

	isPendingChangeCoalescable(): boolean {
		return isProgressOnlyChange(this.presented, this.session.state);
	}

	handleIntent(intent: SetupWebviewDispatchableIntent, isCurrentRevision: boolean): SetupWebviewIntentOutcome {
		/*
		 * A gesture the session has already moved past is a duplicate, not a mistake.
		 *
		 * Rapidly confirming publishers twice is the case that matters: the first click starts the
		 * import, and the second must neither start a second one nor cancel the first. Answering it
		 * with the current snapshot and no error keeps the user on the screen they are already
		 * looking at, because the phase change is the explanation.
		 */
		const state = this.session.state;
		if (!editorMigrationSetupPhaseAdmits(intent.type, state.phase, state.busy)) {
			return 'superseded';
		}
		if (isEditorMigrationSetupRevisionBound(intent.type) && !isCurrentRevision) {
			return 'staleRevision';
		}
		return this.dispatch(intent) ? 'accepted' : 'unresolvable';
	}

	/**
	 * Resolves an intent against current state and calls the matching session method.
	 *
	 * Returns false when the intent names something the current state does not offer. Nothing here
	 * accepts a command ID, path, URI, or service method from the webview.
	 */
	private dispatch(intent: SetupWebviewDispatchableIntent): boolean {
		const state = this.session.state;
		switch (intent.type) {
			case 'startImport':
				void this.session.startImport();
				return true;
			case 'refreshDiscovery':
				void this.session.refreshDiscovery();
				return true;
			case 'selectApplication': {
				if (!state.applications.some(application => application.id === intent.applicationId)) {
					return false;
				}
				this.session.selectApplication(intent.applicationId);
				return true;
			}
			case 'selectSourceProfile': {
				const application = state.applications.find(candidate => candidate.id === state.selectedApplicationId);
				const source = application?.profiles.find(profile => profile.ref.value === intent.sourceRef);
				if (!source) {
					return false;
				}
				this.session.selectSourceProfile(source.ref);
				return true;
			}
			case 'continueFromProfile':
				void this.session.continueFromProfile();
				return true;
			case 'selectTarget': {
				const requested = intent.target;
				if (requested.kind === 'existing') {
					const target = state.targets.find(candidate => candidate.selection.profileId === requested.profileId);
					if (!target) {
						return false;
					}
					this.session.selectTarget(target.selection);
					return true;
				}
				const name = requested.name.trim();
				if (!name) {
					return false;
				}
				this.session.selectTarget({ kind: 'proposed', name });
				return true;
			}
			case 'continueFromTarget':
				void this.session.continueFromTarget();
				return true;
			case 'rebuildReview':
				void this.session.rebuildReview();
				return true;
			case 'toggleCategory': {
				if (!state.draft?.target.requestedCategories.includes(intent.category)) {
					return false;
				}
				this.session.toggleCategory(intent.category, intent.selected);
				return true;
			}
			case 'chooseDecision': {
				if (!state.draft?.decisions.some(decision => decision.id === intent.decisionId && decision.kind === 'conflict')) {
					return false;
				}
				this.session.chooseDecision(intent.decisionId, intent.choice);
				return true;
			}
			case 'chooseAllSettingDifferences':
				this.session.chooseAllSettingDifferences(intent.choice);
				return true;
			case 'acceptReview':
				void this.session.acceptReview();
				return true;
			case 'confirmPublishers':
				void this.session.confirmPublishers();
				return true;
			case 'requestCancellation':
				this.session.requestCancellation();
				return true;
			case 'showRecovery': {
				if (!state.recoveries.some(recovery => recovery.id === intent.operationId && recovery.unsupportedSchemaVersion === undefined)) {
					return false;
				}
				void this.session.showRecovery(intent.operationId);
				return true;
			}
			case 'resume':
			case 'retry': {
				if (state.operation?.id !== intent.operationId) {
					return false;
				}
				void (intent.type === 'resume' ? this.session.resume(intent.operationId) : this.session.retry(intent.operationId));
				return true;
			}
			case 'inspectRollback': {
				const eligible = this.rollbackEligible(state);
				if (!intent.categories.length || !intent.categories.every(category => eligible.includes(category))) {
					return false;
				}
				void this.session.inspectRollback(intent.categories);
				return true;
			}
			case 'clearRollbackInspection':
				this.session.clearRollbackInspection();
				return true;
			case 'rollback': {
				const eligible = this.rollbackEligible(state);
				const drifted = state.rollbackInspection?.driftedCategories ?? [];
				if (!intent.categories.length || !intent.categories.every(category => eligible.includes(category))) {
					return false;
				}
				// Forcing past drift is only ever authorized for the categories the current
				// inspection actually reported as drifted.
				if (!intent.forceCategories.every(category => drifted.includes(category) && intent.categories.includes(category))) {
					return false;
				}
				void this.session.rollback(intent.categories, intent.forceCategories);
				return true;
			}
			case 'copyReport':
				void this.session.copyReport();
				return true;
			case 'acknowledge':
				void this.session.acknowledge();
				return true;
			case 'back':
				this.session.back();
				return true;
			case 'skip':
			case 'chooseRoute':
			case 'selectMode':
			case 'selectPreferredTheme':
			case 'continueStage':
			case 'setDensity':
			case 'finishForNow':
			case 'addProject':
			case 'openFolderAsWorkbench':
				// Onboarding intents. Their policies admit them in no migration phase, so this is
				// unreachable; the migration session has no stages to move between.
				return false;
		}
	}

	private rollbackEligible(state: EditorMigrationFlowState): readonly Exclude<EditorMigrationCategory, 'extensions'>[] {
		return state.operation ? editorMigrationRollbackEligibleCategories(state.operation) : [];
	}
}

/** True when nothing but Apply progress and its announcement changed. */
export function isProgressOnlyChange(previous: EditorMigrationFlowState | undefined, next: EditorMigrationFlowState): boolean {
	if (!previous || !previous.progress || !next.progress) {
		return false;
	}
	return previous.phase === next.phase
		&& previous.busy === next.busy
		&& previous.canceling === next.canceling
		&& previous.error === next.error
		&& previous.operation === next.operation
		&& previous.reviewedPlan === next.reviewedPlan
		&& previous.rollbackInspection === next.rollbackInspection
		&& previous.progress.operationId === next.progress.operationId
		&& previous.progress.stage === next.progress.stage;
}
