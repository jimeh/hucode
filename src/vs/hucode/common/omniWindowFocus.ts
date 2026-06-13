/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../base/common/errors.js';

export interface IHucodeWorkspaceFocusService {
	/** Focuses the active hosted workspace for the given Omni window. */
	focusWorkspace(windowId: number): Promise<void>;
}

/**
 * Focuses a hosted workspace without making the caller's primary operation fail.
 */
export async function focusWorkspaceBestEffort(
	shellService: IHucodeWorkspaceFocusService,
	windowId: number
): Promise<void> {
	try {
		await shellService.focusWorkspace(windowId);
	} catch (error) {
		onUnexpectedError(error);
	}
}
