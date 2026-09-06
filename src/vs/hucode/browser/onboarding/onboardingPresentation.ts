/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../base/common/date.js';
import { localize } from '../../../nls.js';
import {
	EditorMigrationSetupAction,
	EditorMigrationSetupPanel,
	EditorMigrationSetupPresentation,
} from '../../common/migration/editorMigrationSetupProtocol.js';
import { EditorMigrationFlowPhase } from '../migration/editorMigrationFlow.js';
import { OnboardingPreviousOutcome, OnboardingSessionState, onboardingOwnsMigrationBack } from './onboardingSession.js';

type OnboardingStep = 'bring' | 'review' | 'meetOmni';

/**
 * Maps onboarding state into the wire-safe, fully localized snapshot the renderer draws.
 *
 * Every user-visible string of the onboarding route originates here. The renderer owns nothing
 * but local presentation state.
 *
 * During the `migrate` stage the caller passes the embedded migration's own presentation. It is
 * kept whole, with onboarding's identity, step header, and scope laid over it, and a Back to
 * `bring` prepended while the migration has no chosen source.
 */
export function onboardingPresentation(state: OnboardingSessionState, revision: number, migration?: EditorMigrationSetupPresentation): EditorMigrationSetupPresentation {
	if (state.stage === 'migrate' && migration) {
		return embeddedMigrationPresentation(state, migration);
	}
	return {
		revision,
		route: 'onboarding',
		phase: state.stage === 'migrate' ? 'loading' : state.stage,
		regionLabel: regionLabel(),
		title: title(),
		steps: steps(state.stage === 'meetOmni' ? 'meetOmni' : 'bring'),
		busy: state.busy,
		canceling: false,
		error: undefined,
		announcement: state.announcement,
		railLabel: undefined,
		railTitle: undefined,
		sections: [],
		defaultSectionId: undefined,
		scopeKey: `onboarding|${state.stage}|${state.mode}`,
		panels: [panelFor(state)],
		footer: footerFor(state),
		sectionAnnouncementTemplate: localize('onboarding.index.showing', "Showing {0}.", '{0}'),
	};
}

function embeddedMigrationPresentation(state: OnboardingSessionState, migration: EditorMigrationSetupPresentation): EditorMigrationSetupPresentation {
	const phase = migration.phase as EditorMigrationFlowPhase;
	return {
		...migration,
		route: 'onboarding',
		regionLabel: regionLabel(),
		title: title(),
		steps: steps(migrationStep(phase)),
		scopeKey: `onboarding|migrate|${migration.scopeKey}`,
		footer: onboardingOwnsMigrationBack(phase)
			? { lines: migration.footer.lines, actions: [backAction(), ...migration.footer.actions] }
			: migration.footer,
	};
}

/** Which onboarding step an embedded migration phase belongs to. */
function migrationStep(phase: EditorMigrationFlowPhase): OnboardingStep {
	switch (phase) {
		case 'loading':
		case 'recovery':
		case 'application':
		case 'profile':
		case 'target':
			return 'bring';
		case 'review':
		case 'publishers':
		case 'apply':
		case 'results':
			return 'review';
	}
}

function regionLabel(): string {
	return localize('onboarding.region', "Hucode Onboarding");
}

function title(): string {
	return localize('onboarding.title', "Welcome to Hucode");
}

function steps(current: OnboardingStep): EditorMigrationSetupPresentation['steps'] {
	return [
		{ id: 'bring', label: localize('onboarding.step.bring', "Bring Your Setup"), current: current === 'bring' },
		{ id: 'review', label: localize('onboarding.step.review', "Review"), current: current === 'review' },
		{ id: 'meetOmni', label: localize('onboarding.step.meetOmni', "Meet Omni"), current: current === 'meetOmni' },
	];
}

// #region panels

function panelFor(state: OnboardingSessionState): EditorMigrationSetupPanel {
	switch (state.stage) {
		case 'bring':
		case 'migrate':
			return bringPanel(state);
		case 'appearance':
			return {
				kind: 'message',
				id: '',
				heading: localize('onboarding.appearance.heading', "Choose How Hucode Looks"),
				lead: localize('onboarding.appearance.placeholder', "The appearance choices arrive in a later step. Continue to meet Omni, or go back to change your route."),
			};
		case 'meetOmni':
			return {
				kind: 'message',
				id: '',
				heading: localize('onboarding.meetOmni.heading', "Meet Omni"),
				lead: localize('onboarding.meetOmni.placeholder', "The Omni introduction arrives in a later step. Finish for Now records onboarding as complete."),
			};
	}
}

