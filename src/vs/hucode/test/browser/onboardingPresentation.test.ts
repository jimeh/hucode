/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { isEditorMigrationSetupPresentation } from '../../common/migration/editorMigrationSetupProtocol.js';
import { onboardingPresentation } from '../../browser/onboarding/onboardingPresentation.js';

suite('OnboardingPresentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** The wire-relevant shape: which route, which steps, which panel, and which intents the footer posts. */
	function shape(mode: 'first' | 'rerun') {
		const presentation = onboardingPresentation({ stage: 'bring', busy: false, mode, announcement: undefined }, 4);
		assert.strictEqual(isEditorMigrationSetupPresentation(presentation), true, 'the snapshot must pass the renderer validator');
		const panel = presentation.panels[0];
		return {
			revision: presentation.revision,
			route: presentation.route,
			phase: presentation.phase,
			steps: presentation.steps.map(step => [step.id, step.current]),
			sections: presentation.sections.length,
			scopeKey: presentation.scopeKey,
			panelKind: panel.kind,
			paragraphs: panel.kind === 'bring' ? panel.paragraphs.length : undefined,
			// The open command is not in the palette yet, so no copy may promise it.
			mentionsPalette: panel.kind === 'bring' ? /Command Palette/.test(panel.paragraphs.join(' ')) : undefined,
			mentionsRerun: panel.kind === 'bring' ? /already|earlier/i.test(panel.heading + panel.lead) : undefined,
			footer: presentation.footer.actions.map(action => [action.label, action.intent, action.disabled]),
		};
	}

	test('presents the bring stage with Skip and Do This Later on a first run', () => {
		assert.deepStrictEqual(shape('first'), {
			revision: 4,
			route: 'onboarding',
			phase: 'bring',
			steps: [['bring', true], ['review', false], ['meetOmni', false]],
			sections: 0,
			scopeKey: 'onboarding|bring|first',
			panelKind: 'bring',
			paragraphs: 2,
			mentionsRerun: false,
			mentionsPalette: false,
			footer: [['Skip', { type: 'skip' }, false], ['Do This Later', { type: 'close' }, false]],
		});
	});

	test('says onboarding already ended on a rerun and keeps both ways out', () => {
		assert.deepStrictEqual(shape('rerun'), {
			revision: 4,
			route: 'onboarding',
			phase: 'bring',
			steps: [['bring', true], ['review', false], ['meetOmni', false]],
			sections: 0,
			scopeKey: 'onboarding|bring|rerun',
			panelKind: 'bring',
			paragraphs: 1,
			mentionsRerun: true,
			mentionsPalette: false,
			footer: [['Skip', { type: 'skip' }, false], ['Do This Later', { type: 'close' }, false]],
		});
	});
});
