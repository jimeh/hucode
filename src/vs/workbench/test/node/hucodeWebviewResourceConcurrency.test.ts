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
