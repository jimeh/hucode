/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { getHucodeApplicationVersion } from '../../common/hucodeProductVersion.js';

suite('HucodeProductVersion', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns the Hucode release version when present', () => {
		assert.strictEqual(getHucodeApplicationVersion({
			hucodeVersion: '0.0.24',
			version: '1.123.0',
		}), '0.0.24');
	});

	test('falls back to the VS Code version for upstream products', () => {
		assert.strictEqual(getHucodeApplicationVersion({
			version: '1.123.0',
		}), '1.123.0');
	});
});
