/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { extractExtensionApiProposals } from '../../hucode/extension-api-proposals.ts';

function microsoftProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: '1.139.1',
		commit: 'abc123',
		quality: 'stable',
		extensionEnabledApiProposals: {
			'GitHub.vscode-pull-request-github': ['treeItemMarkdownLabel', 'activeComment'],
		},
		...overrides,
	};
}

suite('Hucode extension API proposals', () => {

	test('extracts the allowlist and its source release', () => {
		assert.deepStrictEqual(extractExtensionApiProposals(microsoftProduct(), '1.139.1'), {
			source: { version: '1.139.1', commit: 'abc123' },
			extensionEnabledApiProposals: {
				'GitHub.vscode-pull-request-github': ['treeItemMarkdownLabel', 'activeComment'],
			},
		});
	});

	test('rejects a product from a different VS Code release', () => {
		assert.throws(
			() => extractExtensionApiProposals(microsoftProduct({ version: '1.138.0' }), '1.139.1'),
			/VS Code 1\.138\.0, but the upstream baseline is 1\.139\.1/
		);
	});

	test('rejects a product without a usable allowlist', () => {
		assert.throws(
			() => extractExtensionApiProposals(microsoftProduct({ extensionEnabledApiProposals: undefined }), '1.139.1'),
			/has no extensionEnabledApiProposals map/
		);
		assert.throws(
			() => extractExtensionApiProposals(microsoftProduct({ extensionEnabledApiProposals: { 'a.b': 'x' } }), '1.139.1'),
			/'a\.b'\] is not an array of proposal names/
		);
	});
});
