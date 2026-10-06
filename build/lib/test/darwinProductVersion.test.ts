/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import { Readable } from 'stream';
import File from 'vinyl';
import { patchDarwinInfoPlistContents, patchDarwinInfoPlistVersion } from '../darwinProductVersion.ts';

const input = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Hucode</string>
	<key>CFBundleShortVersionString</key>
	<string>1.117.0</string>
	<key>CFBundleVersion</key>
	<string>1.117.0</string>
</dict>
</plist>`;

test('patchDarwinInfoPlistContents updates macOS bundle version fields', () => {
	const output = patchDarwinInfoPlistContents(input, '0.1.0').toString('utf8');

	assert.match(
		output,
		/<key>CFBundleShortVersionString<\/key>\s*<string>0\.1\.0<\/string>/
	);
	assert.match(output, /<key>CFBundleVersion<\/key>\s*<string>0\.1\.0<\/string>/);
});

test('patchDarwinInfoPlistVersion patches only the selected plists and keeps stream order', async () => {
	const files = ['Hucode.app/Contents/Info.plist', 'Hucode.app/Contents/Resources/other.plist']
		.map(relative => new File({ base: '/', path: `/${relative}`, contents: Buffer.from(input) }));

	const output: string[] = [];
	for await (const chunk of Readable.from(files).pipe(patchDarwinInfoPlistVersion('0.1.0', ['Hucode.app\\Contents\\Info.plist']))) {
		const file: File = chunk;
		const contents = file.contents!.toString();
		output.push(`${file.relative}: ${/<key>CFBundleVersion<\/key>\s*<string>(?<version>[^<]+)<\/string>/.exec(contents)?.groups?.version}`);
	}

	assert.deepStrictEqual(output, [
		'Hucode.app/Contents/Info.plist: 0.1.0',
		'Hucode.app/Contents/Resources/other.plist: 1.117.0',
	]);
});
