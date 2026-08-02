/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ILogService } from '../../platform/log/common/log.js';
import { HucodeWebUserDataBrowserMain } from '../../workbench/browser/hucodeWebUserDataBrowserMain.js';
import { createWithBrowserMain } from '../../workbench/browser/web.factory.js';
import { IBrowserMainWorkbench } from '../../workbench/browser/web.main.js';
import { IWorkbenchConstructionOptions } from '../../workbench/browser/web.api.js';
import { Workbench } from './workbench.js';

class HucodeOmniWebUserDataBrowserMain extends HucodeWebUserDataBrowserMain {
	protected override createWorkbench(domElement: HTMLElement, serviceCollection: ServiceCollection, logService: ILogService): IBrowserMainWorkbench {
		return new Workbench(domElement, {
			extraClasses: ['hucode-omni-window', 'hucode-omni-web-window'],
			isWebOmniShell: true,
		}, serviceCollection, logService);
	}
}

/** Creates the Omni shell using server-authoritative user-data services. */
export function create(domElement: HTMLElement, options: IWorkbenchConstructionOptions) {
	return createWithBrowserMain(domElement, options, HucodeOmniWebUserDataBrowserMain);
}
