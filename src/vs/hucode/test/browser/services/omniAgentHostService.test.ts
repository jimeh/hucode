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

	test('stays inert when asked to start the agent host', async () => {
		const service = new OmniAgentHostService();
		service.startAgentHost();

		assert.deepStrictEqual(
			await service.getManagedSettingsDiagnostics(),
			[]
		);
	});
});
