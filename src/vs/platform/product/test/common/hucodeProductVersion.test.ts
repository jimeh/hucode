/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import {
	getHucodeApplicationVersion,
	getHucodeReleaseNotesMarkdownUrl,
	hasHucodeReleaseNotes,
} from '../../common/hucodeProductVersion.js';

suite('HucodeProductVersion', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns the Hucode release version when present', () => {
		assert.strictEqual(getHucodeApplicationVersion({
			hucodeVersion: '0.0.24',
			version: '1.123.0',
		}), '0.0.24');
	});

	test('falls back to the VS Code version for upstream products', () => {
		assert.strictEqual(getHucodeApplicationVersion({
			version: '1.123.0',
		}), '1.123.0');
	});

	test('returns the Hucode release notes markdown URL for a version', () => {
		assert.strictEqual(getHucodeReleaseNotesMarkdownUrl({
			hucodeReleaseNotesUrlTemplate:
				'https://updates.hucode.dev/release-notes/{version}.md',
		}, '0.0.24'), 'https://updates.hucode.dev/release-notes/0.0.24.md');
	});

	test('returns undefined without a Hucode release notes template', () => {
		assert.strictEqual(getHucodeReleaseNotesMarkdownUrl({}, '0.0.24'), undefined);
	});

	test('detects release notes from Hucode template or fallback URL', () => {
		assert.strictEqual(hasHucodeReleaseNotes({
			hucodeReleaseNotesUrlTemplate:
				'https://updates.hucode.dev/release-notes/{version}.md',
		}), true);
		assert.strictEqual(hasHucodeReleaseNotes({
			releaseNotesUrl: 'https://github.com/jimeh/hucode/releases/latest',
		}), true);
		assert.strictEqual(hasHucodeReleaseNotes({}), false);
	});
});
