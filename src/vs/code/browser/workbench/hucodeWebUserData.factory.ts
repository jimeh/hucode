/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createWithBrowserMain } from '../../../workbench/browser/web.factory.js';
import { HucodeWebUserDataBrowserMain } from '../../../workbench/browser/hucodeWebUserDataBrowserMain.js';
import { IWorkbenchConstructionOptions } from '../../../workbench/browser/web.api.js';

/** Creates a regular workbench using server-authoritative user-data services. */
export function create(domElement: HTMLElement, options: IWorkbenchConstructionOptions) {
	return createWithBrowserMain(domElement, options, HucodeWebUserDataBrowserMain);
}
