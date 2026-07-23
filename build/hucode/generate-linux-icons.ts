/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const iconRoot = path.join(
	repoRoot,
	'build',
	'hucode',
	'mixin',
	'stable',
	'resources'
);
const sourceIcns = path.join(iconRoot, 'darwin', 'code.icns');
const outputRoot = path.join(iconRoot, 'linux');
const pngSignature = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);
const xpmSymbols =
	' .+@#$%&*=-;:>,<1234567890abcdefghijklmnopqrstuvwxyz' +
	'ABCDEFGHIJKLMNOPQRSTUVWXYZ!^_`|~[]{}()?/';

/** Decoded non-interlaced, 8-bit RGBA PNG pixels. */
interface DecodedPng {
	readonly width: number;
	readonly height: number;
	readonly data: Buffer;
}

/**
 * Extracts an encoded payload from a typed entry in an ICNS container.
 *
 * @param icns Complete ICNS container bytes.
 * @param entryType Four-character ICNS entry type.
 * @returns The encoded entry payload without its ICNS header.
 */
function extractIcnsEntry(icns: Buffer, entryType: string): Buffer {
	assert.strictEqual(icns.toString('ascii', 0, 4), 'icns');
	assert.strictEqual(icns.readUInt32BE(4), icns.length);

	for (let offset = 8; offset < icns.length;) {
		const type = icns.toString('ascii', offset, offset + 4);
		const length = icns.readUInt32BE(offset + 4);
		assert.ok(length >= 8, `Invalid ICNS entry length for '${type}'.`);

		if (type === entryType) {
			return icns.subarray(offset + 8, offset + length);
		}

		offset += length;
	}

	throw new Error(`ICNS entry '${entryType}' was not found.`);
}

/**
 * Decodes a non-interlaced, 8-bit RGBA PNG.
 *
 * @param png Encoded PNG bytes.
 * @returns Image dimensions and row-major RGBA pixels.
 */
function parsePng(png: Buffer): DecodedPng {
	assert.ok(png.subarray(0, 8).equals(pngSignature));

	let width: number | undefined;
	let height: number | undefined;
	const compressed: Buffer[] = [];

	for (let offset = 8; offset < png.length;) {
		const length = png.readUInt32BE(offset);
		const type = png.toString('ascii', offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);

		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			assert.strictEqual(data[8], 8, 'Expected an 8-bit PNG.');
			assert.strictEqual(data[9], 6, 'Expected an RGBA PNG.');
			assert.strictEqual(data[12], 0, 'Expected a non-interlaced PNG.');
		} else if (type === 'IDAT') {
			compressed.push(data);
		} else if (type === 'IEND') {
			break;
		}

		offset += length + 12;
	}

	assert.ok(width && height, 'PNG is missing its dimensions.');
	return {
		width,
		height,
		data: unfilterRgba(
			zlib.inflateSync(Buffer.concat(compressed)),
			width,
			height
		)
	};
}

/**
 * Reconstructs RGBA scanlines from PNG filter bytes.
 *
 * @param filtered Inflated PNG scanlines including per-row filter bytes.
 * @param width Image width in pixels.
 * @param height Image height in pixels.
 * @returns Row-major RGBA pixels.
 */
function unfilterRgba(
	filtered: Buffer,
	width: number,
	height: number
): Buffer {
	const bytesPerPixel = 4;
	const stride = width * bytesPerPixel;
	const rgba = Buffer.alloc(stride * height);
	let inputOffset = 0;

	for (let y = 0; y < height; y++) {
		const filter = filtered[inputOffset++];
		const outputOffset = y * stride;

		for (let x = 0; x < stride; x++) {
			const raw = filtered[inputOffset++];
			const left = x >= bytesPerPixel ? rgba[outputOffset + x - 4] : 0;
			const above = y > 0 ? rgba[outputOffset + x - stride] : 0;
			const upperLeft = x >= bytesPerPixel && y > 0
				? rgba[outputOffset + x - stride - 4]
				: 0;
			let predictor = 0;

			switch (filter) {
				case 0: break;
				case 1: predictor = left; break;
				case 2: predictor = above; break;
				case 3: predictor = Math.floor((left + above) / 2); break;
				case 4: predictor = paeth(left, above, upperLeft); break;
				default: throw new Error(`Unsupported PNG filter '${filter}'.`);
			}

			rgba[outputOffset + x] = (raw + predictor) & 0xff;
		}
	}

	return rgba;
}

/**
 * Selects the PNG Paeth predictor nearest to the computed estimate.
 *
 * @param left Pixel component to the left.
 * @param above Pixel component above.
 * @param upperLeft Pixel component diagonally above and left.
 * @returns The selected neighboring component.
 */
function paeth(left: number, above: number, upperLeft: number): number {
	const estimate = left + above - upperLeft;
	const leftDistance = Math.abs(estimate - left);
	const aboveDistance = Math.abs(estimate - above);
	const upperLeftDistance = Math.abs(estimate - upperLeft);

	if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
		return left;
	}
	if (aboveDistance <= upperLeftDistance) {
		return above;
	}
	return upperLeft;
}

/**
 * Encodes RGBA pixels as a deterministic grayscale XPM with transparency.
 *
 * @param image Decoded source PNG.
 * @returns XPM source text preserving the source dimensions.
 */
function createXpm({ width, height, data }: DecodedPng): string {
	const levels = 16;
	const colors = ['None'];
	for (let level = 0; level < levels; level++) {
		const value = Math.round(level * 255 / (levels - 1));
		colors.push(`#${value.toString(16).padStart(2, '0').repeat(3)}`);
	}
	assert.ok(colors.length <= xpmSymbols.length);

	const lines = [
		'/* XPM */',
		'static char * hucode_xpm[] = {',
		`"${width} ${height} ${colors.length} 1",`,
		`"${xpmSymbols[0]}\tc None",`
	];

	for (let index = 1; index < colors.length; index++) {
		lines.push(`"${xpmSymbols[index]}\tc ${colors[index]}",`);
	}

	for (let y = 0; y < height; y++) {
		let row = '';
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 4;
			if (data[offset + 3] < 128) {
				row += xpmSymbols[0];
				continue;
			}

			const luminance = Math.round(
				(data[offset] * 299 + data[offset + 1] * 587 +
					data[offset + 2] * 114) / 1000
			);
			const level = Math.round(luminance * (levels - 1) / 255);
			row += xpmSymbols[level + 1];
		}
		lines.push(`"${row}"${y === height - 1 ? '' : ','}`);
	}

	lines.push('};', '');
	return lines.join('\n');
}

/**
 * Derives Linux PNG and XPM payloads from the tracked Hucode app icon.
 */
export function deriveLinuxIconAssets(
	icns: Buffer
): { png: Buffer; xpm: string } {
	const png = extractIcnsEntry(icns, 'ic10');
	const decoded = parsePng(png);

	assert.strictEqual(decoded.width, 1024);
	assert.strictEqual(decoded.height, 1024);
	return { png, xpm: createXpm(decoded) };
}

/**
 * Generates Linux PNG and XPM icons from the tracked Hucode app icon.
 */
export async function generateLinuxIcons() {
	const icns = await fs.readFile(sourceIcns);
	const { png, xpm } = deriveLinuxIconAssets(icns);

	await fs.mkdir(path.join(outputRoot, 'rpm'), { recursive: true });
	await fs.writeFile(path.join(outputRoot, 'code.png'), png);
	await fs.writeFile(
		path.join(outputRoot, 'rpm', 'code.xpm'),
		xpm,
		'utf8'
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await generateLinuxIcons();
}
