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

	test('uses exactly one Omni window for clean initial startup', () => {
		assert.deepStrictEqual(
			[getHucodeDefaultStartupWindowPath({ initialStartup: true })],
			[{ isOmniWindow: true }]
		);
	});

	test('does not add fallback around explicit or restorable windows', () => {
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
