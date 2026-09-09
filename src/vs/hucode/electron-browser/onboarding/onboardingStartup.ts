/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IHucodeShellControllerService } from '../../../platform/window/common/hucodeShellControllerService.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../workbench/common/contributions.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../workbench/services/environment/common/environmentService.js';
import { ILifecycleService, LifecyclePhase } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { openSetupModalEditor } from '../setupModalEditors.js';
import { OnboardingEditorInput } from './onboardingEditorInput.js';

/** Opens one admitted setup modal after shell restoration; shutdown cancels pending activation. */
class OnboardingStartup extends Disposable {
	static readonly ID = 'hucode.onboarding.startup';
	constructor(
		@IEditorService editorService: IEditorService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IProductService productService: IProductService,
		@IHucodeShellControllerService shellService: IHucodeShellControllerService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService logService: ILogService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		let shuttingDown = false;
		this._register(lifecycleService.onWillShutdown(() => { shuttingDown = true; }));
		if (!productService.hucodeVersion || !environmentService.isOmniShellWindow || environmentService.skipWelcome || environmentService.extensionTestsLocationURI) {
			return;
		}
		void (async () => {
			await lifecycleService.when(LifecyclePhase.Restored);
			if (shuttingDown) {
				return;
			}
			await openSetupModalEditor(editorService, () => new OnboardingEditorInput(), async () => !shuttingDown && await shellService.admitOnboarding() && !shuttingDown);
		})().catch(error => {
			logService.error(error);
			notificationService.error(error);
		});
	}
}

registerWorkbenchContribution2(OnboardingStartup.ID, OnboardingStartup, WorkbenchPhase.AfterRestored);
