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
import {
	focusWorkspaceBestEffort,
} from '../common/omniWindowFocus.js';
import {
	IHucodeShellService,
} from '../common/omniWindow.js';
import { IHucodeOmniWindowUIService } from './omniWindowUI.js';
import {
	openSelectionInOmniWindow,
	openSelectionInStandaloneWindow,
} from './omniSelectionOpen.js';

async function openSelectedInOmniWindow(
	windowId: number,
	shellService: IHucodeShellService,
	projectManagerService: IProjectManagerService,
	notificationService: INotificationService
): ReturnType<typeof openSelectionInOmniWindow> {
	return openSelectionInOmniWindow(
		getSelectedProjectSwitcherTarget(),
		windowId,
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
	shellService: IHucodeShellService,
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
		@IHucodeShellService
		private readonly shellService: IHucodeShellService,
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

		this._register(this.omniWindowUIService.registerDelegate({
			focusProjectPane: () => {
				this.layoutService.focusPart(Parts.SIDEBAR_PART);
			},
			openSelectedInOmni: async () => {
				const nextState = await openSelectedInOmniWindow(
					this.windowId,
					this.shellService,
					this.projectManagerService,
					this.notificationService
				);
				if (nextState) {
					await focusWorkspaceBestEffort(
						this.shellService,
						this.windowId
					);
				}
			},
			openSelectedInStandalone: () => openSelectedInStandaloneWindow(
				this.hostService,
				this.shellService,
				this.projectManagerService,
				this.notificationService
			),
			focusWorkspace: () =>
				this.shellService.focusWorkspace(
					this.windowId
				),
			reloadWorkspace: () =>
				this.shellService.reloadWorkspace(
					this.windowId
				),
			closeWorkspace: async () => {
				await this.shellService.closeWorkspace(
					this.windowId
				);
			},
		}));

		this.updateProjectsSidebarVisibility();
		this._register(this.layoutService.onDidChangePartVisibility(change => {
			if (change.partId === Parts.SIDEBAR_PART) {
				this.updateProjectsSidebarVisibility();
			}
		}));
	}

	private get windowId(): number {
		return getWindowId(mainWindow);
	}

	private updateProjectsSidebarVisibility(): void {
		void this.shellService.setProjectsSidebarVisible(
			this.windowId,
			this.layoutService.isVisible(Parts.SIDEBAR_PART)
		);
	}
}

registerWorkbenchContribution2(
	OmniWindowShellContribution.ID,
	OmniWindowShellContribution,
	WorkbenchPhase.AfterRestored
);
