/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import {
	parseProjectSwitcherViewState,
	reorderProjectSwitcherOmniSections,
} from
	'../../../common/projectSwitcher/projectSwitcherViewState.js';

suite('ProjectSwitcherViewState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('migrates version 1 project collapse state', () => {
		assert.deepStrictEqual(parseProjectSwitcherViewState(JSON.stringify({
			version: 1,
			collapsedProjectIds: ['project:unpinned:one'],
		})), {
			state: {
				version: 3,
				collapsedProjectIds: ['project:unpinned:one'],
				collapsedOmniSections: [],
				omniSectionOrder: ['workbenches', 'projects'],
			},
			migrated: true,
		});
	});

	test('migrates version 2 section collapse state', () => {
		assert.deepStrictEqual({
			valid: parseProjectSwitcherViewState(JSON.stringify({
				version: 2,
				collapsedProjectIds: ['project:pinned:one'],
				collapsedOmniSections: ['section:workbenches'],
			}))?.state,
			invalid: parseProjectSwitcherViewState(JSON.stringify({
				version: 2,
				collapsedProjectIds: [],
				collapsedOmniSections: [1],
			})),
		}, {
			valid: {
				version: 3,
				collapsedProjectIds: ['project:pinned:one'],
				collapsedOmniSections: ['section:workbenches'],
				omniSectionOrder: ['workbenches', 'projects'],
			},
			invalid: undefined,
		});
	});

	test('validates version 3 state and section order', () => {
		assert.deepStrictEqual({
			validOrder: parseProjectSwitcherViewState(JSON.stringify({
				version: 3,
				collapsedProjectIds: [],
				collapsedOmniSections: [],
				omniSectionOrder: ['projects', 'workbenches'],
			}))?.state.omniSectionOrder,
			invalidProjectIds: parseProjectSwitcherViewState(JSON.stringify({
				version: 3,
				collapsedProjectIds: [1],
				collapsedOmniSections: [],
				omniSectionOrder: ['workbenches', 'projects'],
			})),
			duplicateOrder: parseProjectSwitcherViewState(JSON.stringify({
				version: 3,
				collapsedProjectIds: [],
				collapsedOmniSections: [],
				omniSectionOrder: ['projects', 'projects'],
			})),
			nullState: parseProjectSwitcherViewState('null'),
			numericState: parseProjectSwitcherViewState('42'),
		}, {
			validOrder: ['projects', 'workbenches'],
			invalidProjectIds: undefined,
			duplicateOrder: undefined,
			nullState: undefined,
			numericState: undefined,
		});
	});

	test('reorders the top-level Omni sections', () => {
		assert.deepStrictEqual(reorderProjectSwitcherOmniSections(
			['workbenches', 'projects'],
			'workbenches',
			'projects'
		), ['projects', 'workbenches']);
	});
});
