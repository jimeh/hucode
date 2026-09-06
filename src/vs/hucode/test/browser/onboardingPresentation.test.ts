/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { fromNow } from '../../../base/common/date.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EditorMigrationSetupPresentation, isEditorMigrationSetupPresentation } from '../../common/migration/editorMigrationSetupProtocol.js';
import { EditorMigrationFlowState } from '../../browser/migration/editorMigrationFlow.js';
import { editorMigrationSetupPresentation } from '../../browser/migration/editorMigrationSetupPresentation.js';
import { OnboardingAppearanceSnapshot } from '../../browser/onboarding/onboardingAppearance.js';
import { OnboardingOmniSnapshot } from '../../browser/onboarding/onboardingOmni.js';
import { onboardingPresentation } from '../../browser/onboarding/onboardingPresentation.js';
import { OnboardingSessionState } from '../../browser/onboarding/onboardingSession.js';

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
		const migration = editorMigrationSetupPresentation(flowState({ phase: 'application', applications: [{ id: 'cursor', productName: 'Cursor', channel: 'stable', profiles: [] }] }), 7);
		const presentation = onboardingPresentation(state({ stage: 'migrate', route: 'migrate' }), 7, migration);

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
		const presentation = onboardingPresentation(state({ stage: 'migrate', route: 'migrate' }), 2, migration);

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
			const embedded = onboardingPresentation(state({ stage: 'migrate', route: 'migrate' }), 1, editorMigrationSetupPresentation(flowState({ phase }), 1));
			return [phase, [embedded.steps.find(step => step.current)?.id, embedded.footer.actions[0]?.intent.type === 'back']];
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
		const profile = onboardingPresentation(state({ stage: 'migrate', route: 'migrate' }), 1, editorMigrationSetupPresentation(flowState({ phase: 'profile' }), 1));
		assert.strictEqual(profile.footer.actions.filter(action => action.intent.type === 'back').length, 1);
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
			// import command stays available.
			copy: [/Default profile/.test(panel.lead), /removed/.test(panel.paragraphs.join(' ')), /Command Palette/.test(panel.paragraphs.join(' '))],
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
			lead: 'Choose whether Hucode follows your system, and which light and dark themes it uses. These values are written to the Default profile, which the Omni shell uses.',
			copy: [true, true, true],
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
		const skipImport = shape(onboardingPresentation(state({ stage: 'meetOmni', route: 'skipImport', omni: omniSnapshot(false) }), 5));
		const migrate = shape(onboardingPresentation(state({ stage: 'meetOmni', route: 'migrate', omni: omniSnapshot(false) }), 5));
		const busy = shape(onboardingPresentation(state({ stage: 'meetOmni', route: 'migrate', omni: omniSnapshot(false), busy: true }), 5));
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
					['Finish for Now', { type: 'finishForNow' }, false],
				],
			},
			migrateFooter: [
				['Add Project', { type: 'addProject' }, false],
				['Open Folder as Workbench', { type: 'openFolderAsWorkbench' }, false],
				['Finish for Now', { type: 'finishForNow' }, false],
			],
			// Back stays usable during the density write; the finishes wait for it.
			busyFooter: [
				['Add Project', { type: 'addProject' }, true],
				['Open Folder as Workbench', { type: 'openFolderAsWorkbench' }, true],
				['Finish for Now', { type: 'finishForNow' }, true],
			],
		});
	});

	test('previews the Projects list through the shared row model at the staged density', () => {
		const panel = (density: 'default' | 'compact' | undefined) => {
			const result = onboardingPresentation(state({ stage: 'meetOmni', route: 'skipImport', omni: omniSnapshot(true), density }), 1).panels[0];
			assert.strictEqual(result.kind, 'meetOmni');
			return result;
		};
		const byDefault = panel('default');
		const compact = panel('compact');
		const rows = (result: typeof byDefault) => result.preview.rows.map(row => [row.kind, row.name, row.branch, row.path]);
		assert.deepStrictEqual({
			glossary: byDefault.glossary.map(entry => entry.term),
			definitionsNonEmpty: byDefault.glossary.every(entry => entry.definition.length > 0),
			previewLabel: byDefault.preview.label,
			defaultRows: rows(byDefault),
			compactRows: rows(compact),
			defaultView: [byDefault.preview.layout, byDefault.preview.densityLabel, byDefault.densityToggle.checked, byDefault.densityToggle.intent],
			compactView: [compact.preview.layout, compact.preview.densityLabel, compact.densityToggle.checked, compact.densityToggle.intent],
			toggleLabel: byDefault.densityToggle.label,
			// With no draft yet the snapshot's density is what shows.
			unseeded: panel(undefined).preview.layout,
			shortcuts: byDefault.shortcuts,
		}, {
			glossary: ['Project', 'Worktree', 'Workbench', 'Loaded', 'Dormant', 'Suspend', 'Unload'],
			definitionsNonEmpty: true,
			previewLabel: 'Example Projects list',
			// Two-line rows keep every field; the project row has no path of its own.
			defaultRows: [
				['project', 'hucode', '~/Projects', undefined],
				['worktree', 'local', 'main', '~/Projects/hucode'],
				['worktree', 'login-form', 'feature/login-form', '~/Projects/hucode.worktrees/login-form'],
				['workbench', 'notes', 'main', '~/Documents/notes'],
			],
			// Compact worktree rows drop the path and compact workbench rows drop the branch,
			// exactly as `getProjectSwitcherPresentationFields` decides for the sidebar.
			compactRows: [
				['project', 'hucode', '~/Projects', undefined],
				['worktree', 'local', 'main', undefined],
				['worktree', 'login-form', 'feature/login-form', undefined],
				['workbench', 'notes', undefined, '~/Documents/notes'],
			],
			defaultView: ['default', 'Showing default lists.', false, { type: 'setDensity', density: 'compact' }],
			compactView: ['compact', 'Showing compact lists.', true, { type: 'setDensity', density: 'default' }],
			toggleLabel: 'Use compact worktree and workbench lists',
			unseeded: 'compact',
			shortcuts: [
				{ label: 'Switch Workbench', keybinding: '⌘O', keybindingAriaLabel: 'Command+O' },
				{ label: 'Quick Switch Loaded Workbench', noShortcutText: 'No keyboard shortcut is assigned. Use the Command Palette.' },
			],
		});
	});
});

function omniSnapshot(compact: boolean): OnboardingOmniSnapshot {
	return {
		density: compact ? 'compact' : 'default',
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
