/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import {
	createBuiltInExtensionSourceResolver,
	resolveBuiltInExtensionDownloadSource
} from '../hucodeBuiltInExtensionsSource.ts';

suite('Hucode built-in extension source', () => {
	const galleryProduct = {
		extensionsGallery: { serviceUrl: 'https://open-vsx.example/gallery' }
	};

	test('explicit GitHub policy overrides the configured extension gallery', () => {
		assert.strictEqual(
			resolveBuiltInExtensionDownloadSource({}, {
				...galleryProduct,
				builtInExtensionsSource: 'github'
			}),
			'github'
		);
	});

	test('omitted policy preserves gallery selection', () => {
		assert.strictEqual(
			resolveBuiltInExtensionDownloadSource({}, galleryProduct),
			'marketplace'
		);
	});

	test('omitted policy selects GitHub without a gallery', () => {
		assert.strictEqual(
			resolveBuiltInExtensionDownloadSource({}, {}),
			'github'
		);
	});

	test('local VSIX takes precedence over configured source', () => {
		assert.strictEqual(
			resolveBuiltInExtensionDownloadSource(
				{ vsix: '.build/extensions/example.vsix' },
				{ ...galleryProduct, builtInExtensionsSource: 'github' }
			),
			'vsix'
		);
	});

	test('platform-specific releases take precedence over configured source', () => {
		assert.strictEqual(
			resolveBuiltInExtensionDownloadSource(
				{ platformSpecific: { 'darwin-arm64': 'sha256' } },
				{ ...galleryProduct, builtInExtensionsSource: 'marketplace' }
			),
			'github'
		);
	});

	test('rejects a marketplace source without a gallery URL', () => {
		assert.throws(
			() => resolveBuiltInExtensionDownloadSource({}, {
				builtInExtensionsSource: 'marketplace'
			}),
			/builtInExtensionsSource is 'marketplace', but extensionsGallery\.serviceUrl is not configured\./
		);
	});

	test('rejects an invalid explicit source', () => {
		assert.throws(
			() => resolveBuiltInExtensionDownloadSource({}, {
				...galleryProduct,
				builtInExtensionsSource: 'open-vsx'
			}),
			/Invalid builtInExtensionsSource 'open-vsx'. Expected 'github' or 'marketplace'\./
		);
	});

	test('rejects non-string policy before resolving any extension', () => {
		assert.throws(
			() => createBuiltInExtensionSourceResolver({
				...galleryProduct,
				builtInExtensionsSource: null
			}),
			/Invalid builtInExtensionsSource null\. Expected 'github' or 'marketplace'\./
		);
	});
});
