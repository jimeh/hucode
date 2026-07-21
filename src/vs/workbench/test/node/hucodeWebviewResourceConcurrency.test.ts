/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';

suite('HucodeWebviewResourceConcurrency', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards the webview platform to the service worker', () => {
		const indexHtml = readFileSync(FileAccess.asFileUri(
			'vs/workbench/contrib/webview/browser/pre/index.html'
		).fsPath, 'utf8');

		const swPath = indexHtml.match(
			/const\s+swPath\s*=\s*encodeURI\((?<value>[\s\S]*?)\);/
		);
		assert.ok(swPath?.groups, 'expected the service-worker URL initializer');
		assert.match(
			swPath.groups.value,
			/&platform=\$\{\s*searchParams\.get\(\s*["']platform["']\s*\)\s*\}/,
			'expected the service-worker URL to forward the webview platform'
		);
	});

	test('limits host resource response bodies in browser webviews', () => {
		const serviceWorker = readFileSync(FileAccess.asFileUri(
			'vs/workbench/contrib/webview/browser/pre/service-worker.js'
		).fsPath, 'utf8');

		assert.match(
			serviceWorker,
			/const shouldLimitHostResourceResponseBodies = [^;]*?["']electron["'][^;]*?\|\|[^;]*?["']browser["']/,
			'expected the host-resource semaphore to include browser webviews'
		);
	});

	test('cancels transferred resource streams in browser webviews', () => {
		const webviewElement = readFileSync(FileAccess.asFileUri(
			'vs/workbench/contrib/webview/browser/webviewElement.js'
		).fsPath, 'utf8');

		assert.match(
			webviewElement,
			/const streamCts = [^;]*?platform === ["']electron["'][^;]*?\|\|[^;]*?platform === ["']browser["']/,
			'expected transferred-stream cancellation to include browser webviews'
		);
	});
});
