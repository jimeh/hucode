/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { OmniAgentHostService } from
	'../../../browser/services/omniAgentHostService.js';
import { ROOT_STATE_URI } from
	'../../../../platform/agentHost/common/state/sessionState.js';
import { ActionType } from
	'../../../../platform/agentHost/common/state/sessionActions.js';

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

	test('ignores root configuration changes but rejects other dispatches', () => {
		const service = new OmniAgentHostService();
		const rootConfigChanged = {
			type: ActionType.RootConfigChanged,
			config: { refresh: 'request' },
		} as const;

		service.dispatch(ROOT_STATE_URI, rootConfigChanged);
		assert.throws(
			() => service.dispatch('ahp-session://session', rootConfigChanged),
			/Agent host is not available/
		);
	});
});
