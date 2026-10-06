/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { registerHucodeOmniUnattendedRestartBlocker } from '../../common/hucodeOmniUnattendedRestart.js';
import { UnattendedRestartService } from '../../common/unattendedRestart.js';

suite('Hucode Omni unattended restart', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('blocks an Omni window until the blocker is disposed', async () => {
		const service = new UnattendedRestartService(new NullLogService());
		const blocker = registerHucodeOmniUnattendedRestartBlocker(service);
		const blocked = await service.canRestartUnattended();
		blocker.dispose();

		// The main process treats blocker ids outside `[\w.]+` as an invalid response.
		assert.deepStrictEqual({
			blocked: blocked.blockers,
			wellFormed: blocked.blockers.every(id => /^[\w.]+$/.test(id)),
			released: (await service.canRestartUnattended()).blockers,
		}, {
			blocked: ['hucode.omniWindow'],
			wellFormed: true,
			released: [],
		});
	});
});
