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
			// The open command is not in the palette yet, so no copy may promise it.
			mentionsPalette: panel.kind === 'bring' ? /Command Palette/.test(panel.paragraphs.join(' ')) : undefined,
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
			mentionsPalette: false,
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

	test('presents the appearance placeholder with Back and Continue', () => {
		assert.deepStrictEqual(shape(onboardingPresentation(state({ stage: 'appearance', route: 'skipImport' }), 3)), {
			revision: 3,
			route: 'onboarding',
			phase: 'appearance',
			title: 'Welcome to Hucode',
			steps: [['bring', true], ['review', false], ['meetOmni', false]],
			sections: 0,
			scopeKey: 'onboarding|appearance|first',
			panelKind: 'message',
			heading: 'Choose How Hucode Looks',
			choices: undefined,
			paragraphs: undefined,
			mentionsPalette: undefined,
			footer: [['Back', { type: 'back' }, false], ['Continue', { type: 'continueStage' }, false]],
		});
	});

	test('presents the Meet Omni placeholder with Back only on the Skip Import route', () => {
		const skipImport = shape(onboardingPresentation(state({ stage: 'meetOmni', route: 'skipImport' }), 5));
		const migrate = shape(onboardingPresentation(state({ stage: 'meetOmni', route: 'migrate' }), 5));
		assert.deepStrictEqual({ skipImport, migrateFooter: migrate.footer }, {
			skipImport: {
				revision: 5,
				route: 'onboarding',
				phase: 'meetOmni',
				title: 'Welcome to Hucode',
				steps: [['bring', false], ['review', false], ['meetOmni', true]],
				sections: 0,
				scopeKey: 'onboarding|meetOmni|first',
				panelKind: 'message',
				heading: 'Meet Omni',
				choices: undefined,
				paragraphs: undefined,
				mentionsPalette: undefined,
				footer: [['Back', { type: 'back' }, false], ['Finish for Now', { type: 'finishForNow' }, false]],
			},
			migrateFooter: [['Finish for Now', { type: 'finishForNow' }, false]],
		});
	});
});

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
