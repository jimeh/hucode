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
			omniEnabled: false,
		}), {
			type: 'workbench',
			routePath: '/',
		});
		assert.deepStrictEqual(getHucodeWebClientRouteAction('/omni', {
			basePath: '/x',
			query: {},
			omniEnabled: false,
		}), {
			type: 'notFound',
		});
		assert.deepStrictEqual(getHucodeWebClientRouteAction('/', {
			basePath: '/x',
			query: {},
			omniEnabled: true,
		}), {
			type: 'workbench',
			routePath: '/',
			hucodeOmniShell: true,
		});
		assert.deepStrictEqual(getHucodeWebClientRouteAction('/omni/workbench', {
			basePath: '/x',
			query: {},
			omniEnabled: true,
		}), {
			type: 'workbench',
			routePath: '/omni/workbench',
			hucodeHostedOmniWorkbench: true,
		});
		assert.deepStrictEqual(getHucodeWebClientRouteAction('/omni/', {
			basePath: '/x',
			query: { folder: '/tmp/project' },
			omniEnabled: true,
		}), {
			type: 'redirect',
			location: '/x/omni?folder=%2Ftmp%2Fproject',
		});
	});

	test('builds Hucode workbench configuration', () => {
		assert.deepStrictEqual(getHucodeWebWorkbenchConfiguration('/x', {
			hucodeOmniShell: true,
		}, {
			serverPathCaseSensitive: true,
		}), {
			hucodeOmniShell: true,
			hucodeHostedOmniWorkbench: undefined,
			hucodeOmniWorkbenchRoute: '/x/workbench',
			hucodeOmniHostedWorkbenchRoute: '/x/omni/workbench',
			hucodeOmniProjectsApi: '/x/_hucode/projects',
			hucodeServerPathCaseSensitive: true,
			webviewEndpoint:
				'/x/static/out/vs/workbench/contrib/webview/browser/pre',
		});
		assert.deepStrictEqual(getHucodeWebWorkbenchConfiguration('/', {
			hucodeHostedOmniWorkbench: true,
		}, {
			serverPathCaseSensitive: false,
		}), {
			hucodeOmniShell: undefined,
			hucodeHostedOmniWorkbench: true,
			hucodeOmniWorkbenchRoute: '/workbench',
			hucodeOmniHostedWorkbenchRoute: '/omni/workbench',
			hucodeOmniProjectsApi: '/_hucode/projects',
			hucodeServerPathCaseSensitive: false,
			webviewEndpoint:
				'/static/out/vs/workbench/contrib/webview/browser/pre',
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
		const defaultChatAgent = {
			extensionId: 'GitHub.copilot',
			chatExtensionId: 'GitHub.copilot-chat',
		};
		assert.deepStrictEqual(getHucodeWebProductConfiguration({
			_serviceBrand: undefined,
			quality: 'stable',
			commit: 'abc123',
			defaultChatAgent,
		} as unknown as IProductService), {
			quality: 'stable',
			commit: 'abc123',
			defaultChatAgent,
			builtInExtensionsEnabledWithAutoUpdates: [],
		});
	});
});
