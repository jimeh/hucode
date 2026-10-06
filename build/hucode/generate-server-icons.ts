/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const defaultIcnsPath = path.join(
	repoRoot,
	'build',
	'hucode',
	'mixin',
	'stable',
	'resources',
	'darwin',
	'code.icns'
);
const defaultOutputRoot = path.join(
	repoRoot,
	'build',
	'hucode',
	'mixin',
	'stable',
	'resources',
	'server'
);
const pngSignature = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

/**
 * Extracts PNG renditions from an Apple ICNS file, keyed by pixel size.
 */
export function extractPngRenditions(contents: Buffer): Map<number, Buffer> {
	if (contents.toString('ascii', 0, 4) !== 'icns') {
		throw new Error('Expected an ICNS file.');
	}

	const declaredLength = contents.readUInt32BE(4);
	if (declaredLength !== contents.length) {
		throw new Error(
			`ICNS length is ${contents.length}, expected ${declaredLength}.`
		);
	}

	const renditions = new Map<number, Buffer>();
	let offset = 8;
	while (offset < contents.length) {
		if (offset + 8 > contents.length) {
			throw new Error('ICNS chunk header is truncated.');
		}

		const chunkLength = contents.readUInt32BE(offset + 4);
		const chunkEnd = offset + chunkLength;
		if (chunkLength < 8 || chunkEnd > contents.length) {
			throw new Error('ICNS chunk length is invalid.');
		}

		const payload = contents.subarray(offset + 8, chunkEnd);
		if (
			payload.length >= 24 &&
			payload.subarray(0, pngSignature.length).equals(pngSignature)
		) {
			const width = payload.readUInt32BE(16);
			const height = payload.readUInt32BE(20);
			if (width === height && !renditions.has(width)) {
				renditions.set(width, Buffer.from(payload));
			}
		}

		offset = chunkEnd;
	}

	return renditions;
}

/**
 * Creates an ICO file containing PNG renditions for modern browsers.
 */
export function createIco(renditions: Map<number, Buffer>): Buffer {
	const sizes = [32, 64, 128, 256].filter(size => renditions.has(size));
	if (sizes.length === 0) {
		throw new Error('No favicon-sized PNG renditions were found.');
	}

	const header = Buffer.alloc(6 + sizes.length * 16);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(sizes.length, 4);

	let imageOffset = header.length;
	const images: Buffer[] = [];
	for (const [index, size] of sizes.entries()) {
		const image = renditions.get(size)!;
		const entryOffset = 6 + index * 16;
		header.writeUInt8(size === 256 ? 0 : size, entryOffset);
		header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
		header.writeUInt8(0, entryOffset + 2);
		header.writeUInt8(0, entryOffset + 3);
		header.writeUInt16LE(1, entryOffset + 4);
		header.writeUInt16LE(32, entryOffset + 6);
		header.writeUInt32LE(image.length, entryOffset + 8);
		header.writeUInt32LE(imageOffset, entryOffset + 12);
		images.push(image);
		imageOffset += image.length;
	}

	return Buffer.concat([header, ...images]);
}

/**
 * Generates Hucode's serve-web favicon and PWA icon assets from an ICNS file.
 */
export async function generateServerIcons(
	icnsPath = defaultIcnsPath,
	outputRoot = defaultOutputRoot
): Promise<void> {
	const contents = await fs.readFile(icnsPath);
	const renditions = extractPngRenditions(contents);
	const appIcon = renditions.get(1024);
	if (!appIcon) {
		throw new Error('The ICNS file does not contain a 1024px PNG rendition.');
	}

	// Match upstream's server assets, which use the high-resolution source for
	// both PWA icon filenames and let the browser scale it for each use.
	await fs.mkdir(outputRoot, { recursive: true });
	await Promise.all([
		fs.writeFile(path.join(outputRoot, 'favicon.ico'), createIco(renditions)),
		fs.writeFile(path.join(outputRoot, 'code-192.png'), appIcon),
		fs.writeFile(path.join(outputRoot, 'code-512.png'), appIcon)
	]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await generateServerIcons();
}
