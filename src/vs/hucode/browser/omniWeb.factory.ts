/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mark } from '../../base/common/performance.js';
import { IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { DeferredPromise } from '../../base/common/async.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ILogService } from '../../platform/log/common/log.js';
import { BrowserMain, IBrowserMainWorkbench } from
	'../../workbench/browser/web.main.js';
import { IWorkbench, IWorkbenchConstructionOptions } from
	'../../workbench/browser/web.api.js';
import { Workbench } from './workbench.js';

let created = false;
const workbenchPromise = new DeferredPromise<IWorkbench>();

class HucodeOmniBrowserMain extends BrowserMain {
	protected override createWorkbench(
		domElement: HTMLElement,
		serviceCollection: ServiceCollection,
		logService: ILogService
	): IBrowserMainWorkbench {
		return new Workbench(
			domElement,
			{ extraClasses: ['hucode-omni-window', 'hucode-omni-web-window'] },
			serviceCollection,
			logService
		);
	}
}

/**
 * Creates the Hucode Omni web workbench shell.
 */
export function create(
	domElement: HTMLElement,
	options: IWorkbenchConstructionOptions
): IDisposable {
	mark('code/didLoadWorkbenchMain');

	if (created) {
		throw new Error('Unable to create the Hucode Omni workbench more than once.');
	}
	created = true;

	let instantiatedWorkbench: IWorkbench | undefined;
	const startup = (async () => {
		try {
			const workbench = await new HucodeOmniBrowserMain(
				domElement,
				options
			).open();
			instantiatedWorkbench = workbench;
			await workbenchPromise.complete(workbench);
		} catch (error) {
			await workbenchPromise.error(error);
		}
	})();

	return toDisposable(() => {
		if (instantiatedWorkbench) {
			instantiatedWorkbench.shutdown();
			return;
		}

		void startup.then(() => instantiatedWorkbench?.shutdown());
	});
}

/**
 * Returns the Omni web workbench startup promise for tests and adapters.
 */
export function whenHucodeOmniWebWorkbenchReady(): Promise<IWorkbench> {
	return workbenchPromise.p;
}
