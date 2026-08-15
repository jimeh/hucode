/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import type { IProductService } from
	'../../../platform/product/common/productService.js';
import {
	getHucodeWebClientBasePath,
	getHucodeWebClientRouteAction,
	getHucodeWebDocumentBasePath,
	getHucodeWebProductConfiguration,
	getHucodeWebWorkbenchConfiguration,
} from '../../node/hucodeWebClientServerIntegration.js';

suite('HucodeWebClientServerIntegration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pins document-owned routes to the exact product path', () => {
		assert.strictEqual(
			getHucodeWebDocumentBasePath('/x', '/stable-abc123'),
			'/x/stable-abc123'
		);
		assert.strictEqual(
			getHucodeWebDocumentBasePath('/proxy/nested/', '/stable-abc123'),
			'/proxy/nested/stable-abc123'
		);
	});

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
			basePath: '/x/stable-abc123',
			query: { folder: '/tmp/project' },
			omniEnabled: true,
		}), {
			type: 'redirect',
			location: '/x/stable-abc123/omni?folder=%2Ftmp%2Fproject',
		});
	});

	test('builds Hucode workbench configuration', () => {
		assert.deepStrictEqual(getHucodeWebWorkbenchConfiguration(
			'/x/stable-abc123', {
			hucodeOmniShell: true,
		}, {
			serverPathCaseSensitive: true,
		}), {
			hucodeOmniShell: true,
			hucodeHostedOmniWorkbench: undefined,
			hucodeOmniWorkbenchRoute: '/x/stable-abc123/workbench',
			hucodeOmniHostedWorkbenchRoute:
				'/x/stable-abc123/omni/workbench',
			hucodeOmniProjectsApi: '/x/stable-abc123/_hucode/projects',
			hucodeServerPathCaseSensitive: true,
			hucodeWebUserDataStorage: 'browser',
			hucodeWebUserDataApi: undefined,
			hucodeWebUserDataHome: undefined,
			webviewEndpoint:
				'/x/stable-abc123/static/out/vs/workbench/contrib/webview/browser/pre',
		});
		assert.deepStrictEqual(getHucodeWebWorkbenchConfiguration(
			'/stable-abc123', {
			hucodeHostedOmniWorkbench: true,
		}, {
			serverPathCaseSensitive: false,
		}), {
			hucodeOmniShell: undefined,
			hucodeHostedOmniWorkbench: true,
			hucodeOmniWorkbenchRoute: '/stable-abc123/workbench',
			hucodeOmniHostedWorkbenchRoute:
				'/stable-abc123/omni/workbench',
			hucodeOmniProjectsApi: '/stable-abc123/_hucode/projects',
			hucodeServerPathCaseSensitive: false,
			hucodeWebUserDataStorage: 'browser',
			hucodeWebUserDataApi: undefined,
			hucodeWebUserDataHome: undefined,
			webviewEndpoint:
				'/stable-abc123/static/out/vs/workbench/contrib/webview/browser/pre',
		});
		assert.deepStrictEqual(getHucodeWebWorkbenchConfiguration(
			'/proxy/stable-abc123', {}, {
			serverPathCaseSensitive: true,
			userDataStorage: 'server',
			userDataHome: { scheme: 'vscode-remote', authority: 'host', path: '/WebUser/User' },
		}), {
			hucodeOmniShell: undefined,
			hucodeHostedOmniWorkbench: undefined,
			hucodeOmniWorkbenchRoute: '/proxy/stable-abc123/workbench',
			hucodeOmniHostedWorkbenchRoute:
				'/proxy/stable-abc123/omni/workbench',
			hucodeOmniProjectsApi:
				'/proxy/stable-abc123/_hucode/projects',
			hucodeServerPathCaseSensitive: true,
			hucodeWebUserDataStorage: 'server',
			hucodeWebUserDataApi:
				'/proxy/stable-abc123/_hucode/user-data',
			hucodeWebUserDataHome: { scheme: 'vscode-remote', authority: 'host', path: '/WebUser/User' },
			webviewEndpoint:
				'/proxy/stable-abc123/static/out/vs/workbench/contrib/webview/browser/pre',
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
		} as IProductService['defaultChatAgent'];
		assert.deepStrictEqual(getHucodeWebProductConfiguration({
			quality: 'stable',
			commit: 'abc123',
			defaultChatAgent,
		}), {
			quality: 'stable',
			commit: 'abc123',
			defaultChatAgent,
			builtInExtensionsEnabledWithAutoUpdates: [],
		});
	});
});
