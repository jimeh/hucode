/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import {
	getHucodeOmniHostedWorkbenchRoute,
	getHucodeOmniProjectsApi,
	getHucodeOmniWorkbenchRoute,
	getHucodeServerPathCaseSensitive,
	isHucodeHostedOmniWebConfiguration,
	isHucodeOmniWebConfiguration,
} from '../../common/hucodeWebConfiguration.js';

suite('HucodeWebConfiguration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('detects Omni shell and hosted workbench configurations', () => {
		assert.deepStrictEqual({
			omni: isHucodeOmniWebConfiguration({ hucodeOmniShell: true }),
			hosted: isHucodeHostedOmniWebConfiguration({
				hucodeHostedOmniWorkbench: true,
			}),
			omniOnHosted: isHucodeOmniWebConfiguration({
				hucodeHostedOmniWorkbench: true,
			}),
			hostedOnOmni: isHucodeHostedOmniWebConfiguration({
				hucodeOmniShell: true,
			}),
			plain: isHucodeOmniWebConfiguration({}),
			absent: isHucodeHostedOmniWebConfiguration(undefined),
		}, {
			omni: true,
			hosted: true,
			omniOnHosted: false,
			hostedOnOmni: false,
			plain: false,
			absent: false,
		});
	});

	test('resolves configured routes with defaults', () => {
		assert.deepStrictEqual({
			workbench: getHucodeOmniWorkbenchRoute(undefined),
			hosted: getHucodeOmniHostedWorkbenchRoute(undefined),
			projectsApi: getHucodeOmniProjectsApi(undefined),
			caseSensitive: getHucodeServerPathCaseSensitive(undefined),
			configuredWorkbench: getHucodeOmniWorkbenchRoute({
				hucodeOmniWorkbenchRoute: '/x/workbench',
			}),
			configuredHosted: getHucodeOmniHostedWorkbenchRoute({
				hucodeOmniHostedWorkbenchRoute: '/x/omni/workbench',
			}),
			configuredApi: getHucodeOmniProjectsApi({
				hucodeOmniProjectsApi: '/x/_hucode/projects',
			}),
			configuredCaseSensitive: getHucodeServerPathCaseSensitive({
				hucodeServerPathCaseSensitive: true,
			}),
		}, {
			workbench: '/workbench',
			hosted: '/omni/workbench',
			projectsApi: '/_hucode/projects',
			caseSensitive: false,
			configuredWorkbench: '/x/workbench',
			configuredHosted: '/x/omni/workbench',
			configuredApi: '/x/_hucode/projects',
			configuredCaseSensitive: true,
		});
	});
});
