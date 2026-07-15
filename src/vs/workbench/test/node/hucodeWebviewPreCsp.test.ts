/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';

suite('HucodeWebviewPreCsp', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('CSP script hash matches the inline webview bootstrap module', () => {
		// The webview host page pins its inline module script with a CSP
		// sha256 hash. Hucode patches that script for same-origin serve-web
		// hosting, so any edit that forgets to recompute the hash silently
		// blocks the module and breaks every webview.
		const html = readFileSync(FileAccess.asFileUri(
			'vs/workbench/contrib/webview/browser/pre/index.html'
		).fsPath, 'utf8');

		const scriptMatch = html.match(
			/<script async type="module">(?<body>[\s\S]*?)<\/script>/
		);
		assert.ok(scriptMatch?.groups, 'expected inline module script');

		const cspMatch = html.match(/'sha256-(?<hash>[A-Za-z0-9+/=]+)'/);
		assert.ok(cspMatch?.groups, 'expected sha256 source in CSP meta');

		const actualHash = createHash('sha256')
			.update(scriptMatch.groups.body)
			.digest('base64');
		assert.strictEqual(cspMatch.groups.hash, actualHash);
	});

	test('keeps the Hucode same-origin handshake patch', () => {
		const html = readFileSync(FileAccess.asFileUri(
			'vs/workbench/contrib/webview/browser/pre/index.html'
		).fsPath, 'utf8');

		assert.ok(
			html.includes('parentOrigin === location.origin'),
			'expected same-origin serve-web handshake patch'
		);
	});
});
