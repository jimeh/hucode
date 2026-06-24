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
	getHucodeWebOmniContentSecurityPolicy,
	getHucodeWebOmniProjectsApi,
	getHucodeWebOmniWorkbenchSrc,
	getHucodeWebOmniWorkbenchBase,
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
		const src = getHucodeWebOmniWorkbenchSrc('/x', {
			folder: '/tmp/project',
		});
		const location = new URL(src, 'http://localhost');

		assert.strictEqual(location.pathname, '/x/workbench');
		assert.strictEqual(location.searchParams.get('folder'), '/tmp/project');

		const payload = parsePayload(location.searchParams.get('payload'));
		assert.strictEqual(payload.get('isHostedOmniWorkspace'), 'true');
		assert.strictEqual(payload.get('hostedInstanceId'), 'initial');
	});

	test('adds an empty-window target for Omni hosted iframe URLs', () => {
		const src = getHucodeWebOmniWorkbenchSrc('/', {}, 'empty-1');
		const location = new URL(src, 'http://localhost');

		assert.strictEqual(location.pathname, '/workbench');
		assert.strictEqual(location.searchParams.get('ew'), 'true');

		const payload = parsePayload(location.searchParams.get('payload'));
		assert.strictEqual(payload.get('isHostedOmniWorkspace'), 'true');
		assert.strictEqual(payload.get('hostedInstanceId'), 'empty-1');
	});

	test('builds the Omni hosted workbench base route', () => {
		assert.strictEqual(getHucodeWebOmniWorkbenchBase('/x'), '/x/workbench');
	});

	test('builds the Omni projects API route', () => {
		assert.strictEqual(getHucodeWebOmniProjectsApi('/x'), '/x/_hucode/projects');
	});

	test('allows the Omni shell script, API, and iframes in CSP', () => {
		const csp = getHucodeWebOmniContentSecurityPolicy();

		assert.ok(csp.includes('script-src \'unsafe-inline\''));
		assert.ok(csp.includes('connect-src \'self\''));
		assert.ok(csp.includes('frame-src \'self\''));
	});

	test('escapes the Omni hosted workbench iframe URL', () => {
		const html = renderHucodeWebOmniShell(
			'/workbench?base=a"b&x=1',
			'/workbench?label=c"d&y=2',
			'/_hucode/projects?z=e"f&y=3'
		);

		assert.ok(html.includes(
			'data-workbench-base="/workbench?base=a&quot;b&amp;x=1"'
		));
		assert.ok(html.includes(
			'data-initial-workbench-src="/workbench?label=c&quot;d&amp;y=2"'
		));
		assert.ok(html.includes(
			'data-projects-api="/_hucode/projects?z=e&quot;f&amp;y=3"'
		));
	});

	test('renders the Omni hosted iframe message bridge', () => {
		const html = renderHucodeWebOmniShell(
			'/workbench',
			'/workbench?ew=true',
			'/_hucode/projects'
		);

		for (const messageType of [
			'hucode.omni.beforeUnload',
			'hucode.omni.unloadReady',
			'hucode.omni.runCommand',
			'hucode.omni.hostedWorkbenchReady',
			'hucode.omni.commandResult',
		]) {
			assert.ok(html.includes(messageType));
		}
	});
});

function parsePayload(payload: string | null): Map<string, string> {
	assert.ok(payload);
	return new Map(JSON.parse(payload));
}
