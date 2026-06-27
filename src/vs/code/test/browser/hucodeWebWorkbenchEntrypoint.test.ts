/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { isHucodeHostedOmniWebPayload } from
	'../../browser/workbench/hucodeWebWorkbenchEntrypoint.js';

suite('HucodeWebWorkbenchEntrypoint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('detects hosted Omni payloads', () => {
		const payload = JSON.stringify([
			['isHostedOmniWorkspace', 'true'],
			['hostedInstanceId', 'instance-1'],
		]);
		const location = new URL('http://localhost/workbench');
		location.searchParams.set('payload', payload);

		assert.strictEqual(
			isHucodeHostedOmniWebPayload(location.toString()),
			true
		);
	});

	test('ignores absent, unrelated, and invalid payloads', () => {
		assert.strictEqual(
			isHucodeHostedOmniWebPayload('http://localhost/workbench'),
			false
		);

		const unrelated = new URL('http://localhost/workbench');
		unrelated.searchParams.set('payload', JSON.stringify([
			['isHostedOmniWorkspace', 'false'],
		]));
		assert.strictEqual(
			isHucodeHostedOmniWebPayload(unrelated.toString()),
			false
		);

		const invalid = new URL('http://localhost/workbench');
		invalid.searchParams.set('payload', '{');
		assert.strictEqual(
			isHucodeHostedOmniWebPayload(invalid.toString()),
			false
		);
	});
});
