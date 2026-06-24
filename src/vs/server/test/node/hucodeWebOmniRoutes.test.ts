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
	getHucodeWebOmniWorkbenchSrc,
	renderHucodeWebOmniShell,
} from '../../node/hucodeWebOmniShell.js';

suite('HucodeWebOmniRoutes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps root workbench by default', () => {
		assert.deepStrictEqual(getHucodeWebClientRoute('/', false), {
			type: 'workbench',
			routePath: '/',
		});
	});

	test('routes root to Omni only when requested', () => {
		assert.deepStrictEqual(getHucodeWebClientRoute('/', true), {
			type: 'omni',
			routePath: '/',
		});
	});

	test('always routes /omni to Omni', () => {
		assert.deepStrictEqual(getHucodeWebClientRoute('/omni', false), {
			type: 'omni',
			routePath: '/omni',
		});
		assert.deepStrictEqual(getHucodeWebClientRoute('/omni', true), {
			type: 'omni',
			routePath: '/omni',
		});
	});

	test('always routes /workbench to regular workbench', () => {
		assert.deepStrictEqual(getHucodeWebClientRoute('/workbench', false), {
			type: 'workbench',
			routePath: '/workbench',
		});
		assert.deepStrictEqual(getHucodeWebClientRoute('/workbench', true), {
			type: 'workbench',
			routePath: '/workbench',
		});
	});

	test('redirects trailing slash aliases to canonical routes', () => {
		assert.deepStrictEqual(getHucodeWebClientRoute('/omni/', false), {
			type: 'redirect',
			locationPath: '/omni',
		});
		assert.deepStrictEqual(getHucodeWebClientRoute('/workbench/', true), {
			type: 'redirect',
			locationPath: '/workbench',
		});
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

	test('builds the Omni hosted workbench iframe URL', () => {
		assert.strictEqual(
			getHucodeWebOmniWorkbenchSrc('/x', {
				folder: '/tmp/project',
			}),
			'/x/workbench?folder=%2Ftmp%2Fproject'
		);
	});

	test('escapes the Omni hosted workbench iframe URL', () => {
		const html = renderHucodeWebOmniShell('/workbench?label=a"b&x=1');
		assert.ok(html.includes('src="/workbench?label=a&quot;b&amp;x=1"'));
	});
});
