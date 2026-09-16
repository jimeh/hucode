/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const microsoftCopyrightHeader = [
	'/*---------------------------------------------------------------------------------------------',
	' *  Copyright (c) Microsoft Corporation. All rights reserved.',
	' *  Licensed under the MIT License. See License.txt in the project root for license information.',
	' *--------------------------------------------------------------------------------------------*/',
] as const;

const hucodeCopyrightHeader = [
	'/*---------------------------------------------------------------------------------------------',
	' *  Copyright (c) Hucode contributors. All rights reserved.',
	' *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.',
	' *--------------------------------------------------------------------------------------------*/',
] as const;

const dualCopyrightHeader = [
	'/*---------------------------------------------------------------------------------------------',
	' *  Copyright (c) Microsoft Corporation. All rights reserved.',
	' *  Copyright (c) Hucode contributors. All rights reserved.',
	' *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.',
	' *--------------------------------------------------------------------------------------------*/',
] as const;

/**
 * Exact source headers accepted by Hucode's hygiene and ESLint checks.
 */
export const canonicalCopyrightHeaders = [
	microsoftCopyrightHeader,
	hucodeCopyrightHeader,
	dualCopyrightHeader,
] as const;

/**
 * Returns the inner block-comment body for a canonical source header.
 */
function commentBody(header: readonly string[]): string {
	return header.join('\n').slice(2, -2);
}

/**
 * Escapes regular-expression metacharacters for literal matching.
 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const canonicalCopyrightHeaderBodies =
	canonicalCopyrightHeaders.map(commentBody);

/**
 * Exact ESLint header pattern, accepting LF and CRLF line endings.
 */
export const copyrightHeaderEslintPattern = `^(?:${
	canonicalCopyrightHeaderBodies
		.map(body => escapeRegExp(body).replaceAll('\n', '\\r?\\n'))
		.join('|')
})$`;

/**
 * Canonical Hucode comment body used when ESLint adds a missing header.
 */
export const copyrightHeaderEslintTemplate =
	commentBody(hucodeCopyrightHeader);

/**
 * Checks whether source lines start with an exact supported copyright header.
 */
export function hasValidCopyrightHeader(lines: readonly string[]): boolean {
	return canonicalCopyrightHeaders.some(header =>
		header.every((line, index) => lines[index] === line)
	);
}
