/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IUpdate } from '../../common/update.js';
import {
	getHucodeUpdateDisplayVersion,
	mergeHucodeUpdateMetadata,
} from '../../common/hucodeUpdateVersion.js';

suite('HucodeUpdateVersion', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prefers the Hucode application version for update display', () => {
		assert.strictEqual(getHucodeUpdateDisplayVersion({
			version: '006ad6478f8affa04343ab19b08d2ad97dd324f2',
			productVersion: '1.125.0',
			hucodeVersion: '0.0.32',
		}), '0.0.32');
	});

	test('falls back to the VS Code product version for upstream updates', () => {
		assert.strictEqual(getHucodeUpdateDisplayVersion({
			version: '006ad6478f8affa04343ab19b08d2ad97dd324f2',
			productVersion: '1.125.0',
		}), '1.125.0');
	});

	test('restores Hucode metadata dropped from a downloaded update', () => {
		const downloaded: IUpdate = {
			version: '006ad6478f8affa04343ab19b08d2ad97dd324f2',
			productVersion: '1.125.0',
			timestamp: 1781787600000,
		};
		const metadata: IUpdate = {
			version: '006ad6478f8affa04343ab19b08d2ad97dd324f2',
			productVersion: '1.125.0',
			hucodeVersion: '0.0.32',
			url: 'https://updates.hucode.dev/Hucode-darwin-arm64.zip',
		};

		assert.deepStrictEqual(mergeHucodeUpdateMetadata(downloaded, metadata), {
			version: '006ad6478f8affa04343ab19b08d2ad97dd324f2',
			productVersion: '1.125.0',
			hucodeVersion: '0.0.32',
			timestamp: 1781787600000,
		});
	});

	test('restores VS Code product version rewritten by macOS updater', () => {
		const downloaded: IUpdate = {
			version: 'ceb19911279b95364a8b65dc296edb102dc7e44a',
			productVersion: '0.0.35',
			hucodeVersion: '0.0.35',
			timestamp: 1782298960000,
		};
		const metadata: IUpdate = {
			version: 'ceb19911279b95364a8b65dc296edb102dc7e44a',
			productVersion: '1.125.0',
			hucodeVersion: '0.0.35',
			url: 'https://updates.hucode.dev/Hucode-darwin-arm64.zip',
		};

		assert.deepStrictEqual(mergeHucodeUpdateMetadata(downloaded, metadata), {
			version: 'ceb19911279b95364a8b65dc296edb102dc7e44a',
			productVersion: '1.125.0',
			hucodeVersion: '0.0.35',
			timestamp: 1782298960000,
		});
	});

	test('does not merge metadata from a different update commit', () => {
		const downloaded: IUpdate = {
			version: '006ad6478f8affa04343ab19b08d2ad97dd324f2',
			productVersion: '1.125.0',
		};
		const metadata: IUpdate = {
			version: 'df3fa28c5274f23d5d826850886f632668c29a93',
			productVersion: '1.124.0',
			hucodeVersion: '0.0.31',
		};

		assert.strictEqual(mergeHucodeUpdateMetadata(downloaded, metadata), downloaded);
	});

	test('uses matching metadata as authoritative for downloaded updates', () => {
		const downloaded: IUpdate = {
			version: '006ad6478f8affa04343ab19b08d2ad97dd324f2',
			productVersion: '0.0.32',
			hucodeVersion: '0.0.32',
		};
		const metadata: IUpdate = {
			version: '006ad6478f8affa04343ab19b08d2ad97dd324f2',
			productVersion: '1.125.0',
			hucodeVersion: '0.0.33',
		};

		assert.deepStrictEqual(mergeHucodeUpdateMetadata(downloaded, metadata), {
			version: '006ad6478f8affa04343ab19b08d2ad97dd324f2',
			productVersion: '1.125.0',
			hucodeVersion: '0.0.33',
		});
	});
});
