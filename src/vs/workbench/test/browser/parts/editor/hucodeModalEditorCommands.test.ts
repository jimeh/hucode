/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { EditorPartModalContext, IsOmniWindowContext } from '../../../../common/contextkeys.js';
import { ModalEditorCanMoveToMainContext } from '../../../../browser/parts/editor/editorCommands.js';

suite('Hucode Modal Editor Commands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('allows moving a modal to the main editor only outside the Omni shell', () => {
		const evaluate = (modal: boolean, omni: boolean) => ModalEditorCanMoveToMainContext.evaluate({
			getValue: key => ({
				[EditorPartModalContext.key]: modal,
				[IsOmniWindowContext.key]: omni,
			})[key],
		} as IContext);

		assert.strictEqual(evaluate(true, false), true);
		assert.strictEqual(evaluate(true, true), false);
		assert.strictEqual(evaluate(false, false), false);
	});
});
