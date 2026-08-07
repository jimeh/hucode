/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { Codicon } from '../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../base/common/keyCodes.js';
import { localize, localize2 } from '../../nls.js';
import { Categories } from '../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from
	'../../platform/actions/common/actions.js';
import { HucodeMenuId } from
	'../../platform/actions/common/hucodeMenuIds.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from
	'../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from
	'../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { INotificationService } from
	'../../platform/notification/common/notification.js';
import { KeybindingWeight } from
	'../../platform/keybinding/common/keybindingsRegistry.js';
import {
	IsHostedOmniWorkspaceContext,
	IsOmniWindowContext,
} from '../../workbench/common/contextkeys.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';
import {
	IWorkbenchLayoutService,
	Parts,
} from '../../workbench/services/layout/browser/layoutService.js';
import { HucodeHostedShellAction } from
	'../../platform/window/common/hucodeHostedShellActions.js';
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
	isHucodeHostedShellServiceAvailable,
} from '../../platform/window/common/hucodeHostedShellService.js';
import {
	CLOSE_WORKSPACE_COMMAND_ID,
	TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
	UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
} from
	'../../platform/window/common/hucodeOmniCommandRouting.js';
import { Menus } from './menus.js';
import { registerOmniShellAction2 } from
	'./omniShellCommandRegistration.js';

export { TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID };

export const PROJECTS_TITLEBAR_CONTROLS_ENABLED_SETTING =
	'hucode.omni.titleBar.projectControls.enabled';

export const ProjectsSidebarHiddenContext = new RawContextKey<boolean>(
	'hucode.projectsSidebarHidden',
	false
);

export const HasLoadedWorkbenchContext = new RawContextKey<boolean>(
	'hucode.hasLoadedWorkbench',
	false
);

const hostedShellCapabilityUnavailable = localize(
	'hostedShellCapabilityUnavailable',
	'Hosted shell capability is unavailable.'
);
const noCurrentWorktreeToUnload = localize(
	'noCurrentWorktreeToUnload',
	'There is no current worktree to unload.'
);

/** Keeps accepted outcomes silent and turns failures into localized notices. */
export function notifyHucodeHostedOperationOutcome(
	operation: string,
	outcome: HucodeHostedShellOperationOutcome,
	notificationService: INotificationService
): void {
	let message: string;
	switch (outcome) {
		case HucodeHostedShellOperationOutcome.Accepted:
		case HucodeHostedShellOperationOutcome.Superseded:
			return;
		case HucodeHostedShellOperationOutcome.Rejected:
			message = localize(
				'hostedShellOperationRejected',
				'{0} was rejected by the Omni shell.',
				operation
			);
			break;
		case HucodeHostedShellOperationOutcome.Stale:
			message = localize(
				'hostedShellOperationStale',
				'{0} could not run because this workbench is no longer connected to the current Omni shell.',
				operation
			);
			break;
		case HucodeHostedShellOperationOutcome.Unavailable:
			message = localize(
				'hostedShellOperationUnavailable',
				'{0} could not run because the Omni shell connection is unavailable.',
				operation
			);
			break;
		case HucodeHostedShellOperationOutcome.Unsupported:
			message = localize(
				'hostedShellOperationUnsupported',
				'{0} is not supported by this Omni shell.',
				operation
			);
			break;
		default:
			message = localize(
				'hostedShellOperationUnknown',
				'{0} could not be completed.',
				operation
			);
	}
	notificationService.error(message);
}

