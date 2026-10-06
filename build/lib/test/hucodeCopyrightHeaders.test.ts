/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { RuleTester } from 'oxlint/plugins-dev';
import { EOL } from 'os';
import headerPlugin from '../../../.eslint-plugin-local/compat/header.ts';
import { getRepositoryFileRules } from '../oxlintConfig.ts';
import {
	canonicalCopyrightHeaders,
	copyrightHeaderEslintPattern,
	copyrightHeaderEslintTemplate,
	hasValidCopyrightHeader,
} from
	'../../hucode/copyright-headers.ts';

RuleTester.describe = suite;
RuleTester.it = test;

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

// oxlint runs the header rule of eslint.config.js through its in-repository port of
// eslint-plugin-header, so test the rule with the options the repository gives a Hucode file.
const headerRule = (await getRepositoryFileRules('src/vs/hucode/headerAutofixFixture.ts'))?.['header/header'];
// The options come from the configuration, so they are JSON values.
const headerRuleOptions = headerRule?.slice(1) as NonNullable<RuleTester.ValidTestCase['options']>;

test('oxlint configures the header rule for Hucode files', () => {
	assert.strictEqual(headerRule?.[0], 2);
});

suite('oxlint header autofix', () => {
	const source = 'export const headerFixture = true;\n';

	new RuleTester({ languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } } }).run('header', headerPlugin.rules.header, {
		valid: [],
		invalid: [{
			name: 'adds the canonical Hucode header',
			code: source,
			options: headerRuleOptions,
			output: `/*${copyrightHeaderEslintTemplate}*/${EOL}${source}`,
			errors: [{ message: 'missing header' }],
		}],
	});
});
