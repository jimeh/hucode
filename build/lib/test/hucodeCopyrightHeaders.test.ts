/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import { hasValidCopyrightHeader } from
	'../../hucode/copyright-headers.ts';

const borderStart =
	'/*---------------------------------------------------------------------------------------------';
const borderEnd =
	' *--------------------------------------------------------------------------------------------*/';
const microsoft =
	' *  Copyright (c) Microsoft Corporation. All rights reserved.';
const hucode =
	' *  Copyright (c) Hucode contributors. All rights reserved.';
const microsoftLicense =
	' *  Licensed under the MIT License. See License.txt in the project root for license information.';
const hucodeLicense =
	' *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.';

test('accepts the exact Microsoft copyright header', () => {
	assert.strictEqual(hasValidCopyrightHeader([
		borderStart,
		microsoft,
		microsoftLicense,
		borderEnd,
	]), true);
});

test('accepts the exact Hucode copyright header', () => {
	assert.strictEqual(hasValidCopyrightHeader([
		borderStart,
		hucode,
		hucodeLicense,
		borderEnd,
	]), true);
});

test('accepts the exact dual copyright header', () => {
	assert.strictEqual(hasValidCopyrightHeader([
		borderStart,
		microsoft,
		hucode,
		hucodeLicense,
		borderEnd,
	]), true);
});

test('rejects malformed or partial copyright headers', () => {
	assert.strictEqual(hasValidCopyrightHeader([
		borderStart,
		hucode,
		microsoftLicense,
		borderEnd,
	]), false);
	assert.strictEqual(hasValidCopyrightHeader([
		borderStart,
		microsoft,
		hucode,
		borderEnd,
	]), false);
	assert.strictEqual(hasValidCopyrightHeader([
		borderStart,
		' *  Copyright (c) Hucode contributor. All rights reserved.',
		hucodeLicense,
		borderEnd,
	]), false);
});
