/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import { patchDarwinInfoPlistContents } from '../darwinProductVersion.ts';

test('patchDarwinInfoPlistContents updates macOS bundle version fields', () => {
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

	const output = patchDarwinInfoPlistContents(input, '0.1.0').toString('utf8');

	assert.match(
		output,
		/<key>CFBundleShortVersionString<\/key>\s*<string>0\.1\.0<\/string>/
	);
	assert.match(output, /<key>CFBundleVersion<\/key>\s*<string>0\.1\.0<\/string>/);
});
