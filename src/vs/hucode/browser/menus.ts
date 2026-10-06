/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MenuId } from '../../platform/actions/common/actions.js';

/**
 * Menu IDs for the Omni shell layout.
 */
export const Menus = {
	CommandCenter: new MenuId('HucodeOmniCommandCenter'),
	CommandCenterCenter: new MenuId('HucodeOmniCommandCenterCenter'),
	TitleBarContext: new MenuId('HucodeOmniTitleBarContext'),
	TitleBarLeftLayout: new MenuId('HucodeOmniTitleBarLeftLayout'),
	TitleBarSessionTitle: new MenuId('HucodeOmniTitleBarSessionTitle'),
	TitleBarSessionMenu: new MenuId('HucodeOmniTitleBarSessionMenu'),
	TitleBarRightLayout: new MenuId('HucodeOmniTitleBarRightLayout'),
	PanelTitle: new MenuId('HucodeOmniPanelTitle'),
	SidebarTitle: new MenuId('HucodeOmniSidebarTitle'),
	SidebarTitleNavigation: new MenuId('HucodeOmniSidebarTitleNavigation'),
	SidebarSessionsHeader: new MenuId('HucodeOmniSidebarHeader'),
	AuxiliaryBarTitle: new MenuId('HucodeOmniAuxiliaryBarTitle'),
	AuxiliaryBarTitleLeft: new MenuId('HucodeOmniAuxiliaryBarTitleLeft'),
	SidebarFooter: new MenuId('HucodeOmniSidebarFooter'),
	SidebarCustomizations: new MenuId('HucodeOmniSidebarCustomizations'),
	AgentFeedbackEditorContent: new MenuId('AgentFeedbackEditorContent'),

	NewSessionRepositoryConfig: new MenuId(
		'HucodeOmni.RepositoryConfigMenu'
	),
	NewSessionConfig: new MenuId('HucodeOmni.SessionConfigMenu'),
	NewSessionControl: new MenuId('HucodeOmni.SessionControlMenu'),
} as const;
