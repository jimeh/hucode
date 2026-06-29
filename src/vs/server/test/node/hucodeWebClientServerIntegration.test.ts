/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import {
	getHucodeWebClientRouteAction,
	getHucodeWebWorkbenchConfiguration,
} from '../../node/hucodeWebClientServerIntegration.js';

suite('HucodeWebClientServerIntegration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves server route actions', () => {
		assert.deepStrictEqual(getHucodeWebClientRouteAction('/', {
			basePath: '/x',
			query: {},
			omniRoot: false,
		}), {
			type: 'workbench',
			routePath: '/',
		});
		assert.deepStrictEqual(getHucodeWebClientRouteAction('/', {
			basePath: '/x',
			query: {},
			omniRoot: true,
		}), {
			type: 'workbench',
			routePath: '/',
			hucodeOmniShell: true,
		});
		assert.deepStrictEqual(getHucodeWebClientRouteAction('/omni', {
			basePath: '/x',
			query: {},
			omniRoot: false,
		}), {
			type: 'workbench',
			routePath: '/omni',
			hucodeOmniShell: true,
		});
		assert.deepStrictEqual(getHucodeWebClientRouteAction('/omni/', {
			basePath: '/x',
			query: { folder: '/tmp/project' },
			omniRoot: false,
		}), {
			type: 'redirect',
			location: '/x/omni?folder=%2Ftmp%2Fproject',
		});
	});

	test('builds Hucode workbench configuration', () => {
		assert.deepStrictEqual(getHucodeWebWorkbenchConfiguration('/x', {
			hucodeOmniShell: true,
			serverPathCaseSensitive: true,
		}), {
			hucodeOmniShell: true,
			hucodeOmniWorkbenchRoute: '/x/workbench',
			hucodeOmniProjectsApi: '/x/_hucode/projects',
			hucodeServerPathCaseSensitive: true,
		});
	});
});
