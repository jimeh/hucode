/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { localize, localize2 } from '../../nls.js';
import { Categories } from '../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuRegistry, registerAction2 } from '../../platform/actions/common/actions.js';
import { Menus } from './menus.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../platform/theme/common/iconRegistry.js';
import { IsAuxiliaryWindowContext, IsWindowAlwaysOnTopContext } from '../../workbench/common/contextkeys.js';
import { IWorkbenchLayoutService, Parts } from '../../workbench/services/layout/browser/layoutService.js';

// Register Icons
const panelCloseIcon = registerIcon(
	'hucode-omni-panel-close',
	Codicon.close,
	localize('agentPanelCloseIcon', 'Icon to close the panel.')
);

class TogglePanelVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.omniTogglePanelVisibility';

	constructor() {
		super({
			id: TogglePanelVisibilityAction.ID,
			title: localize2('togglePanel', 'Toggle Panel Visibility'),
			category: Categories.View,
			f1: true,
			icon: panelCloseIcon,
			menu: [
				{
					id: Menus.PanelTitle,
					group: 'navigation',
					order: 2,
					when: IsAuxiliaryWindowContext.toNegated()
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		layoutService.setPartHidden(layoutService.isVisible(Parts.PANEL_PART), Parts.PANEL_PART);
	}
}

registerAction2(TogglePanelVisibilityAction);

// Floating window controls: always-on-top
MenuRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
	command: {
		id: 'workbench.action.toggleWindowAlwaysOnTop',
		title: localize('toggleWindowAlwaysOnTop', "Toggle Always on Top"),
		icon: Codicon.pin,
		toggled: {
			condition: IsWindowAlwaysOnTopContext,
			icon: Codicon.pinned,
		},
	},
	when: IsAuxiliaryWindowContext,
	group: 'navigation',
	order: 0
});
