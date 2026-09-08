/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EditorInput } from '../../../workbench/common/editor/editorInput.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { EditorMigrationEditorInput } from '../../electron-browser/migration/editorMigrationEditorInput.js';
import { OnboardingEditorInput } from '../../electron-browser/onboarding/onboardingEditorInput.js';
import { openSetupModalEditor } from '../../electron-browser/setupModalEditors.js';

suite('openSetupModalEditor', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/** Stands in for the editor service: an open registers its input only once it settles. */
	function editorServiceStub() {
		const editors: EditorInput[] = [];
		const opened: EditorInput[] = [];
		const pending: DeferredPromise<void>[] = [];
		const service = {
			get editors() { return editors; },
			openEditor(editor: EditorInput) {
				opened.push(editor);
				const settle = new DeferredPromise<void>();
				pending.push(settle);
				return settle.p.then(() => {
					if (!editors.includes(editor)) {
						editors.push(editor);
					}
					return undefined;
				});
			},
		} as unknown as IEditorService;
		return { service, opened, pending };
	}

	test('a second command during an open in flight reveals the first input instead of creating another', async () => {
		const { service, opened, pending } = editorServiceStub();
		const created: EditorInput[] = [];
		const create = (input: EditorInput) => () => { created.push(input); return input; };
		const onboarding = disposables.add(new OnboardingEditorInput());
		const migration = disposables.add(new EditorMigrationEditorInput());

		const first = openSetupModalEditor(service, create(onboarding));
		const second = openSetupModalEditor(service, create(migration));
		await Promise.resolve();
		assert.deepStrictEqual(opened, [onboarding], 'the second open waits');
		pending[0].complete();
		await first;
		await Promise.resolve();
		pending[1]?.complete();
		await second;

		assert.deepStrictEqual({ created, opened }, { created: [onboarding], opened: [onboarding, onboarding] });
	});
});
