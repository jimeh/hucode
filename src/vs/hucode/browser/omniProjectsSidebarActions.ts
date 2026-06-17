/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { Codicon } from '../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../base/common/keyCodes.js';
import { localize2 } from '../../nls.js';
import { Categories } from '../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from
	'../../platform/actions/common/actions.js';
import { HucodeMenuId } from
	'../../platform/actions/common/hucodeMenuIds.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from
	'../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from
	'../../platform/instantiation/common/instantiation.js';
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
import { IHucodeShellService } from '../common/omniWindow.js';
import { TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID } from
	'../../platform/window/common/hucodeOmniCommandRouting.js';
import { Menus } from './menus.js';

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

		if (
			HasLoadedWorkbenchContext.getValue(contextKeyService) !== true
		) {
			return;
		}

		if (environmentService.isHostedOmniWorkspace) {
			const wasHidden =
				ProjectsSidebarHiddenContext.getValue(contextKeyService) === true;
			const projectsSidebarHidden =
				ProjectsSidebarHiddenContext.bindTo(contextKeyService);
			if (wasHidden) {
				projectsSidebarHidden.set(false);
			}

			const didForward = await accessor.get(IHucodeShellService).runActionInShell(
				getWindowId(mainWindow),
				{ id: TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID, from: 'keybinding' }
			);
			if (!didForward) {
				projectsSidebarHidden.set(wasHidden);
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
