/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { KeyCode, KeyMod } from '../../base/common/keyCodes.js';
import { localize2 } from '../../nls.js';
import { Categories } from '../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from
	'../../platform/actions/common/actions.js';
import { ContextKeyExpr } from
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

export const TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID =
	'workbench.action.omniWindow.toggleProjectsSidebar';

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
			f1: true,
			precondition: OmniShellOrHostedWorkspaceContext,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: OmniShellOrHostedWorkspaceContext,
				primary: 0,
				mac: {
					primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyP,
				},
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const environmentService = accessor.get(IWorkbenchEnvironmentService);

		if (environmentService.isHostedOmniWorkspace) {
			await accessor.get(IHucodeShellService).runActionInShell(
				getWindowId(mainWindow),
				{ id: TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID, from: 'keybinding' }
			);
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
