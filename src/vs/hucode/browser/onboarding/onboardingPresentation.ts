/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../base/common/date.js';
import { localize } from '../../../nls.js';
import {
	EditorMigrationSetupAction,
	EditorMigrationSetupIntentType,
	EditorMigrationSetupPanel,
	EditorMigrationSetupPresentation,
	EditorMigrationSetupRadioOption,
	EditorMigrationSetupShortcut,
	EditorMigrationSetupThemeGroup,
} from '../../common/migration/editorMigrationSetupProtocol.js';
import { EditorMigrationFlowPhase, EditorMigrationFlowState } from '../migration/editorMigrationFlow.js';
import { editorMigrationResultsFooterLines } from '../migration/editorMigrationSetupPresentation.js';
import { OnboardingAppearanceDraft, OnboardingAppearanceMode, OnboardingAppearanceSnapshot, OnboardingColorScheme, onboardingThemesFor } from './onboardingAppearance.js';
import { OnboardingOmniShortcut } from './onboardingOmni.js';
import { OnboardingPreviousOutcome, OnboardingSessionState, onboardingMigrationCanContinue, onboardingOwnsMigrationBack } from './onboardingSession.js';

type OnboardingStep = 'bring' | 'review' | 'meetOmni';

/** The embedded migration as the `migrate` stage presents it: its state, and its own snapshot. */
export interface OnboardingEmbeddedMigration {
	readonly flow: EditorMigrationFlowState;
	readonly presentation: EditorMigrationSetupPresentation;
}

/**
 * The standalone Results actions onboarding keeps. Import Another Setup and both Done buttons go:
 * onboarding continues to Meet Omni instead, and the recovery data stays for the import command.
 */
const RESULTS_ACTIONS_KEPT: ReadonlySet<EditorMigrationSetupIntentType> = new Set<EditorMigrationSetupIntentType>(['copyReport', 'retry', 'resume']);

/**
 * Maps onboarding state into the wire-safe, fully localized snapshot the renderer draws.
 *
 * Every user-visible string of the onboarding route originates here. The renderer owns nothing
 * but local presentation state.
 *
 * During the `migrate` stage the caller passes the embedded migration. Its presentation is kept
 * whole, with onboarding's identity, step header, and scope laid over it, a Back to `bring`
 * prepended while the migration has no chosen source, and the Results footer replaced by one that
 * continues onboarding.
 */
export function onboardingPresentation(state: OnboardingSessionState, revision: number, migration?: OnboardingEmbeddedMigration): EditorMigrationSetupPresentation {
	if (state.stage === 'migrate' && migration) {
		return embeddedMigrationPresentation(migration);
	}
	return {
		revision,
		route: 'onboarding',
		phase: state.stage === 'migrate' ? 'loading' : state.stage,
		regionLabel: regionLabel(),
		title: title(),
		steps: steps(state.stage === 'meetOmni' ? 'meetOmni' : state.stage === 'appearance' ? 'review' : 'bring'),
		busy: state.busy,
		canceling: false,
		error: state.error,
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

function embeddedMigrationPresentation({ flow, presentation: migration }: OnboardingEmbeddedMigration): EditorMigrationSetupPresentation {
	const phase = migration.phase as EditorMigrationFlowPhase;
	return {
		...migration,
		route: 'onboarding',
		regionLabel: regionLabel(),
		title: title(),
		steps: steps(migrationStep(phase)),
		scopeKey: `onboarding|migrate|${migration.scopeKey}`,
		footer: embeddedMigrationFooter(phase, flow, migration.footer),
	};
}

function embeddedMigrationFooter(phase: EditorMigrationFlowPhase, flow: EditorMigrationFlowState, footer: EditorMigrationSetupPresentation['footer']): EditorMigrationSetupPresentation['footer'] {
	if (onboardingOwnsMigrationBack(phase)) {
		return { lines: footer.lines, actions: [backAction(), ...footer.actions] };
	}
	if (phase !== 'results' || !flow.operation) {
		return footer;
	}
	// The migration's own status lines stay; the sentence about removing recovery data went with
	// the button that removed it.
	const lines = [
		...editorMigrationResultsFooterLines(flow.operation),
		localize('onboarding.results.recoveryKept', "Recovery data stays available from the Import Setup from Another Editor command."),
	];
	const actions = footer.actions.filter(action => RESULTS_ACTIONS_KEPT.has(action.intent.type));
	if (onboardingMigrationCanContinue(flow)) {
		actions.push(action('results-continue', localize('onboarding.continue', "Continue"), { type: 'continueStage' }, 'primary'));
	}
	return { lines, actions };
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
			return appearancePanel(state);
		case 'meetOmni':
			return meetOmniPanel(state);
	}
}

/** The Meet Omni stage: the three nouns, and the shortcuts with the chords the host resolved. */
function meetOmniPanel(state: OnboardingSessionState): EditorMigrationSetupPanel {
	return {
		kind: 'meetOmni',
		id: '',
		heading: localize('onboarding.meetOmni.heading', "Meet Omni"),
		lead: localize('onboarding.meetOmni.lead', "Omni is Hucode's outer shell. It keeps your projects and their worktrees in one sidebar and switches between loaded workbenches without opening another window."),
		glossary: [
			{ term: localize('onboarding.meetOmni.term.project', "Project"), definition: localize('onboarding.meetOmni.def.project', "A saved Git repository. Hucode discovers its worktrees and nests them beneath it.") },
			{ term: localize('onboarding.meetOmni.term.worktree', "Worktree"), definition: localize('onboarding.meetOmni.def.worktree', "One checkout belonging to a project. Selecting it opens or activates a workbench for that checkout.") },
			{ term: localize('onboarding.meetOmni.term.workbench', "Workbench"), definition: localize('onboarding.meetOmni.def.workbench', "A VS Code window hosted inside Omni for one folder, or any saved folder that is not a project worktree.") },
		],
		shortcuts: (state.omni?.shortcuts ?? []).map(shortcut),
	};
}

function shortcut(entry: OnboardingOmniShortcut): EditorMigrationSetupShortcut {
	return entry.keybinding
		? { label: entry.label, keybinding: entry.keybinding.label, keybindingAriaLabel: entry.keybinding.ariaLabel }
		: { label: entry.label, noShortcutText: localize('onboarding.meetOmni.noShortcut', "No keyboard shortcut is assigned. Use the Command Palette.") };
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
			localize('onboarding.bring.later', "Do This Later keeps your place, so onboarding reopens on this step when you come back to it. You can reopen it at any time with the Hucode: Open Onboarding command in the Command Palette."),
		],
		choices,
	};
}

