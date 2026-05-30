/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { getHucodeDefaultStartupWindowPath } from
	'../../electron-main/omniStartup.js';

suite('HucodeOmniStartup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses an Omni window for the default app startup window', () => {
		assert.deepStrictEqual(
			getHucodeDefaultStartupWindowPath({ initialStartup: true }),
			{ isOmniWindow: true }
		);
	});

	test('does not replace explicit or restorable empty windows', () => {
		const results = [
			getHucodeDefaultStartupWindowPath({ initialStartup: false }),
			getHucodeDefaultStartupWindowPath({}),
			getHucodeDefaultStartupWindowPath({
				initialStartup: true,
				hasRestorableWindows: true
			})
		];

		assert.deepStrictEqual(results, [undefined, undefined, undefined]);
	});
});
