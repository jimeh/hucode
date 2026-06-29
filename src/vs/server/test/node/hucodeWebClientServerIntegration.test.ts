/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import type { IProductService } from
	'../../../platform/product/common/productService.js';
import {
	getHucodeWebClientBasePath,
	getHucodeWebClientRouteAction,
	getHucodeWebProductConfiguration,
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

	test('resolves the client base path', () => {
		assert.strictEqual(getHucodeWebClientBasePath({}, '/x'), '/x');
		assert.strictEqual(
			getHucodeWebClientBasePath({ 'x-forwarded-prefix': '/proxy' }, '/x'),
			'/proxy'
		);
		assert.strictEqual(
			getHucodeWebClientBasePath(
				{ 'x-forwarded-prefix': ['/first', '/second'] },
				'/x'
			),
			'/first'
		);
	});

	test('builds Hucode product configuration', () => {
		assert.deepStrictEqual(getHucodeWebProductConfiguration({
			_serviceBrand: undefined,
			quality: 'stable',
			commit: 'abc123',
		} as IProductService), {
			quality: 'stable',
			commit: 'abc123',
		});
	});
});
