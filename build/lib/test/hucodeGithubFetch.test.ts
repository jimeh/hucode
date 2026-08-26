/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import {
	getGithubApiHeaders,
	getGithubReleaseAssetName,
	getGithubReleaseAssetUrl,
	resolveGithubReleaseAssetLocation,
} from '../hucodeGithubFetch.ts';

suite('Hucode GitHub build fetches', () => {
	test('constructs the pinned extension release asset URL without the API', () => {
		const assetName = getGithubReleaseAssetName(
			'ms-vscode.js-debug',
			'1.117.0'
		);

		assert.strictEqual(assetName, 'ms-vscode.js-debug.1.117.0.vsix');
		assert.strictEqual(
			getGithubReleaseAssetUrl(
				'microsoft/vscode-js-debug',
				'1.117.0',
				assetName
			),
			'https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/ms-vscode.js-debug.1.117.0.vsix'
		);
	});

	test('uses an explicit platform asset name for a pinned release', () => {
		assert.deepStrictEqual(
			resolveGithubReleaseAssetLocation(
				'microsoft/example',
				{
					version: '1.2.3',
					name: 'ms-vscode.example-darwin-arm64.vsix',
				}
			),
			{
				kind: 'direct',
				url: 'https://github.com/microsoft/example/releases/download/v1.2.3/ms-vscode.example-darwin-arm64.vsix',
			}
		);
	});

	test('retains API discovery for the latest matching release asset', () => {
		assert.deepStrictEqual(
			resolveGithubReleaseAssetLocation(
				'microsoft/example',
				{
					version: '1.2.3',
					name: name => name.endsWith('.vsix'),
					latest: true,
				}
			),
			{
				kind: 'api',
				path: '/repos/microsoft/example/releases?per_page=100',
			}
		);
	});

	test('rejects predicate-based discovery for a pinned release', () => {
		assert.throws(
			() => resolveGithubReleaseAssetLocation(
				'microsoft/example',
				{
					version: '1.2.3',
					name: name => name.endsWith('.vsix'),
				}
			),
			/Pinned GitHub release assets require an exact asset name/
		);
	});

	test('authenticates API requests with GITHUB_TOKEN as a bearer token', () => {
		const headers = getGithubApiHeaders({
			GITHUB_TOKEN: 'actions-token',
			GH_TOKEN: 'cli-token',
		});

		assert.strictEqual(headers.Authorization, 'Bearer actions-token');
	});

	test('falls back to GH_TOKEN for API authentication', () => {
		const headers = getGithubApiHeaders({ GH_TOKEN: 'cli-token' });

		assert.strictEqual(headers.Authorization, 'Bearer cli-token');
	});

	test('falls back to GH_TOKEN when GITHUB_TOKEN is empty', () => {
		const headers = getGithubApiHeaders({
			GITHUB_TOKEN: '',
			GH_TOKEN: 'cli-token',
		});

		assert.strictEqual(headers.Authorization, 'Bearer cli-token');
	});

	test('leaves public API requests unauthenticated without a token', () => {
		const headers = getGithubApiHeaders({});

		assert.ok(!Object.hasOwn(headers, 'Authorization'));
	});
});
