/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
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
	setLastActiveWorktreeBestEffort,
} from './projectSwitcher/switchProjectWorktree.contribution.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../common/omniWindow.js';
import { IHucodeOmniWindowUIService } from './omniWindowUI.js';

async function openSelectedInOmniWindow(
	windowId: number,
	shellService: IHucodeShellService,
	projectManagerService: IProjectManagerService,
	notificationService: INotificationService
): Promise<IHucodeHostedWorkspaceState | undefined> {
	const selection = getSelectedProjectSwitcherTarget();
	if (!selection) {
		notificationService.info(localize(
			'omniSelectWorktreeFirst',
			'Select a project or worktree first.'
		));
		return undefined;
	}

	await setLastActiveWorktreeBestEffort(
		projectManagerService,
		selection.projectId,
		selection.worktreePath
	);

	return shellService.openWorkspace(
		windowId,
		selection.worktreePath,
		selection.projectId
	);
}

async function openSelectedInStandaloneWindow(
	hostService: IHostService,
	projectManagerService: IProjectManagerService,
	notificationService: INotificationService
): Promise<void> {
	const selection = getSelectedProjectSwitcherTarget();
	if (!selection) {
		notificationService.info(localize(
			'omniSelectWorktreeFirstStandalone',
			'Select a project or worktree first.'
		));
		return;
	}

	await setLastActiveWorktreeBestEffort(
		projectManagerService,
		selection.projectId,
		selection.worktreePath
	);

	await hostService.openWindow(
		[{ folderUri: URI.file(selection.worktreePath) }],
		{ forceNewWindow: true }
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
					await this.shellService.focusWorkspace(
						this.windowId
					);
				}
			},
			openSelectedInStandalone: () => openSelectedInStandaloneWindow(
				this.hostService,
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
			closeWorkspace: () =>
				this.shellService.closeWorkspace(
					this.windowId
				).then(() => undefined),
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