registerOmniShellAction2(UNLOAD_CURRENT_WORKTREE_COMMAND_ID, class extends Action2 {
	constructor() {
		super({
			id: UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
			title: localize2(
				'omniWindowUnloadCurrentWorktree',
				'Omni-Window: Unload Current Worktree'
			),
			f1: true,
			precondition: ContextKeyExpr.or(
				IsOmniWindowContext,
				IsHostedOmniWorkspaceContext
			),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const contextKeyService = accessor.get(IContextKeyService);
		const notificationService = accessor.get(INotificationService);
		if (environmentService.isHostedOmniWorkspace) {
			const shellService = accessor.get(IHucodeHostedShellService);
			if (!isHucodeHostedShellServiceAvailable(shellService)) {
				notificationService.error(hostedShellCapabilityUnavailable);
				return;
			}
			notifyHucodeHostedOperationOutcome(
				localize('unloadCurrentWorkbench', 'Unload Current Worktree'),
				await shellService.closeSelf(),
				notificationService
			);
			return;
		}
		if (!environmentService.isOmniWindow) {
			return;
		}
		if (HasLoadedWorkbenchContext.getValue(contextKeyService) !== true) {
			notificationService.error(noCurrentWorktreeToUnload);
			return;
		}
		await accessor.get(ICommandService).executeCommand(
			CLOSE_WORKSPACE_COMMAND_ID
		);
	}
});

export const ProjectsTitleBarControlsEnabledContext = ContextKeyExpr.equals(
	`config.${PROJECTS_TITLEBAR_CONTROLS_ENABLED_SETTING}`,
	true
);

const OmniShellOrHostedWorkspaceContext = ContextKeyExpr.or(
	IsOmniWindowContext,
	IsHostedOmniWorkspaceContext
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
			title: localize2(
				'omniWindowToggleProjectsSidebar',
				'Omni-Window: Toggle Projects Sidebar'
			),
			category: Categories.View,
			icon: Codicon.layoutSidebarLeft,
			f1: true,
			precondition: ContextKeyExpr.and(
				OmniShellOrHostedWorkspaceContext,
				HasLoadedWorkbenchContext
			),
			menu: [
				{
					id: Menus.SidebarTitleNavigation,
					group: 'navigation',
					when: IsOmniWindowContext,
					order: 0,
				},
				{
					id: HucodeMenuId.TitleBarLeft,
					group: 'navigation',
					when: ContextKeyExpr.and(
						IsHostedOmniWorkspaceContext,
						ProjectsSidebarHiddenContext,
						ProjectsTitleBarControlsEnabledContext
					),
					order: 0,
				},
			],
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: ContextKeyExpr.and(
					OmniShellOrHostedWorkspaceContext,
					HasLoadedWorkbenchContext
				),
				primary: 0,
				mac: {
					primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyP,
				},
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const contextKeyService = accessor.get(IContextKeyService);
		const notificationService = accessor.get(INotificationService);

		if (
			HasLoadedWorkbenchContext.getValue(contextKeyService) !== true
		) {
			return;
		}

		if (environmentService.isHostedOmniWorkspace) {
			const shellService = accessor.get(IHucodeHostedShellService);
			if (!isHucodeHostedShellServiceAvailable(shellService)) {
				notificationService.error(hostedShellCapabilityUnavailable);
				return;
			}
			const wasHidden =
				ProjectsSidebarHiddenContext.getValue(contextKeyService) === true;
			const projectsSidebarHidden =
				ProjectsSidebarHiddenContext.bindTo(contextKeyService);
			if (wasHidden) {
				projectsSidebarHidden.set(false);
			}

			const outcome = await shellService.requestShellAction(
				HucodeHostedShellAction.ToggleProjectsSidebar
			);
			if (outcome !== HucodeHostedShellOperationOutcome.Accepted) {
				projectsSidebarHidden.set(wasHidden);
				notifyHucodeHostedOperationOutcome(
					localize('toggleProjectsSidebar', 'Toggle Projects Sidebar'),
					outcome,
					notificationService
				);
				return;
			}

			if (!wasHidden) {
				mainWindow.requestAnimationFrame(() => {
					if (
						ProjectsSidebarHiddenContext.getValue(contextKeyService)
						=== wasHidden
					) {
						projectsSidebarHidden.set(true);
					}
				});
			}
			return;
		}

		if (!environmentService.isOmniWindow) {
			return;
		}

		const layoutService = accessor.get(IWorkbenchLayoutService);
		const isVisible = layoutService.isVisible(Parts.SIDEBAR_PART);
		layoutService.setPartHidden(isVisible, Parts.SIDEBAR_PART);
	}
});
