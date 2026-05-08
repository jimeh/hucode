/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../nls.js';
import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { Codicon } from '../../base/common/codicons.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { Action2, registerAction2 } from
	'../../platform/actions/common/actions.js';
import { HucodeMenuId } from
	'../../platform/actions/common/hucodeMenuIds.js';
import { Categories } from
	'../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from
	'../../platform/instantiation/common/instantiation.js';
import {
	ContextKeyExpr,
	type ContextKeyExpression,
	IContextKeyService,
} from
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
import { ProjectsSidebarHiddenContext } from './omniProjectsSidebarActions.js';
import {
	GO_BACK_WORKTREE_COMMAND_ID,
	GO_FORWARD_WORKTREE_COMMAND_ID,
	ProjectSwitcherCanGoBackContext,
	ProjectSwitcherCanGoForwardContext,
} from './projectSwitcher/projectSwitcherCommon.js';
import './projectSwitcher/createProjectWorktree.contribution.js';
import './projectSwitcher/renameProjectWorktree.contribution.js';
import './projectSwitcher/switchProjectWorktree.contribution.js';

class HostedOmniWorkspaceReadyContribution extends Disposable
	implements IWorkbenchContribution {

	static readonly ID = 'hucode.hostedOmniWorkspaceReady';

	constructor(
		@IWorkbenchEnvironmentService
		environmentService: IWorkbenchEnvironmentService,
		@IHucodeShellService shellService: IHucodeShellService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		if (
			!environmentService.isHostedOmniWorkspace
			|| !environmentService.hostedInstanceId
		) {
			return;
		}

		const windowId = getWindowId(mainWindow);
		void shellService.notifyHostedWorkspaceReady(
			windowId,
			environmentService.hostedInstanceId
		);

		const projectsSidebarHidden =
			ProjectsSidebarHiddenContext.bindTo(contextKeyService);
		const projectSwitcherCanGoBack =
			ProjectSwitcherCanGoBackContext.bindTo(contextKeyService);
		const projectSwitcherCanGoForward =
			ProjectSwitcherCanGoForwardContext.bindTo(contextKeyService);
		const updateShellStateContexts = (
			state: Awaited<ReturnType<IHucodeShellService['getWindowState']>>
		) => {
			projectsSidebarHidden.set(!state.projectsSidebarVisible);
			projectSwitcherCanGoBack.set(state.projectSwitcherCanGoBack);
			projectSwitcherCanGoForward.set(state.projectSwitcherCanGoForward);
		};

		void shellService.getWindowState(windowId).then(state => {
			updateShellStateContexts(state);
		});

		this._register(shellService.onDidChangeWindowState(change => {
			if (change.windowId === windowId) {
				updateShellStateContexts(change.state);
			}
		}));
	}
}

registerWorkbenchContribution2(
	HostedOmniWorkspaceReadyContribution.ID,
	HostedOmniWorkspaceReadyContribution,
	WorkbenchPhase.AfterRestored
);

function registerHostedProjectNavigationAction(
	id: string,
	title: ReturnType<typeof localize2>,
	icon: ThemeIcon,
	enabledContext: ContextKeyExpression,
	order: number
): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				title,
				icon,
				precondition: ContextKeyExpr.and(
					IsHostedOmniWorkspaceContext,
					ProjectsSidebarHiddenContext,
					enabledContext
				),
				menu: {
					id: HucodeMenuId.TitleBarLeft,
					group: 'navigation',
					when: ContextKeyExpr.and(
						IsHostedOmniWorkspaceContext,
						ProjectsSidebarHiddenContext
					),
					order,
				},
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IHucodeShellService).runActionInShell(
				getWindowId(mainWindow),
				{ id, from: 'mouse' }
			);
		}
	});
}

registerHostedProjectNavigationAction(
	GO_BACK_WORKTREE_COMMAND_ID,
	localize2('hostedOmniGoBackWorktree', 'Go Back'),
	Codicon.arrowLeft,
	ProjectSwitcherCanGoBackContext,
	1
);

registerHostedProjectNavigationAction(
	GO_FORWARD_WORKTREE_COMMAND_ID,
	localize2('hostedOmniGoForwardWorktree', 'Go Forward'),
	Codicon.arrowRight,
	ProjectSwitcherCanGoForwardContext,
	2
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
