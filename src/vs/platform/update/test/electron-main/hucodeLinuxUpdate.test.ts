/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getHucodeLinuxUpdateAction } from '../../electron-main/hucodeLinuxUpdate.js';

suite('Hucode Linux update action', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('opens the release page instead of a package-specific update URL', () => {
		assert.deepStrictEqual(
			getHucodeLinuxUpdateAction(
				'https://github.com/jimeh/hucode/releases/latest',
				'https://example.invalid/hucode-linux-x64.zip'
			),
			{
				kind: 'openExternal',
				url: 'https://github.com/jimeh/hucode/releases/latest'
			}
		);
	});

	test('falls back to the update URL for products without a download page', () => {
		assert.deepStrictEqual(
			getHucodeLinuxUpdateAction(undefined, 'https://example.invalid/update'),
			{ kind: 'openExternal', url: 'https://example.invalid/update' }
		);
	});

	test('does nothing when no manual update destination is available', () => {
		assert.strictEqual(getHucodeLinuxUpdateAction(' ', undefined), undefined);
	});
});
