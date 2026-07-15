/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import {
	getHucodeWebClientRoute,
	toHucodeWebRouteLocation,
} from '../../node/hucodeWebOmniRoutes.js';
import {
	getHucodeWebOmniHostedWorkbenchBase,
	getHucodeWebOmniProjectsApi,
	getHucodeWebOmniWorkbenchBase,
} from '../../node/hucodeWebOmniShell.js';

suite('HucodeWebOmniRoutes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps upstream behavior when Omni web is disabled', () => {
		assert.deepStrictEqual(getHucodeWebClientRoute('/', false), {
			type: 'workbench',
			routePath: '/',
		});
		assert.deepStrictEqual(getHucodeWebClientRoute('/omni', false), {
			type: 'notFound',
		});
		assert.deepStrictEqual(getHucodeWebClientRoute('/workbench', false), {
			type: 'notFound',
		});
		assert.deepStrictEqual(
			getHucodeWebClientRoute('/omni/workbench', false),
			{ type: 'notFound' }
		);
	});

	test('routes root to Omni when enabled', () => {
		assert.deepStrictEqual(getHucodeWebClientRoute('/', true), {
			type: 'omni',
			routePath: '/',
		});
	});

	test('routes /omni to Omni when enabled', () => {
		assert.deepStrictEqual(getHucodeWebClientRoute('/omni', true), {
			type: 'omni',
			routePath: '/omni',
		});
	});

	test('routes /workbench to the regular workbench when enabled', () => {
		assert.deepStrictEqual(getHucodeWebClientRoute('/workbench', true), {
			type: 'workbench',
			routePath: '/workbench',
		});
	});

	test('routes /omni/workbench to the hosted workbench when enabled', () => {
		assert.deepStrictEqual(
			getHucodeWebClientRoute('/omni/workbench', true),
			{
				type: 'hostedWorkbench',
				routePath: '/omni/workbench',
			}
		);
	});

	test('redirects trailing slash aliases to canonical routes', () => {
		assert.deepStrictEqual(getHucodeWebClientRoute('/omni/', true), {
			type: 'redirect',
			locationPath: '/omni',
		});
		assert.deepStrictEqual(getHucodeWebClientRoute('/workbench/', true), {
			type: 'redirect',
			locationPath: '/workbench',
		});
		assert.deepStrictEqual(
			getHucodeWebClientRoute('/omni/workbench/', true),
			{
				type: 'redirect',
				locationPath: '/omni/workbench',
			}
		);
	});

	test('preserves query parameters and base path in redirects', () => {
		assert.strictEqual(
			toHucodeWebRouteLocation('/x', '/workbench', {
				folder: '/tmp/project',
				tkn: 'secret',
			}),
			'/x/workbench?folder=%2Ftmp%2Fproject&tkn=secret'
		);
		assert.strictEqual(
			toHucodeWebRouteLocation('/', '/omni', {
				workspace: '/tmp/test.code-workspace',
			}),
			'/omni?workspace=%2Ftmp%2Ftest.code-workspace'
		);
	});

	test('builds the regular workbench base route', () => {
		assert.strictEqual(getHucodeWebOmniWorkbenchBase('/x'), '/x/workbench');
	});

	test('builds the hosted workbench base route', () => {
		assert.strictEqual(
			getHucodeWebOmniHostedWorkbenchBase('/x'),
			'/x/omni/workbench'
		);
	});

	test('builds the Omni projects API route', () => {
		assert.strictEqual(getHucodeWebOmniProjectsApi('/x'), '/x/_hucode/projects');
	});
});
