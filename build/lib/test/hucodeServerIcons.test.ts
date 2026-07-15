/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
	createIco,
	extractPngRenditions
} from '../../hucode/generate-server-icons.ts';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..'
);
const mixinRoot = path.join(
	repoRoot,
	'build',
	'hucode',
	'mixin',
	'stable',
	'resources'
);

suite('Hucode server icons', () => {
	test('generated server icons match the tracked Hucode ICNS', async () => {
		const contents = await fs.readFile(
			path.join(mixinRoot, 'darwin', 'code.icns')
		);
		const renditions = extractPngRenditions(contents);

		assert.deepStrictEqual(
			[...renditions.keys()].sort((a, b) => a - b),
			[32, 64, 128, 256, 512, 1024]
		);
		assert.deepStrictEqual(
			await fs.readFile(path.join(mixinRoot, 'server', 'favicon.ico')),
			createIco(renditions)
		);
		assert.deepStrictEqual(
			await fs.readFile(path.join(mixinRoot, 'server', 'code-192.png')),
			renditions.get(1024)
		);
		assert.deepStrictEqual(
			await fs.readFile(path.join(mixinRoot, 'server', 'code-512.png')),
			renditions.get(1024)
		);
	});
});
