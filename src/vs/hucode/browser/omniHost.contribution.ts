/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { INotificationService } from
	'../../platform/notification/common/notification.js';
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from '../../workbench/common/contributions.js';
import { IHostService } from '../../workbench/services/host/browser/host.js';
import { IViewsService } from
	'../../workbench/services/views/common/viewsService.js';
import { INativeWorkbenchEnvironmentService } from
	'../../workbench/services/environment/electron-browser/environmentService.js';
import {
	PROJECT_SWITCHER_VIEW_ID,
	getSelectedProjectSwitcherTarget,
} from '../../workbench/contrib/projectSwitcher/electron-browser/projectSwitcher.contribution.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../common/omniWindow.js';
import { IHucodeOmniWindowUIService } from './omniWindowUI.js';

async function openSelectedInOmniWindow(
	windowId: number,
	shellService: IHucodeShellService,
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

	return shellService.openWorkspace(
		windowId,
		selection.worktreePath,
		selection.projectId
	);
}

async function openSelectedInStandaloneWindow(
	hostService: IHostService,
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

	await hostService.openWindow(
		[{ folderUri: URI.file(selection.worktreePath) }],
		{ forceNewWindow: true }
	);
}

class OmniWindowShellContribution extends Disposable
	implements IWorkbenchContribution {

	static readonly ID = 'hucode.omniWindowShell';

	constructor(
		@INativeWorkbenchEnvironmentService
		private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IHucodeOmniWindowUIService
		private readonly omniWindowUIService: IHucodeOmniWindowUIService,
		@IViewsService
		private readonly viewsService: IViewsService,
		@IHucodeShellService
		private readonly shellService: IHucodeShellService,
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
				void this.viewsService.openView(PROJECT_SWITCHER_VIEW_ID, true);
			},
			openSelectedInOmni: async () => {
				const nextState = await openSelectedInOmniWindow(
					this.environmentService.window.id,
					this.shellService,
					this.notificationService
				);
				if (nextState) {
					await this.shellService.focusWorkspace(
						this.environmentService.window.id
					);
				}
			},
			openSelectedInStandalone: () => openSelectedInStandaloneWindow(
				this.hostService,
				this.notificationService
			),
			focusWorkspace: () =>
				this.shellService.focusWorkspace(
					this.environmentService.window.id
				),
			reloadWorkspace: () =>
				this.shellService.reloadWorkspace(
					this.environmentService.window.id
				),
			closeWorkspace: () =>
				this.shellService.closeWorkspace(
					this.environmentService.window.id
				).then(() => undefined),
		}));

	}
}

registerWorkbenchContribution2(
	OmniWindowShellContribution.ID,
	OmniWindowShellContribution,
	WorkbenchPhase.AfterRestored
);
