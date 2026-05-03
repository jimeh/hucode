/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../nls.js';
import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { Action2, registerAction2 } from
	'../../platform/actions/common/actions.js';
import { Categories } from
	'../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from
	'../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from
	'../../platform/contextkey/common/contextkey.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';
import { IsHostedOmniWorkspaceContext } from
	'../../workbench/common/contextkeys.js';
import { IHucodeShellService } from '../common/omniWindow.js';
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from '../../workbench/common/contributions.js';
import { IsDevelopmentContext } from
	'../../platform/contextkey/common/contextkeys.js';
import { KeyCode, KeyMod } from '../../base/common/keyCodes.js';
import { KeybindingWeight } from
	'../../platform/keybinding/common/keybindingsRegistry.js';
import './projectSwitcher/createProjectWorktree.contribution.js';
import './projectSwitcher/renameProjectWorktree.contribution.js';
import './projectSwitcher/switchProjectWorktree.contribution.js';

class HostedOmniWorkspaceReadyContribution implements IWorkbenchContribution {

	static readonly ID = 'hucode.hostedOmniWorkspaceReady';

	constructor(
		@IWorkbenchEnvironmentService
		environmentService: IWorkbenchEnvironmentService,
		@IHucodeShellService shellService: IHucodeShellService,
	) {
		if (
			!environmentService.isHostedOmniWorkspace
			|| !environmentService.hostedInstanceId
		) {
			return;
		}

		void shellService.notifyHostedWorkspaceReady(
			getWindowId(mainWindow),
			environmentService.hostedInstanceId
		);
	}
}

registerWorkbenchContribution2(
	HostedOmniWorkspaceReadyContribution.ID,
	HostedOmniWorkspaceReadyContribution,
	WorkbenchPhase.AfterRestored
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.hucode.reloadHostedOmniWorkspace',
			title: localize2(
				'reloadHostedOmniWorkspace',
				'Reload Hosted Workbench'
			),
			category: Categories.Developer,
			f1: true,
			precondition: IsHostedOmniWorkspaceContext,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: ContextKeyExpr.and(
					IsDevelopmentContext,
					IsHostedOmniWorkspaceContext
				),
				primary: KeyMod.CtrlCmd | KeyCode.KeyR
			}
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHucodeShellService).reloadWorkspace(
			getWindowId(mainWindow)
		);
	}
});
