/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope } from '../../../platform/storage/common/storage.js';
import { EditorInputCapabilities } from '../../../workbench/common/editor.js';
import { OnboardingSession } from '../../browser/onboarding/onboardingSession.js';
import { ONBOARDING_STATE_STORAGE_KEY, OnboardingStateStore } from '../../browser/onboarding/onboardingStateStore.js';
import { EditorMigrationEditorInput } from '../../electron-browser/migration/editorMigrationEditorInput.js';
import { OnboardingEditorInput } from '../../electron-browser/onboarding/onboardingEditorInput.js';
import { isHucodeSetupEditorInput } from '../../electron-browser/setupModalEditors.js';

suite('OnboardingEditorInput', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('is a non-resource singleton modal input that owns its header', () => {
		const first = disposables.add(new OnboardingEditorInput());
		const second = disposables.add(new OnboardingEditorInput());
		const importInput = disposables.add(new EditorMigrationEditorInput());

		assert.deepStrictEqual({
			typeId: first.typeId,
			resource: first.resource,
			singleton: first.hasCapability(EditorInputCapabilities.Singleton),
			requiresModal: first.hasCapability(EditorInputCapabilities.RequiresModal),
			matchesOther: first.matches(second),
			matchesImport: first.matches(importInput),
			modalOptions: first.getModalEditorOptions(),
			exclusive: [isHucodeSetupEditorInput(first), isHucodeSetupEditorInput(importInput)],
		}, {
			typeId: 'workbench.input.hucodeOnboarding',
			resource: undefined,
			singleton: true,
			requiresModal: true,
			matchesOther: true,
			matchesImport: false,
			modalOptions: { compactHeader: true },
			exclusive: [true, true],
		});
	});

	test('records the dismissal and disposes the session when the input closes', () => {
		// Escape and outside-click close the modal at the editor-part level, which disposes this
		// input. The dismissal hangs off that event rather than `clearInput`, which also fires when
		// the singleton is merely hidden. The session is not added to the suite's disposables on
		// purpose: the leak tracker proves the input disposed it.
		const storage = disposables.add(new InMemoryStorageService());
		const session = new OnboardingSession(new OnboardingStateStore(storage));
		session.initialize();
		const input = new OnboardingEditorInput();
		input.attachSession(session);
		assert.strictEqual(input.session, session, 'hide-then-reshow presents the same session');
		assert.throws(() => input.attachSession(session), /already owns/);

		input.dispose();

		assert.deepStrictEqual(JSON.parse(storage.get(ONBOARDING_STATE_STORAGE_KEY, StorageScope.APPLICATION)!), { version: 1, status: 'inProgress', stage: 'bring' });
	});
});
