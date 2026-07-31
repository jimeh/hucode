/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { applyExplicitDialogButtonOrder } from '../../../../browser/ui/dialog/dialogButtonOrder.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../common/utils.js';

suite('Dialog button order', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('orders buttons by original index', () => {
		assert.deepStrictEqual(
			applyExplicitDialogButtonOrder(
				['Delete', 'Force Delete', 'Cancel'],
				[1, 2, 0]
			),
			['Force Delete', 'Cancel', 'Delete']
		);
	});

	test('rejects absent or invalid explicit orders', () => {
		const buttons = ['Delete', 'Force Delete', 'Cancel'];

		for (const order of [
			undefined,
			[1, 2],
			[1, 1, 0],
			[1, 2, 3],
			[1, 2, 0.5],
		]) {
			assert.strictEqual(
				applyExplicitDialogButtonOrder(buttons, order),
				undefined
			);
		}
	});
});
