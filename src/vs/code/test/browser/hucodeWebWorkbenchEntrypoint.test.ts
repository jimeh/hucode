/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { resolveHucodeWebWorkbenchCreate } from
	'../../browser/workbench/hucodeWebWorkbenchEntrypoint.js';

suite('HucodeWebWorkbenchEntrypoint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the default workbench without Hucode markers', async () => {
		const defaultCreate = () => {
			throw new Error('not expected to run');
		};

		assert.deepStrictEqual([
			await resolveHucodeWebWorkbenchCreate(
				{},
				defaultCreate as never
			),
			await resolveHucodeWebWorkbenchCreate(
				{ hucodeOmniShell: false } as never,
				defaultCreate as never
			),
			await resolveHucodeWebWorkbenchCreate(
				{ hucodeHostedOmniWorkbench: false } as never,
				defaultCreate as never
			),
		], [defaultCreate, defaultCreate, defaultCreate]);
	});
});
