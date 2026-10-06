/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { fromNow } from '../../../base/common/date.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EditorMigrationSetupIntent, EditorMigrationSetupPresentation, isEditorMigrationSetupPresentation } from '../../common/migration/editorMigrationSetupProtocol.js';
import { EditorMigrationFlowState } from '../../browser/migration/editorMigrationFlow.js';
import { editorMigrationSetupPresentation } from '../../browser/migration/editorMigrationSetupPresentation.js';
import { OnboardingAppearanceSnapshot } from '../../browser/onboarding/onboardingAppearance.js';
import { OnboardingOmniSnapshot } from '../../browser/onboarding/onboardingOmni.js';
import { onboardingPresentation } from '../../browser/onboarding/onboardingPresentation.js';
import { OnboardingSessionState } from '../../browser/onboarding/onboardingSession.js';
import { EditorMigrationOperation } from '../../common/migration/editorMigrationApply.js';

suite('OnboardingPresentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function state(overrides: Partial<OnboardingSessionState>): OnboardingSessionState {
		return { stage: 'bring', busy: false, mode: 'first', ...overrides };
	}

	/** The wire-relevant shape: which route, which steps, which panel, and which intents the footer posts. */
	function shape(presentation: EditorMigrationSetupPresentation) {
		assert.strictEqual(isEditorMigrationSetupPresentation(presentation), true, 'the snapshot must pass the renderer validator');
		const panel = presentation.panels[0];
		return {
			revision: presentation.revision,
			route: presentation.route,
			phase: presentation.phase,
			title: presentation.title,
			steps: presentation.steps.map(step => [step.id, step.current]),
			sections: presentation.sections.length,
			scopeKey: presentation.scopeKey,
			panelKind: panel.kind,
			heading: panel.heading,
			choices: panel.kind === 'bring' ? panel.choices.map(choice => [choice.id, choice.label]) : undefined,
			paragraphs: panel.kind === 'bring' ? panel.paragraphs.length : undefined,
			// The open command is in the palette, and the Do This Later copy says so.
			mentionsPalette: panel.kind === 'bring' ? /Hucode: Open Onboarding.*Command Palette/.test(panel.paragraphs.join(' ')) : undefined,
			footer: presentation.footer.actions.map(action => [action.label, action.intent, action.disabled]),
		};
	}

	test('presents the bring stage with both routes, Skip, and Do This Later on a first run', () => {
		assert.deepStrictEqual(shape(onboardingPresentation(state({}), 4)), {
			revision: 4,
			route: 'onboarding',
			phase: 'bring',
			title: 'Welcome to Hucode',
			steps: [['bring', true], ['review', false], ['meetOmni', false]],
			sections: 0,
			scopeKey: 'onboarding|bring|first',
			panelKind: 'bring',
			heading: 'Bring Your Setup to Hucode',
			choices: [['migrate', 'Import from Another Editor'], ['skipImport', 'Skip Import']],
			paragraphs: 1,
			mentionsPalette: true,
			footer: [['Skip', { type: 'skip' }, false], ['Do This Later', { type: 'close' }, false]],
		});
	});

	test('summarizes the earlier outcome from the record on a rerun and labels the import as new', () => {
		const completedAt = Date.now() - 3 * 24 * 60 * 60 * 1000;
		const lead = (previous: OnboardingSessionState['previous']) => {
			const panel = onboardingPresentation(state({ mode: 'rerun', previous }), 1).panels[0];
			return panel.kind === 'bring' ? panel.lead : undefined;
		};
		assert.deepStrictEqual({
			shape: shape(onboardingPresentation(state({ mode: 'rerun', previous: { status: 'completed', route: 'migrate', completedAt } }), 4)),
			migrate: lead({ status: 'completed', route: 'migrate', completedAt }),
			skipImport: lead({ status: 'completed', route: 'skipImport', completedAt }),
			undated: lead({ status: 'completed', route: 'skipImport' }),
			skipped: lead({ status: 'skipped' }),
			superseded: lead({ status: 'superseded' }),
		}, {
			shape: {
				revision: 4,
				route: 'onboarding',
				phase: 'bring',
				title: 'Welcome to Hucode',
				steps: [['bring', true], ['review', false], ['meetOmni', false]],
				sections: 0,
				scopeKey: 'onboarding|bring|rerun',
				panelKind: 'bring',
				heading: 'Onboarding Is Already Complete',
				choices: [['migrate', 'Start a New Import'], ['skipImport', 'Skip Import']],
				paragraphs: 1,
				mentionsPalette: false,
				footer: [['Skip', { type: 'skip' }, false], ['Do This Later', { type: 'close' }, false]],
			},
			migrate: `You completed onboarding ${fromNow(completedAt, true, true)} and imported a setup from another editor. Reopening it changes nothing on its own.`,
			skipImport: `You completed onboarding ${fromNow(completedAt, true, true)} without importing from another editor. Reopening it changes nothing on its own.`,
			undated: 'You completed onboarding earlier without importing from another editor. Reopening it changes nothing on its own.',
			skipped: 'You skipped onboarding earlier. Reopening it changes nothing on its own.',
			superseded: 'A newer version of Hucode recorded this installation\'s onboarding. Reopening it changes nothing on its own.',
		});
	});

	test('lays onboarding over the embedded migration and prepends Back while no source is chosen', () => {
		const flow = flowState({ phase: 'application', applications: [{ id: 'cursor', productName: 'Cursor', channel: 'stable', profiles: [] }] });
		const migration = editorMigrationSetupPresentation(flow, 7);
		const presentation = onboardingPresentation(state({ stage: 'migrate', route: 'migrate' }), 7, embedded(flow, migration));

		assert.deepStrictEqual({
			...shape(presentation),
			regionLabel: presentation.regionLabel,
			lines: presentation.footer.lines,
			// Everything the migration mapper produced for its own screen is passed through untouched.
			panels: presentation.panels === migration.panels,
			sectionsSame: presentation.sections === migration.sections,
			announcement: presentation.announcement === migration.announcement,
			busy: presentation.busy === migration.busy,
			error: presentation.error === migration.error,
		}, {
			revision: 7,
			route: 'onboarding',
			phase: 'application',
			title: 'Welcome to Hucode',
			regionLabel: 'Hucode Onboarding',
			steps: [['bring', true], ['review', false], ['meetOmni', false]],
			sections: 0,
			scopeKey: `onboarding|migrate|${migration.scopeKey}`,
			panelKind: 'applications',
			heading: 'Which Application Should Hucode Import From?',
			choices: undefined,
			paragraphs: undefined,
			mentionsPalette: undefined,
			footer: [['Back', { type: 'back' }, false], ['Refresh', { type: 'refreshDiscovery' }, false]],
			lines: ['1 application found.'],
			panels: true,
			sectionsSame: true,
			announcement: true,
			busy: true,
			error: true,
		});
	});

	test('marks Review current for the later migration phases and leaves their footer alone', () => {
		const migration = editorMigrationSetupPresentation(flowState({ phase: 'review' }), 2);
		const presentation = onboardingPresentation(state({ stage: 'migrate', route: 'migrate' }), 2, embedded(flowState({ phase: 'review' }), migration));

		assert.deepStrictEqual({
			phase: presentation.phase,
			steps: presentation.steps.map(step => [step.id, step.current]),
			footer: presentation.footer === migration.footer,
			scopeKey: presentation.scopeKey,
		}, {
			phase: 'review',
			steps: [['bring', false], ['review', true], ['meetOmni', false]],
			footer: true,
			scopeKey: `onboarding|migrate|${migration.scopeKey}`,
		});
		const phaseSteps = Object.fromEntries((['loading', 'recovery', 'application', 'profile', 'target', 'review', 'publishers', 'apply', 'results'] as const).map(phase => {
			const wrapped = onboardingPresentation(state({ stage: 'migrate', route: 'migrate' }), 1, embedded(flowState({ phase })));
			return [phase, [wrapped.steps.find(step => step.current)?.id, wrapped.footer.actions[0]?.intent.type === 'back']];
		}));
		assert.deepStrictEqual(phaseSteps, {
			loading: ['bring', true],
			recovery: ['bring', true],
			application: ['bring', true],
			profile: ['bring', true],
			target: ['bring', true],
			review: ['review', true],
			publishers: ['review', true],
			apply: ['review', false],
			results: ['review', false],
		});
		// Profile through Publishers offer the migration's own Back; only the first three are onboarding's.
		const profile = onboardingPresentation(state({ stage: 'migrate', route: 'migrate' }), 1, embedded(flowState({ phase: 'profile' })));
		assert.strictEqual(profile.footer.actions.filter(action => action.intent.type === 'back').length, 1);
	});

	test('replaces the embedded Results footer with Continue, keeping the report, retries, and recovery data', () => {
		// The standalone footer, as `editorMigrationSetupPresentation` composes it for a concluded
		// operation, a failed item, and an operation still running; its own suite covers that mapping.
		const standalone = (...intents: EditorMigrationSetupIntent[]): EditorMigrationSetupPresentation['footer'] => ({
			lines: ['Import completed', 'Removing recovery data deletes the retained snapshots used for file rollback.'],
			actions: intents.map(intent => ({ id: `results-${intent.type}`, label: intent.type, kind: 'default', disabled: false, intent })),
		});
		const concluded = standalone({ type: 'copyReport' }, { type: 'startImport' }, { type: 'close' }, { type: 'acknowledge' });
		const withRetry = standalone({ type: 'copyReport' }, { type: 'startImport' }, { type: 'retry', operationId: 'operation' }, { type: 'close' }, { type: 'acknowledge' });
		const running = standalone({ type: 'copyReport' }, { type: 'startImport' }, { type: 'resume', operationId: 'operation' });
		const footer = (flow: EditorMigrationFlowState, footer: EditorMigrationSetupPresentation['footer']) => {
			const results: EditorMigrationSetupPresentation = { ...editorMigrationSetupPresentation(flowState({ phase: 'loading' }), 1), phase: 'results', footer };
			const presentation = onboardingPresentation(state({ stage: 'migrate', route: 'migrate' }), 1, embedded(flow, results));
			assert.strictEqual(isEditorMigrationSetupPresentation(presentation), true);
			return { lines: presentation.footer.lines, actions: presentation.footer.actions.map(action => [action.id, action.label, action.kind, action.intent]) };
		};
		const settled = concludedOperation();
		const restored: EditorMigrationOperation = { ...settled, stage: 'rolledBack', aggregateOutcome: 'rolledBack', rollbackIntent: { mutationStarted: true } as EditorMigrationOperation['rollbackIntent'] };
		const admitted: EditorMigrationOperation = { ...settled, stage: 'admitted', aggregateOutcome: undefined };
		assert.deepStrictEqual({
			concluded: footer(flowState({ phase: 'results', operation: settled }), concluded),
			withRetry: footer(flowState({ phase: 'results', operation: settled }), withRetry).actions.map(action => action[0]),
			restored: footer(flowState({ phase: 'results', operation: restored }), concluded).lines,
			// An operation still running offers Resume and no way out, as the standalone screen does.
			admitted: footer(flowState({ phase: 'results', operation: admitted }), running),
			busy: footer(flowState({ phase: 'results', operation: settled, busy: true }), concluded).actions.map(action => action[0]),
			canceling: footer(flowState({ phase: 'results', operation: settled, canceling: true }), concluded).actions.map(action => action[0]),
			noOperation: footer(flowState({ phase: 'results' }), standalone()),
		}, {
			concluded: {
				// The migration's outcome line is rebuilt from the operation; the sentence about
				// removing recovery data went with the button that removed it.
				lines: ['Import completed', 'Recovery data stays available from the Import Setup from Another Editor command.'],
				actions: [
					['results-copyReport', 'copyReport', 'default', { type: 'copyReport' }],
					['results-continue', 'Continue', 'primary', { type: 'continueStage' }],
				],
			},
			withRetry: ['results-copyReport', 'results-retry', 'results-continue'],
			restored: [
				'File changes were restored',
				'Forward import retry is unavailable because file restoration already began.',
				'Recovery data stays available from the Import Setup from Another Editor command.',
			],
			admitted: {
				lines: ['Preparing the import', 'Recovery data stays available from the Import Setup from Another Editor command.'],
				actions: [
					['results-copyReport', 'copyReport', 'default', { type: 'copyReport' }],
					['results-resume', 'resume', 'default', { type: 'resume', operationId: 'operation' }],
				],
			},
			busy: ['results-copyReport'],
			canceling: ['results-copyReport'],
			noOperation: { lines: standalone().lines, actions: [] },
		});
	});

	test('presents the appearance choices prefilled from the draft, with Back and Continue', () => {
		const presentation = onboardingPresentation(state({
			stage: 'appearance',
			route: 'skipImport',
			appearance: appearanceSnapshot(),
			appearanceDraft: { mode: 'light', preferredLight: 'Quiet Light', preferredDark: 'Dark 2026' },
		}), 3);
		const panel = presentation.panels[0];
		assert.strictEqual(panel.kind, 'appearance');
		assert.deepStrictEqual({
			...shape(presentation),
			lead: panel.lead,
			// The plan's copy promises: where the values go, that nothing is removed, and that the
			// import command stays available; the last two share one note under the lead.
			copy: [/Default profile/.test(panel.lead), /removed/.test(panel.paragraphs.join(' ')), /Import Setup from Another Editor.*Command Palette/.test(panel.paragraphs.join(' ')), panel.paragraphs.length],
			modeGroupLabel: panel.modeGroupLabel,
			modes: panel.modes.map(mode => [mode.id, mode.label, mode.checked, mode.intent]),
			light: [panel.light.label, panel.light.filterLabel, panel.light.listLabel, panel.light.selectedId, panel.light.themes.map(theme => theme.id)],
			dark: [panel.dark.label, panel.dark.filterLabel, panel.dark.listLabel, panel.dark.selectedId, panel.dark.themes.map(theme => theme.id)],
			noMatch: [panel.light.noMatchText, panel.dark.noMatchText],
		}, {
			revision: 3,
			route: 'onboarding',
			phase: 'appearance',
			title: 'Welcome to Hucode',
			steps: [['bring', false], ['review', true], ['meetOmni', false]],
			sections: 0,
			scopeKey: 'onboarding|appearance|first',
			panelKind: 'appearance',
			heading: 'Choose How Hucode Looks',
			choices: undefined,
			paragraphs: undefined,
			mentionsPalette: undefined,
			footer: [['Back', { type: 'back' }, false], ['Continue', { type: 'continueStage' }, false]],
			lead: 'Choose whether Hucode follows your system, and which light and dark themes it uses. Each choice applies as you make it and is written to the Default profile, which the Omni shell uses.',
			copy: [true, true, true, 1],
			modeGroupLabel: 'Appearance mode',
			modes: [
				['system', 'System', false, { type: 'selectMode', mode: 'system' }],
				['light', 'Light', true, { type: 'selectMode', mode: 'light' }],
				['dark', 'Dark', false, { type: 'selectMode', mode: 'dark' }],
			],
			light: ['Preferred light theme', 'Filter light themes', 'Light themes', 'Quiet Light', ['Light 2026', 'Quiet Light']],
			dark: ['Preferred dark theme', 'Filter dark themes', 'Dark themes', 'Dark 2026', ['Dark 2026', 'Monokai']],
			noMatch: ['Nothing matches the current filter.', 'Nothing matches the current filter.'],
		});
	});

	test('presents appearance as loading while its snapshot is pending and as passable after a failed load', () => {
		const loading = onboardingPresentation(state({ stage: 'appearance', route: 'skipImport', busy: true }), 4);
		const failed = onboardingPresentation(state({ stage: 'appearance', route: 'skipImport', error: 'theme registry unavailable', announcement: 'theme registry unavailable' }), 5);
		const panelText = (panel: EditorMigrationSetupPresentation['panels'][number]) => panel.kind === 'loading' ? panel.progress.text : panel.kind === 'message' ? panel.lead : undefined;
		assert.deepStrictEqual({
			loading: { ...shape(loading), busy: loading.busy, error: loading.error, text: panelText(loading.panels[0]) },
			failed: { ...shape(failed), busy: failed.busy, error: failed.error, announcement: failed.announcement, text: panelText(failed.panels[0]) },
		}, {
			loading: {
				revision: 4,
				route: 'onboarding',
				phase: 'appearance',
				title: 'Welcome to Hucode',
				steps: [['bring', false], ['review', true], ['meetOmni', false]],
				sections: 0,
				scopeKey: 'onboarding|appearance|first',
				panelKind: 'loading',
				heading: 'Reading Installed Themes...',
				choices: undefined,
				paragraphs: undefined,
				mentionsPalette: undefined,
				footer: [['Back', { type: 'back' }, false], ['Continue', { type: 'continueStage' }, true]],
				busy: true,
				error: undefined,
				text: 'Looking up the current appearance and the installed color themes.',
			},
			failed: {
				revision: 5,
				route: 'onboarding',
				phase: 'appearance',
				title: 'Welcome to Hucode',
				steps: [['bring', false], ['review', true], ['meetOmni', false]],
				sections: 0,
				scopeKey: 'onboarding|appearance|first',
				panelKind: 'message',
				heading: 'Choose How Hucode Looks',
				choices: undefined,
				paragraphs: undefined,
				mentionsPalette: undefined,
				footer: [['Back', { type: 'back' }, false], ['Continue', { type: 'continueStage' }, false]],
				busy: false,
				error: 'theme registry unavailable',
				announcement: 'theme registry unavailable',
				text: 'Hucode could not read the installed themes, so the appearance choices are unavailable. Continue keeps your current appearance unchanged.',
			},
		});
	});

	test('presents Meet Omni with the three finishes, and Back only on the Skip Import route', () => {
		const skipImport = shape(onboardingPresentation(state({ stage: 'meetOmni', route: 'skipImport', omni: omniSnapshot() }), 5));
		const migrate = shape(onboardingPresentation(state({ stage: 'meetOmni', route: 'migrate', omni: omniSnapshot() }), 5));
		const busy = shape(onboardingPresentation(state({ stage: 'meetOmni', route: 'migrate', omni: omniSnapshot(), busy: true }), 5));
		assert.deepStrictEqual({ skipImport, migrateFooter: migrate.footer, busyFooter: busy.footer }, {
			skipImport: {
				revision: 5,
				route: 'onboarding',
				phase: 'meetOmni',
				title: 'Welcome to Hucode',
				steps: [['bring', false], ['review', false], ['meetOmni', true]],
				sections: 0,
				scopeKey: 'onboarding|meetOmni|first',
				panelKind: 'meetOmni',
				heading: 'Meet Omni',
				choices: undefined,
				paragraphs: undefined,
				mentionsPalette: undefined,
				footer: [
					['Back', { type: 'back' }, false],
					['Add Project', { type: 'addProject' }, false],
					['Open Folder as Workbench', { type: 'openFolderAsWorkbench' }, false],
					['Finish', { type: 'finishForNow' }, false],
				],
			},
			migrateFooter: [
				['Add Project', { type: 'addProject' }, false],
				['Open Folder as Workbench', { type: 'openFolderAsWorkbench' }, false],
				['Finish', { type: 'finishForNow' }, false],
			],
			// Back stays usable while the session works; the finishes wait for it.
			busyFooter: [
				['Add Project', { type: 'addProject' }, true],
				['Open Folder as Workbench', { type: 'openFolderAsWorkbench' }, true],
				['Finish', { type: 'finishForNow' }, true],
			],
		});
	});

	test('presents Meet Omni as the three nouns and the shortcuts the host resolved', () => {
		const panel = onboardingPresentation(state({ stage: 'meetOmni', route: 'skipImport', omni: omniSnapshot() }), 1).panels[0];
		assert.strictEqual(panel.kind, 'meetOmni');
		assert.deepStrictEqual({
			glossary: panel.glossary.map(entry => entry.term),
			definitionsNonEmpty: panel.glossary.every(entry => entry.definition.length > 0),
			shortcuts: panel.shortcuts,
			noOmni: (onboardingPresentation(state({ stage: 'meetOmni', route: 'skipImport' }), 1).panels[0] as typeof panel).shortcuts,
		}, {
			glossary: ['Project', 'Worktree', 'Workbench'],
			definitionsNonEmpty: true,
			shortcuts: [
				{ label: 'Switch Workbench', keybinding: '⌘O', keybindingAriaLabel: 'Command+O' },
				{ label: 'Quick Switch Loaded Workbench', noShortcutText: 'No keyboard shortcut is assigned. Use the Command Palette.' },
			],
			noOmni: [],
		});
	});
});

