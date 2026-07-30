/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { OmniAgentHostService } from
	'../../../browser/services/omniAgentHostService.js';

suite('Omni Agent Host Service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports no managed settings without starting an agent host', async () => {
		const service = new OmniAgentHostService();

		assert.deepStrictEqual(
			await service.getManagedSettingsDiagnostics(),
			[]
		);
	});
});
