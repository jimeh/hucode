/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import {
	EditorMigrationSetupAction,
	EditorMigrationSetupPanel,
	EditorMigrationSetupPresentation,
} from '../../common/migration/editorMigrationSetupProtocol.js';
import { OnboardingSessionState } from './onboardingSession.js';

/**
 * Maps onboarding state into the wire-safe, fully localized snapshot the renderer draws.
 *
 * Every user-visible string of the onboarding route originates here. The renderer owns nothing
 * but local presentation state.
 */
export function onboardingPresentation(state: OnboardingSessionState, revision: number): EditorMigrationSetupPresentation {
	return {
		revision,
		route: 'onboarding',
		phase: state.stage,
		regionLabel: localize('onboarding.region', "Hucode Onboarding"),
		title: localize('onboarding.title', "Welcome to Hucode"),
		steps: [
			{ id: 'bring', label: localize('onboarding.step.bring', "Bring Your Setup"), current: state.stage === 'bring' },
			{ id: 'review', label: localize('onboarding.step.review', "Review"), current: false },
			{ id: 'meetOmni', label: localize('onboarding.step.meetOmni', "Meet Omni"), current: false },
		],
		busy: state.busy,
		canceling: false,
		error: undefined,
		announcement: state.announcement,
		railLabel: undefined,
		railTitle: undefined,
		sections: [],
		defaultSectionId: undefined,
		scopeKey: `onboarding|${state.stage}|${state.mode}`,
		panels: [bringPanel(state)],
		footer: {
			lines: [],
			actions: [
				action('skip', localize('onboarding.skip', "Skip"), { type: 'skip' }, state.busy),
				action('later', localize('onboarding.later', "Do This Later"), { type: 'close' }),
			],
		},
		sectionAnnouncementTemplate: localize('onboarding.index.showing', "Showing {0}.", '{0}'),
	};
}

function bringPanel(state: OnboardingSessionState): EditorMigrationSetupPanel {
	if (state.mode === 'rerun') {
		return {
			kind: 'bring',
			id: '',
			heading: localize('onboarding.bring.rerun.heading', "Onboarding Is Already Complete"),
			lead: localize('onboarding.bring.rerun.lead', "You completed or skipped onboarding earlier. Reopening it changes nothing on its own."),
			paragraphs: [
				localize('onboarding.bring.rerun.skip', "Skip records that you chose not to go through onboarding again. Do This Later closes this window and keeps your existing choice."),
			],
		};
	}
	return {
		kind: 'bring',
		id: '',
		heading: localize('onboarding.bring.heading', "Bring Your Setup to Hucode"),
		lead: localize('onboarding.bring.lead', "Import settings, keyboard shortcuts, snippets, and extensions from another editor, or continue without importing."),
		paragraphs: [
			localize('onboarding.bring.pending', "The import and skip-import choices are not available yet. You can skip onboarding now, or come back to it later."),
			// Name the Command Palette entry here once the open command is registered with `f1: true`.
			localize('onboarding.bring.later', "Do This Later keeps your place, so onboarding reopens on this step when you come back to it."),
		],
	};
}

function action(id: string, label: string, intent: EditorMigrationSetupAction['intent'], disabled = false): EditorMigrationSetupAction {
	return { id, label, kind: 'default', disabled, intent };
}
