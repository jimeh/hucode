/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EditorMigrationEditorInput } from '../../electron-browser/migration/editorMigrationEditorInput.js';
import { bindEditorMigrationCloseCancellation } from '../../browser/migration/editorMigrationSetupClose.js';
import { EditorMigrationFlowState } from '../../browser/migration/editorMigrationFlow.js';
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

	test('fires the disposal signal the pane hangs Apply cancellation on', () => {
		// Escape and outside-click close the modal at the editor-part level, which closes the
		// editor and disposes this input. The pane binds cancellation to that event rather than to
		// `clearInput`, which also fires when the singleton is merely hidden.
		const input = new EditorMigrationEditorInput();
		const calls: string[] = [];
		const session = {
			state: { phase: 'apply' } as EditorMigrationFlowState,
			requestCancellation: () => calls.push('requestCancellation'),
		};
		const binding = bindEditorMigrationCloseCancellation(session, input.onWillDispose);

		input.dispose();

		assert.deepStrictEqual(calls, ['requestCancellation']);
		binding.dispose();
	});

	test('does not cancel a disposal that happens outside Apply', () => {
		const input = new EditorMigrationEditorInput();
		const calls: string[] = [];
		const binding = bindEditorMigrationCloseCancellation({
			state: { phase: 'review' } as EditorMigrationFlowState,
			requestCancellation: () => calls.push('requestCancellation'),
		}, input.onWillDispose);

		input.dispose();

		assert.deepStrictEqual(calls, []);
		binding.dispose();
	});
});
