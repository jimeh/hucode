/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for
 *  license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatBarPart.css';
import { IContextKeyService } from
	'../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from
	'../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from
	'../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from
	'../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from
	'../../../platform/notification/common/notification.js';
import { IStorageService } from
	'../../../platform/storage/common/storage.js';
import { IThemeService } from
	'../../../platform/theme/common/themeService.js';
import {
	ACTIVITY_BAR_BADGE_BACKGROUND,
	ACTIVITY_BAR_BADGE_FOREGROUND,
	PANEL_ACTIVE_TITLE_BORDER,
	PANEL_ACTIVE_TITLE_FOREGROUND,
	PANEL_BORDER,
	PANEL_DRAG_AND_DROP_BORDER,
	PANEL_INACTIVE_TITLE_FOREGROUND,
	SIDE_BAR_FOREGROUND,
	SIDE_BAR_TITLE_BORDER,
} from '../../../workbench/common/theme.js';
import { contrastBorder } from
	'../../../platform/theme/common/colorRegistry.js';
import { sessionsChatBarBackground } from
	'../../common/theme.js';
import {
	IViewDescriptorService,
	ViewContainerLocation,
} from '../../../workbench/common/views.js';
import { IExtensionService } from
	'../../../workbench/services/extensions/common/extensions.js';
import {
	IWorkbenchLayoutService,
	Parts,
} from '../../../workbench/services/layout/browser/layoutService.js';
import { HoverPosition } from
	'../../../base/browser/ui/hover/hoverWidget.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { LayoutPriority } from
	'../../../base/browser/ui/splitview/splitview.js';
import {
	AbstractPaneCompositePart,
	CompositeBarPosition,
} from '../../../workbench/browser/parts/paneCompositePart.js';
import { Part } from '../../../workbench/browser/part.js';
import { ActionsOrientation } from
	'../../../base/browser/ui/actionbar/actionbar.js';
import { IPaneCompositeBarOptions } from
	'../../../workbench/browser/parts/paneCompositeBar.js';
import { IMenuService } from
	'../../../platform/actions/common/actions.js';
import { IHoverService } from
	'../../../platform/hover/browser/hover.js';
import { Extensions } from '../../../workbench/browser/panecomposite.js';
import { Menus } from '../menus.js';
import {
	ActiveChatBarContext,
	ChatBarFocusContext,
} from '../../../sessions/common/contextkeys.js';

/**
 * Omni-specific main host pane. This keeps the local Omni shell geometry and
 * removes any shell-owned tab strip from the hosted workspace area.
 */
export class OmniChatBarPart extends AbstractPaneCompositePart {

	static readonly activeViewSettingsKey = 'workbench.chatbar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.chatbar.pinnedPanels';
	static readonly placeholderViewContainersKey =
		'workbench.chatbar.placeholderPanels';
	static readonly viewContainersWorkspaceStateKey =
		'workbench.chatbar.viewContainersWorkspaceState';

	override readonly minimumWidth = 300;
	override readonly maximumWidth = Number.POSITIVE_INFINITY;
	override readonly minimumHeight = 0;
	override readonly maximumHeight = Number.POSITIVE_INFINITY;

	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_LEFT = 0;
	static readonly MARGIN_RIGHT = 0;
	static readonly MARGIN_BOTTOM = 0;
	static readonly BORDER_WIDTH = 1;

	get preferredHeight(): number | undefined {
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	readonly priority = LayoutPriority.High;

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService
	) {
		super(
			Parts.CHATBAR_PART,
			{
				hasTitle: false,
				trailingSeparator: true,
				borderWidth: () => 0,
			},
			OmniChatBarPart.activeViewSettingsKey,
			ActiveChatBarContext.bindTo(contextKeyService),
			ChatBarFocusContext.bindTo(contextKeyService),
			'chatbar',
			'chatbar',
			undefined,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.ChatBar,
			Extensions.ChatBar,
			Menus.ChatBarTitle,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
		);
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		container.style.setProperty(
			'--part-background',
			this.getColor(sessionsChatBarBackground) || ''
		);
		container.style.setProperty(
			'--part-border-color',
			this.getColor(PANEL_BORDER)
				|| this.getColor(contrastBorder)
				|| 'transparent'
		);
		container.style.backgroundColor =
			this.getColor(sessionsChatBarBackground) || '';
		container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';
	}

	override layout(
		width: number,
		height: number,
		top: number,
		left: number
	): void {
		if (!this.layoutService.isVisible(Parts.CHATBAR_PART)) {
			return;
		}

		const borderTotal = OmniChatBarPart.BORDER_WIDTH * 2;
		const marginLeft = this.layoutService.isVisible(Parts.SIDEBAR_PART)
			? 0
			: OmniChatBarPart.MARGIN_LEFT;
		super.layout(
			width - marginLeft - OmniChatBarPart.MARGIN_RIGHT - borderTotal,
			height - OmniChatBarPart.MARGIN_TOP
				- OmniChatBarPart.MARGIN_BOTTOM
				- borderTotal,
			top,
			left
		);

		Part.prototype.layout.call(this, width, height, top, left);
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'chatbar',
			pinnedViewContainersKey: OmniChatBarPart.pinnedViewsKey,
			placeholderViewContainersKey:
				OmniChatBarPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey:
				OmniChatBarPart.viewContainersWorkspaceStateKey,
			icon: false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: () => {},
			compositeSize: 0,
			iconSize: 16,
			overflowActionSize: 30,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(sessionsChatBarBackground),
				inactiveBackgroundColor: theme.getColor(sessionsChatBarBackground),
				activeBorderBottomColor: theme.getColor(PANEL_ACTIVE_TITLE_BORDER),
				activeForegroundColor: theme.getColor(
					PANEL_ACTIVE_TITLE_FOREGROUND
				),
				inactiveForegroundColor: theme.getColor(
					PANEL_INACTIVE_TITLE_FOREGROUND
				),
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				dragAndDropBorder: theme.getColor(PANEL_DRAG_AND_DROP_BORDER),
			}),
			compact: true,
		};
	}

	protected shouldShowCompositeBar(): boolean {
		return false;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	override toJSON(): object {
		return { type: Parts.CHATBAR_PART };
	}
}
