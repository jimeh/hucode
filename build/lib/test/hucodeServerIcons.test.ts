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
const pngSignature = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

function assertIcoRenditions(contents: Buffer, expectedSizes: number[]): void {
	assert.strictEqual(contents.readUInt16LE(0), 0);
	assert.strictEqual(contents.readUInt16LE(2), 1);
	assert.strictEqual(contents.readUInt16LE(4), expectedSizes.length);

	let expectedImageOffset = 6 + expectedSizes.length * 16;
	for (const [index, expectedSize] of expectedSizes.entries()) {
		const entryOffset = 6 + index * 16;
		const encodedSize = expectedSize === 256 ? 0 : expectedSize;
		assert.strictEqual(contents.readUInt8(entryOffset), encodedSize);
		assert.strictEqual(contents.readUInt8(entryOffset + 1), encodedSize);
		assert.strictEqual(contents.readUInt16LE(entryOffset + 4), 1);
		assert.strictEqual(contents.readUInt16LE(entryOffset + 6), 32);

		const imageLength = contents.readUInt32LE(entryOffset + 8);
		const imageOffset = contents.readUInt32LE(entryOffset + 12);
		assert.strictEqual(imageOffset, expectedImageOffset);
		assert.ok(
			contents
				.subarray(imageOffset, imageOffset + pngSignature.length)
				.equals(pngSignature)
		);
		assert.strictEqual(contents.readUInt32BE(imageOffset + 16), expectedSize);
		assert.strictEqual(contents.readUInt32BE(imageOffset + 20), expectedSize);
		expectedImageOffset += imageLength;
	}

	assert.strictEqual(expectedImageOffset, contents.length);
}

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
		const favicon = await fs.readFile(
			path.join(mixinRoot, 'server', 'favicon.ico')
		);
		assert.deepStrictEqual(favicon, createIco(renditions));
		assertIcoRenditions(favicon, [32, 64, 128, 256]);
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
