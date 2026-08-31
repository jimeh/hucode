/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EditorMigrationEditorInput } from '../../electron-browser/migration/editorMigrationEditorInput.js';
import { EditorInputCapabilities } from '../../../workbench/common/editor.js';

suite('EditorMigrationEditorInput', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('is a non-resource singleton that requires the modal editor', () => {
		const first = disposables.add(new EditorMigrationEditorInput());
		const second = disposables.add(new EditorMigrationEditorInput());

		assert.deepStrictEqual({
			typeId: first.typeId,
			resource: first.resource,
			singleton: first.hasCapability(EditorInputCapabilities.Singleton),
			requiresModal: first.hasCapability(EditorInputCapabilities.RequiresModal),
			matches: first.matches(second),
		}, {
			typeId: EditorMigrationEditorInput.ID,
			resource: undefined,
			singleton: true,
			requiresModal: true,
			matches: true,
		});
	});
});