/** The embedded migration as the presenter hands it over: its state beside its own snapshot. */
function embedded(flow: EditorMigrationFlowState, presentation = editorMigrationSetupPresentation(flow, 1)) {
	return { flow, presentation };
}

/** A settled operation with only what the Results screen reads. */
function concludedOperation(): EditorMigrationOperation {
	return {
		id: 'operation',
		stage: 'settled',
		aggregateOutcome: 'completed',
		results: [{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 }],
		snapshots: [],
		extensionInstallIntents: [],
		plan: { operations: [], choices: { selectedCategories: ['settings'], decisions: [] } },
	} as unknown as EditorMigrationOperation;
}

function omniSnapshot(): OnboardingOmniSnapshot {
	return {
		shortcuts: [
			{ commandId: 'hucode.projectSwitcher.switchWorktree', label: 'Switch Workbench', keybinding: { label: '⌘O', ariaLabel: 'Command+O' } },
			{ commandId: 'hucode.projectSwitcher.quickSwitchLoadedWorktree', label: 'Quick Switch Loaded Workbench' },
		],
	};
}

function appearanceSnapshot(): OnboardingAppearanceSnapshot {
	return {
		mode: 'dark',
		colorTheme: 'Dark 2026',
		preferredLight: 'Light 2026',
		preferredDark: 'Dark 2026',
		lightThemes: [{ id: 'Light 2026', label: 'Light 2026' }, { id: 'Quiet Light', label: 'Quiet Light' }],
		darkThemes: [{ id: 'Dark 2026', label: 'Dark 2026' }, { id: 'Monokai', label: 'Monokai' }],
	};
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
