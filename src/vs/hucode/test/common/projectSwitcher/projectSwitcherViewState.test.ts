/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { parseProjectSwitcherViewState } from
	'../../../common/projectSwitcher/projectSwitcherViewState.js';

suite('ProjectSwitcherViewState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('migrates version 1 project collapse state', () => {
		assert.deepStrictEqual(parseProjectSwitcherViewState(JSON.stringify({
			version: 1,
			collapsedProjectIds: ['project:unpinned:one'],
		})), {
			state: {
				version: 2,
				collapsedProjectIds: ['project:unpinned:one'],
				collapsedOmniSections: [],
			},
			migrated: true,
		});
	});

	test('validates version 2 state', () => {
		assert.deepStrictEqual(parseProjectSwitcherViewState(JSON.stringify({
			version: 2,
			collapsedProjectIds: ['project:pinned:one'],
			collapsedOmniSections: ['section:workbenches'],
		}))?.state, {
			version: 2,
			collapsedProjectIds: ['project:pinned:one'],
			collapsedOmniSections: ['section:workbenches'],
		});
		assert.strictEqual(parseProjectSwitcherViewState(JSON.stringify({
			version: 2,
			collapsedProjectIds: [1],
			collapsedOmniSections: [],
		})), undefined);
		assert.strictEqual(parseProjectSwitcherViewState('null'), undefined);
		assert.strictEqual(parseProjectSwitcherViewState('42'), undefined);
	});
});