/**
 * The appearance stage: loading until its snapshot arrives, the choices once it has, and a
 * passable explanation when the load failed.
 */
function appearancePanel(state: OnboardingSessionState): EditorMigrationSetupPanel {
	const heading = localize('onboarding.appearance.heading', "Choose How Hucode Looks");
	const snapshot = state.appearance;
	const draft = state.appearanceDraft;
	if (!snapshot || !draft) {
		if (state.busy) {
			return {
				kind: 'loading',
				id: '',
				heading: localize('onboarding.appearance.loading', "Reading Installed Themes..."),
				progress: { text: localize('onboarding.appearance.loading.detail', "Looking up the current appearance and the installed color themes."), min: 0, max: 1, now: 0 },
			};
		}
		return {
			kind: 'message',
			id: '',
			heading,
			lead: localize('onboarding.appearance.unavailable', "Hucode could not read the installed themes, so the appearance choices are unavailable. Continue keeps your current appearance unchanged."),
		};
	}
	const modes: [OnboardingAppearanceMode, string, string][] = [
		['system', localize('onboarding.appearance.mode.system', "System"), localize('onboarding.appearance.mode.system.detail', "Follow the operating system's light or dark setting, using the preferred themes below.")],
		['light', localize('onboarding.appearance.mode.light', "Light"), localize('onboarding.appearance.mode.light.detail', "Always use the preferred light theme.")],
		['dark', localize('onboarding.appearance.mode.dark', "Dark"), localize('onboarding.appearance.mode.dark.detail', "Always use the preferred dark theme.")],
	];
	return {
		kind: 'appearance',
		id: '',
		heading,
		lead: localize('onboarding.appearance.lead', "Choose whether Hucode follows your system, and which light and dark themes it uses. Each choice applies as you make it and is written to the Default profile, which the Omni shell uses."),
		// One note under the lead; the renderer draws it muted.
		paragraphs: [
			localize('onboarding.appearance.note', "Nothing you have already configured is removed, and only the values you change here are written. You can still import from another editor at any time with the Import Setup from Another Editor command in the Command Palette."),
		],
		modeGroupLabel: localize('onboarding.appearance.modeGroup', "Appearance mode"),
		modes: modes.map(([id, label, description]): EditorMigrationSetupRadioOption => ({
			id,
			label,
			description,
			checked: draft.mode === id,
			intent: { type: 'selectMode', mode: id },
		})),
		light: themeGroup(snapshot, draft, 'light'),
		dark: themeGroup(snapshot, draft, 'dark'),
	};
}

function themeGroup(snapshot: OnboardingAppearanceSnapshot, draft: OnboardingAppearanceDraft, scheme: OnboardingColorScheme): EditorMigrationSetupThemeGroup {
	return {
		label: scheme === 'light'
			? localize('onboarding.appearance.light', "Preferred light theme")
			: localize('onboarding.appearance.dark', "Preferred dark theme"),
		filterLabel: scheme === 'light'
			? localize('onboarding.appearance.light.filter', "Filter light themes")
			: localize('onboarding.appearance.dark.filter', "Filter dark themes"),
		listLabel: scheme === 'light'
			? localize('onboarding.appearance.light.list', "Light themes")
			: localize('onboarding.appearance.dark.list', "Dark themes"),
		noMatchText: localize('onboarding.appearance.noMatch', "Nothing matches the current filter."),
		selectedId: scheme === 'light' ? draft.preferredLight : draft.preferredDark,
		themes: onboardingThemesFor(snapshot, scheme).map(theme => ({ id: theme.id, label: theme.label })),
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
					action('add-project', localize('onboarding.addProject', "Add Project"), { type: 'addProject' }, 'default', state.busy),
					action('open-workbench', localize('onboarding.openFolderAsWorkbench', "Open Folder as Workbench"), { type: 'openFolderAsWorkbench' }, 'default', state.busy),
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
