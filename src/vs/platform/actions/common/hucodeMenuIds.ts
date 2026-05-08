/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MenuId } from './actions.js';

/**
 * Hucode-owned menu IDs used from upstream workbench integration points.
 */
export const HucodeMenuId = {
	TitleBarLeft: MenuId.for('HucodeOmniTitleBarLeft'),
} as const;
