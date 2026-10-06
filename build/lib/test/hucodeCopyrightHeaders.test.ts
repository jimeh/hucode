/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'child_process';
import { test } from 'node:test';
import path from 'path';
import {
	canonicalCopyrightHeaders,
	copyrightHeaderEslintPattern,
	copyrightHeaderEslintTemplate,
	hasValidCopyrightHeader,
} from
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

/**
 * Returns the inner block-comment body used by the ESLint header rule.
 */
function commentBody(header: readonly string[]): string {
	return header.join('\n').slice(2, -2);
}

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

test('ESLint pattern accepts every canonical header with LF and CRLF', () => {
	const pattern = new RegExp(copyrightHeaderEslintPattern);

	for (const header of canonicalCopyrightHeaders) {
		const body = commentBody(header);
		assert.match(body, pattern);
		assert.match(body.replaceAll('\n', '\r\n'), pattern);
	}
});

test('ESLint default template is the canonical Hucode header body', () => {
	assert.strictEqual(
		copyrightHeaderEslintTemplate,
		commentBody(canonicalCopyrightHeaders[1])
	);
});

test('ESLint autofix adds the canonical Hucode header', () => {
	const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
	const eslintPath = path.join(
		repoRoot,
		'node_modules',
		'eslint',
		'bin',
		'eslint.js'
	);
	const source = 'export const headerFixture = true;\n';
	const result = spawnSync(
		process.execPath,
		[
			eslintPath,
			'--fix-dry-run',
			'--format',
			'json',
			'--stdin',
			'--stdin-filename',
			'src/vs/hucode/headerAutofixFixture.ts',
		],
		{
			cwd: repoRoot,
			encoding: 'utf8',
			input: source,
		}
	);

	assert.strictEqual(result.status, 0, result.stderr);
	const [{ output }] = JSON.parse(result.stdout) as [{ output: string }];
	assert.strictEqual(
		output,
		`/*${copyrightHeaderEslintTemplate}*/\n${source}`
	);
});
