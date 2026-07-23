/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MenuId } from './actions.js';

/**
 * Hucode-owned menu IDs used from upstream workbench integration points.
 */
export const HucodeMenuId = {
	TitleBarLeft: MenuId.for('HucodeOmniTitleBarLeft'),
} as const;
