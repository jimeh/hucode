/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MaybePromise } from '../../../../base/common/async.js';

/**
 * Browser unload cannot await terminal confirmation without turning the
 * returned promise itself into a veto.
 */
export function prepareTerminalShutdown(
	isBrowser: boolean,
	prepareDesktopShutdown: () => MaybePromise<boolean>
): MaybePromise<boolean> {
	return isBrowser ? false : prepareDesktopShutdown();
}
