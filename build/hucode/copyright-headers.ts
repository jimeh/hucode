/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const microsoftCopyrightHeader = [
	'/*---------------------------------------------------------------------------------------------',
	' *  Copyright (c) Microsoft Corporation. All rights reserved.',
	' *  Licensed under the MIT License. See License.txt in the project root for license information.',
	' *--------------------------------------------------------------------------------------------*/',
];

const hucodeCopyrightHeader = [
	'/*---------------------------------------------------------------------------------------------',
	' *  Copyright (c) Hucode contributors. All rights reserved.',
	' *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.',
	' *--------------------------------------------------------------------------------------------*/',
];

const dualCopyrightHeader = [
	'/*---------------------------------------------------------------------------------------------',
	' *  Copyright (c) Microsoft Corporation. All rights reserved.',
	' *  Copyright (c) Hucode contributors. All rights reserved.',
	' *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.',
	' *--------------------------------------------------------------------------------------------*/',
];

const copyrightHeaders = [
	microsoftCopyrightHeader,
	hucodeCopyrightHeader,
	dualCopyrightHeader,
];

/**
 * Checks whether source lines start with an exact supported copyright header.
 */
export function hasValidCopyrightHeader(lines: readonly string[]): boolean {
	return copyrightHeaders.some(header =>
		header.every((line, index) => lines[index] === line)
	);
}