function bringPanel(state: OnboardingSessionState): EditorMigrationSetupPanel {
	const choices: Extract<EditorMigrationSetupPanel, { kind: 'bring' }>['choices'] = [
		{
			id: 'migrate',
			label: state.mode === 'rerun'
				? localize('onboarding.bring.choice.migrate.rerun', "Start a New Import")
				: localize('onboarding.bring.choice.migrate', "Import from Another Editor"),
			detail: localize('onboarding.bring.choice.migrate.detail', "Bring settings, keyboard shortcuts, snippets, and extensions from a supported editor installed on this machine. You review everything before anything is written."),
		},
		{
			id: 'skipImport',
			label: localize('onboarding.bring.choice.skipImport', "Skip Import"),
			detail: localize('onboarding.bring.choice.skipImport.detail', "Continue without importing from another editor. Nothing you have already configured is removed."),
		},
	];
	if (state.mode === 'rerun') {
		return {
			kind: 'bring',
			id: '',
			heading: localize('onboarding.bring.rerun.heading', "Onboarding Is Already Complete"),
			lead: previousOutcomeSummary(state.previous),
			paragraphs: [
				localize('onboarding.bring.rerun.nothingRuns', "Nothing runs on its own. Choose a route to go through onboarding again, or leave: Skip records that you chose not to, and Do This Later closes this window and keeps your existing choice."),
			],
			choices,
		};
	}
	return {
		kind: 'bring',
		id: '',
		heading: localize('onboarding.bring.heading', "Bring Your Setup to Hucode"),
		lead: localize('onboarding.bring.lead', "Import settings, keyboard shortcuts, snippets, and extensions from another editor, or continue without importing."),
		paragraphs: [
			// Name the Command Palette entry here once the open command is registered with `f1: true`.
			localize('onboarding.bring.later', "Do This Later keeps your place, so onboarding reopens on this step when you come back to it."),
		],
		choices,
	};
}

/** What the earlier run did, from the record alone; acknowledged operations leave the journal. */
function previousOutcomeSummary(previous: OnboardingPreviousOutcome | undefined): string {
	if (!previous || previous.status === 'superseded') {
		return localize('onboarding.bring.rerun.superseded', "A newer version of Hucode recorded this installation's onboarding. Reopening it changes nothing on its own.");
	}
	if (previous.status === 'skipped') {
		return localize('onboarding.bring.rerun.skipped', "You skipped onboarding earlier. Reopening it changes nothing on its own.");
	}
	const when = previous.completedAt === undefined
		? localize('onboarding.bring.rerun.earlier', "earlier")
		: fromNow(previous.completedAt, true, true);
	return previous.route === 'migrate'
		? localize('onboarding.bring.rerun.completedMigrate', "You completed onboarding {0} and imported a setup from another editor. Reopening it changes nothing on its own.", when)
		: localize('onboarding.bring.rerun.completedSkipImport', "You completed onboarding {0} without importing from another editor. Reopening it changes nothing on its own.", when);
}

// #endregion

// #region footer

function footerFor(state: OnboardingSessionState): EditorMigrationSetupPresentation['footer'] {
	switch (state.stage) {
		case 'bring':
		case 'migrate':
			return {
				lines: [],
				actions: [
					action('skip', localize('onboarding.skip', "Skip"), { type: 'skip' }, 'default', state.busy),
					action('later', localize('onboarding.later', "Do This Later"), { type: 'close' }),
				],
			};
		case 'appearance':
			return {
				lines: [],
				actions: [
					backAction(),
					action('appearance-continue', localize('onboarding.continue', "Continue"), { type: 'continueStage' }, 'primary', state.busy),
				],
			};
		case 'meetOmni':
			return {
				lines: [],
				actions: [
					...(state.route === 'skipImport' ? [backAction()] : []),
					action('finish', localize('onboarding.finishForNow', "Finish for Now"), { type: 'finishForNow' }, 'primary', state.busy),
				],
			};
	}
}

function backAction(): EditorMigrationSetupAction {
	return action('back', localize('onboarding.back', "Back"), { type: 'back' });
}

function action(
	id: string,
	label: string,
	intent: EditorMigrationSetupAction['intent'],
	kind: EditorMigrationSetupAction['kind'] = 'default',
	disabled = false,
): EditorMigrationSetupAction {
	return { id, label, kind, disabled, intent };
}

// #endregion
