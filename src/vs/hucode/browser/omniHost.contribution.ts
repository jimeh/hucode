/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { localize } from '../../nls.js';
import { INotificationService } from
	'../../platform/notification/common/notification.js';
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from '../../workbench/common/contributions.js';
import { IProjectManagerService } from
	'../../platform/projectManager/common/projectManager.js';
import { IHostService } from '../../workbench/services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from
	'../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';
import {
	getSelectedProjectSwitcherTarget,
} from './projectSwitcher/projectSwitcher.contribution.js';
import { IHucodeShellControllerService } from
	'../../platform/window/common/hucodeShellControllerService.js';
import { IHucodeOmniWindowUIService } from './omniWindowUI.js';
import {
	openSelectionInOmniWindow,
	openSelectionInStandaloneWindow,
} from './omniSelectionOpen.js';
import {
	IHucodeOmniSmokeTestDriverTarget,
	registerOmniSmokeTestDriver,
} from './omniSmokeTestDriver.js';

async function openSelectedInOmniWindow(
	shellService: IHucodeShellControllerService,
	projectManagerService: IProjectManagerService,
	notificationService: INotificationService
): ReturnType<typeof openSelectionInOmniWindow> {
	return openSelectionInOmniWindow(
		getSelectedProjectSwitcherTarget(),
		shellService,
		projectManagerService,
		notificationService,
		localize(
			'omniSelectWorktreeFirst',
			'Select a project or worktree first.'
		)
	);
}

async function openSelectedInStandaloneWindow(
	hostService: IHostService,
	shellService: IHucodeShellControllerService,
	projectManagerService: IProjectManagerService,
	notificationService: INotificationService
): Promise<void> {
	return openSelectionInStandaloneWindow(
		getSelectedProjectSwitcherTarget(),
		hostService,
		shellService,
		projectManagerService,
		notificationService,
		localize(
			'omniSelectWorktreeFirstStandalone',
			'Select a project or worktree first.'
		)
	);
}

class OmniWindowShellContribution extends Disposable
	implements IWorkbenchContribution {

	static readonly ID = 'hucode.omniWindowShell';

	constructor(
		@IWorkbenchEnvironmentService
		private readonly environmentService: IWorkbenchEnvironmentService,
		@IHucodeOmniWindowUIService
		private readonly omniWindowUIService: IHucodeOmniWindowUIService,
		@IWorkbenchLayoutService
		private readonly layoutService: IWorkbenchLayoutService,
		@IHucodeShellControllerService
		private readonly shellService: IHucodeShellControllerService,
		@IProjectManagerService
		private readonly projectManagerService: IProjectManagerService,
		@IHostService
		private readonly hostService: IHostService,
		@INotificationService
		private readonly notificationService: INotificationService,
	) {
		super();

		if (!this.environmentService.isOmniWindow) {
			return;
		}

		this._register(registerOmniSmokeTestDriver({
			target: mainWindow as IHucodeOmniSmokeTestDriverTarget,
			enableSmokeTestDriver:
				!!this.environmentService.enableSmokeTestDriver,
			isOmniWindow: this.environmentService.isOmniWindow,
			windowId: getWindowId(mainWindow),
			suspendWorkspace: (_windowId, instanceId) =>
				this.shellService.suspendWorkspace(instanceId),
		}));

		this._register(this.omniWindowUIService.registerDelegate({
			focusProjectPane: () => {
				this.layoutService.focusPart(Parts.SIDEBAR_PART);
			},
			openSelectedInOmni: async () => {
				const nextState = await openSelectedInOmniWindow(
					this.shellService,
					this.projectManagerService,
					this.notificationService
				);
				if (nextState) {
					await this.shellService.focusWorkspace();
				}
			},
			openSelectedInStandalone: () => openSelectedInStandaloneWindow(
				this.hostService,
				this.shellService,
				this.projectManagerService,
				this.notificationService
			),
			focusWorkspace: () =>
				this.shellService.focusWorkspace(),
			reloadWorkspace: () =>
				this.shellService.reloadWorkspace(),
			closeWorkspace: async () => {
				await this.shellService.closeWorkspace();
			},
		}));

		this.updateProjectsSidebarVisibility();
		this._register(this.layoutService.onDidChangePartVisibility(change => {
			if (change.partId === Parts.SIDEBAR_PART) {
				this.updateProjectsSidebarVisibility();
			}
		}));
	}

	private updateProjectsSidebarVisibility(): void {
		void this.shellService.setProjectsSidebarVisible(
			this.layoutService.isVisible(Parts.SIDEBAR_PART)
		);
	}
}

registerWorkbenchContribution2(
	OmniWindowShellContribution.ID,
	OmniWindowShellContribution,
	WorkbenchPhase.AfterRestored
);
