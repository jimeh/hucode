/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';

/**
 * Repository-pinned checksums used by Electron prefetch and packaging.
 */
export const ELECTRON_CHECKSUM_FILE = path.resolve(
	import.meta.dirname,
	'..',
	'checksums',
	'electron.txt'
);
