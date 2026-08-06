/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../nls.js';
import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { Codicon } from '../../base/common/codicons.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import {
	Disposable,
	DisposableStore,
	toDisposable,
} from '../../base/common/lifecycle.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { Action2, registerAction2 } from
	'../../platform/actions/common/actions.js';
import { registerOmniShellAction2 } from './omniShellCommandRegistration.js';
import { HucodeMenuId } from
	'../../platform/actions/common/hucodeMenuIds.js';
import { Categories } from
	'../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from
	'../../platform/instantiation/common/instantiation.js';
import {
	ConfigurationScope,
	Extensions as ConfigurationExtensions,
	IConfigurationRegistry,
} from
	'../../platform/configuration/common/configurationRegistry.js';
import {
	ContextKeyExpr,
	type ContextKeyExpression,
	IContextKeyService,
} from
	'../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';
import {
	IsCompactTitleBarContext,
	IsHostedOmniWorkspaceContext,
} from
	'../../workbench/common/contextkeys.js';
import {
	IHucodeShellService,
	UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
} from '../common/omniWindow.js';
import { ToggleTitleBarConfigAction } from
	'../../workbench/browser/parts/titlebar/titlebarActions.js';
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
import {
	OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import {
	createLegacyHucodeHostedShellActionRequest,
	getHucodeHostedShellActionCommandId,
	HucodeHostedShellAction,
} from '../../platform/window/common/hucodeHostedShellActions.js';
import {
	HasLoadedWorkbenchContext,
	PROJECTS_TITLEBAR_CONTROLS_ENABLED_SETTING,
	ProjectsSidebarHiddenContext,
	ProjectsTitleBarControlsEnabledContext,
} from './omniProjectsSidebarActions.js';
import {
	ProjectSwitcherCanGoBackContext,
	ProjectSwitcherCanGoForwardContext,
} from './projectSwitcher/projectSwitcherCommon.js';
import './projectSwitcher/createProjectWorktree.contribution.js';
import './projectSwitcher/renameProjectWorktree.contribution.js';
import './projectSwitcher/switchProjectWorktree.contribution.js';
import {
	HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING,
	HUCODE_OMNI_ITEM_LAYOUT_DEFAULT,
	HUCODE_OMNI_SHOW_INLINE_ICONS_SETTING,
	HUCODE_OMNI_SHOW_WORKTREE_PATHS_SETTING,
	HUCODE_OMNI_TREE_INDENT_DEFAULT,
	HUCODE_OMNI_TREE_INDENT_MAXIMUM,
	HUCODE_OMNI_TREE_INDENT_MINIMUM,
	HUCODE_OMNI_TREE_INDENT_SETTING,
	HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING,
	HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING,
} from '../common/retainedWorkbench.js';
import { isHostedWorkspaceAvailable } from
	'../common/hostedWorkspaceState.js';

Registry.as<IConfigurationRegistry>(
	ConfigurationExtensions.Configuration
).registerConfiguration({
	id: 'hucode',
	order: 8,
	title: localize('hucodeConfigurationTitle', "Hucode"),
	type: 'object',
	properties: {
		[HUCODE_OMNI_TREE_INDENT_SETTING]: {
			type: 'number',
			default: HUCODE_OMNI_TREE_INDENT_DEFAULT,
			minimum: HUCODE_OMNI_TREE_INDENT_MINIMUM,
			maximum: HUCODE_OMNI_TREE_INDENT_MAXIMUM,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize(
				'hucode.omniTreeIndent',
				"Controls tree indentation in the Omni Projects sidebar."
			),
		},
		[HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING]: {
			type: 'string',
			enum: ['active', 'all', 'none'],
			default: 'active',
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize(
				'hucode.restoreHostedWorkbenches',
				"Controls which previously loaded Omni workbenches are restored immediately. Other loaded workbenches remain dormant until activated."
			),
		},
		[HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING]: {
			type: 'string',
			enum: ['twoLine', 'compact'],
			default: HUCODE_OMNI_ITEM_LAYOUT_DEFAULT,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize(
				'hucode.workbenchItemLayout',
				"Controls whether arbitrary workbenches use two lines or a compact single-line layout in the Omni sidebar."
			),
		},
		[HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING]: {
			type: 'string',
			enum: ['twoLine', 'compact'],
			default: HUCODE_OMNI_ITEM_LAYOUT_DEFAULT,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize(
				'hucode.worktreeItemLayout',
				"Controls whether project worktrees use a compact single-line or two-line layout in the Omni sidebar."
			),
		},
		[HUCODE_OMNI_SHOW_WORKTREE_PATHS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize(
				'hucode.showWorktreePaths',
				"Controls whether project worktrees show their paths in the Omni sidebar. Arbitrary workbench paths are always shown."
			),
		},
		[HUCODE_OMNI_SHOW_INLINE_ICONS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize(
				'hucode.showInlineIcons',
				"Controls whether branch and folder icons are shown beside inline metadata in the Omni sidebar."
			),
		},
		[PROJECTS_TITLEBAR_CONTROLS_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize(
				'hucode.projectsTitleBarControls',
				"Controls whether Hucode project controls are shown in the custom title bar when the Projects sidebar is hidden."
			),
		},
	},
});

class ToggleProjectTitleBarControls extends ToggleTitleBarConfigAction {

	constructor() {
		super(
			PROJECTS_TITLEBAR_CONTROLS_ENABLED_SETTING,
			localize('toggle.hucodeProjectControls', "Project Controls"),
			localize(
				'toggle.hucodeProjectControlsDescription',
				"Toggle visibility of Hucode project controls in the title bar"
			),
			3.5,
			ContextKeyExpr.and(
				IsHostedOmniWorkspaceContext,
				IsCompactTitleBarContext.toNegated()
			)
		);
	}
}

registerAction2(ToggleProjectTitleBarControls);

class HostedOmniWorkspaceReadyContribution extends Disposable
	implements IWorkbenchContribution {

	static readonly ID = 'hucode.hostedOmniWorkspaceReady';
	private static readonly READY_NOTIFICATION_RETRY_DELAYS = [
		0,
		250,
		1000,
		2500,
		5000,
		10000,
	];

	private readonly readyNotificationDisposables =
		this._register(new DisposableStore());
	private isDisposed = false;

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
		this.notifyHostedWorkspaceReadyWithRetry(
			shellService,
			windowId,
			environmentService.hostedInstanceId
		);

		const projectsSidebarHidden =
			ProjectsSidebarHiddenContext.bindTo(contextKeyService);
		const hasLoadedWorkbench =
			HasLoadedWorkbenchContext.bindTo(contextKeyService);
		const projectSwitcherCanGoBack =
			ProjectSwitcherCanGoBackContext.bindTo(contextKeyService);
		const projectSwitcherCanGoForward =
			ProjectSwitcherCanGoForwardContext.bindTo(contextKeyService);
		const updateShellStateContexts = (
			state: Awaited<ReturnType<IHucodeShellService['getWindowState']>>
		) => {
			projectsSidebarHidden.set(!state.projectsSidebarVisible);
			hasLoadedWorkbench.set(state.instances.some(
				isHostedWorkspaceAvailable
			));
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

	override dispose(): void {
		this.isDisposed = true;
		super.dispose();
	}

	private notifyHostedWorkspaceReadyWithRetry(
		shellService: IHucodeShellService,
		windowId: number,
		instanceId: string
	): void {
		this.scheduleHostedWorkspaceReadyNotification(
			shellService,
			windowId,
			instanceId,
			0
		);
	}

	private scheduleHostedWorkspaceReadyNotification(
		shellService: IHucodeShellService,
		windowId: number,
		instanceId: string,
		attemptIndex: number
	): void {
		if (
			this.isDisposed
			|| attemptIndex >= HostedOmniWorkspaceReadyContribution
				.READY_NOTIFICATION_RETRY_DELAYS.length
		) {
			return;
		}

		const delay = HostedOmniWorkspaceReadyContribution
			.READY_NOTIFICATION_RETRY_DELAYS[attemptIndex];
		const handle = setTimeout(() => {
			void this.notifyHostedWorkspaceReadyAndVerify(
				shellService,
				windowId,
				instanceId,
				attemptIndex
			);
		}, delay);
		this.readyNotificationDisposables.add(
			toDisposable(() => clearTimeout(handle))
		);
	}

	private async notifyHostedWorkspaceReadyAndVerify(
		shellService: IHucodeShellService,
		windowId: number,
		instanceId: string,
		attemptIndex: number
	): Promise<void> {
		let shouldRetry = false;
		try {
			await shellService.notifyHostedWorkspaceReady(
				windowId,
				instanceId
			);
			shouldRetry = await this.isHostedWorkspaceStillPendingReady(
				shellService,
				windowId,
				instanceId
			);
		} catch (error) {
			shouldRetry = true;
			if (this.isLastReadyNotificationAttempt(attemptIndex)) {
				onUnexpectedError(error);
			}
		}

		if (
			!shouldRetry
			|| this.isLastReadyNotificationAttempt(attemptIndex)
		) {
			return;
		}

		this.scheduleHostedWorkspaceReadyNotification(
			shellService,
			windowId,
			instanceId,
			attemptIndex + 1
		);
	}

	private async isHostedWorkspaceStillPendingReady(
		shellService: IHucodeShellService,
		windowId: number,
		instanceId: string
	): Promise<boolean> {
		const state = await shellService.getWindowState(windowId);
		return state.instances.some(instance =>
			instance.instanceId === instanceId &&
			(
				instance.state === 'restore-pending' ||
				instance.state === 'loading'
			)
		);
	}

	private isLastReadyNotificationAttempt(attemptIndex: number): boolean {
		return attemptIndex >= HostedOmniWorkspaceReadyContribution
			.READY_NOTIFICATION_RETRY_DELAYS.length - 1;
	}
}

registerWorkbenchContribution2(
	HostedOmniWorkspaceReadyContribution.ID,
	HostedOmniWorkspaceReadyContribution,
	WorkbenchPhase.AfterRestored
);

function registerHostedProjectSidebarCommand(
	action: HucodeHostedShellAction,
	title: ReturnType<typeof localize2>
): void {
	const id = getHucodeHostedShellActionCommandId(action);
	registerOmniShellAction2(id, class extends Action2 {
		constructor() {
			super({
				id,
				title,
				f1: true,
				precondition: IsHostedOmniWorkspaceContext,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const environmentService = accessor.get(IWorkbenchEnvironmentService);
			if (!environmentService.isHostedOmniWorkspace) {
				return;
			}

			await accessor.get(IHucodeShellService).runActionInShell(
				getWindowId(mainWindow),
				createLegacyHucodeHostedShellActionRequest(action)
			);
		}
	});
}

registerHostedProjectSidebarCommand(
	HucodeHostedShellAction.AddProject,
	localize2('addProject', 'Add Project')
);

registerHostedProjectSidebarCommand(
	HucodeHostedShellAction.RefreshProjects,
	localize2('refreshProjects', 'Refresh Projects')
);

registerHostedProjectSidebarCommand(
	HucodeHostedShellAction.CollapseProjects,
	localize2('collapseAllProjects', 'Collapse All')
);

registerOmniShellAction2(UNLOAD_CURRENT_WORKTREE_COMMAND_ID, class extends Action2 {
	constructor() {
		super({
			id: UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
			title: localize2(
				'hostedOmniUnloadCurrentWorktree',
				'Omni-Window: Unload Current Worktree'
			),
			f1: true,
			precondition: ContextKeyExpr.and(
				IsHostedOmniWorkspaceContext,
				HasLoadedWorkbenchContext
			),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		if (
			!environmentService.isHostedOmniWorkspace ||
			!environmentService.hostedInstanceId
		) {
			return;
		}

		await accessor.get(IHucodeShellService).closeWorkspace(
			getWindowId(mainWindow),
			environmentService.hostedInstanceId
		);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
			title: localize2(
				'hostedOmniReopenCurrentWorktreeInNewWindow',
				'Omni-Window: Re-open Current Worktree In New Window'
			),
			f1: true,
			precondition: ContextKeyExpr.and(
				IsHostedOmniWorkspaceContext,
				HasLoadedWorkbenchContext
			),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		if (
			!environmentService.isHostedOmniWorkspace ||
			!environmentService.hostedInstanceId
		) {
			return;
		}

		await accessor.get(IHucodeShellService).reopenWorkspaceInNormalWindow(
			getWindowId(mainWindow),
			environmentService.hostedInstanceId
		);
	}
});

function registerHostedProjectNavigationAction(
	action: HucodeHostedShellAction,
	title: ReturnType<typeof localize2>,
	icon: ThemeIcon,
	enabledContext: ContextKeyExpression,
	order: number
): void {
	const id = getHucodeHostedShellActionCommandId(action);
	registerOmniShellAction2(id, class extends Action2 {
		constructor() {
			super({
				id,
				title,
				icon,
				precondition: ContextKeyExpr.and(
					IsHostedOmniWorkspaceContext,
					ProjectsSidebarHiddenContext,
					ProjectsTitleBarControlsEnabledContext,
					enabledContext
				),
				menu: {
					id: HucodeMenuId.TitleBarLeft,
					group: 'navigation',
					when: ContextKeyExpr.and(
						IsHostedOmniWorkspaceContext,
						ProjectsSidebarHiddenContext,
						ProjectsTitleBarControlsEnabledContext
					),
					order,
				},
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IHucodeShellService).runActionInShell(
				getWindowId(mainWindow),
				createLegacyHucodeHostedShellActionRequest(action)
			);
		}
	});
}

registerHostedProjectNavigationAction(
	HucodeHostedShellAction.NavigateBack,
	localize2('hostedOmniGoBackWorktree', 'Go Back Project Worktree'),
	Codicon.arrowLeft,
	ProjectSwitcherCanGoBackContext,
	1
);

registerHostedProjectNavigationAction(
	HucodeHostedShellAction.NavigateForward,
	localize2('hostedOmniGoForwardWorktree', 'Go Forward Project Worktree'),
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
