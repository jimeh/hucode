/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindowId, prepend } from '../../../base/browser/dom.js';
import {
	isFullscreen,
	onDidChangeFullscreen,
} from '../../../base/browser/browser.js';
import { mainWindow } from '../../../base/browser/window.js';
import {
	HiddenItemStrategy,
	MenuWorkbenchToolBar,
} from '../../../platform/actions/browser/toolbar.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { Part } from '../../../workbench/browser/part.js';
import { SIDE_BAR_FOREGROUND } from '../../../workbench/common/theme.js';
import {
	FLOATING_PANEL_INNER_MARGIN,
	FLOATING_PANEL_MARGIN,
	IWorkbenchLayoutService,
	Parts,
} from '../../../workbench/services/layout/browser/layoutService.js';
import {
	getTitleBarStyle,
	hasNativeTitlebar,
} from '../../../platform/window/common/window.js';
import { isMacintosh, isNative } from '../../../base/common/platform.js';
import {
	sessionsSidebarBackground,
	sessionsSidebarHeaderBackground,
	sessionsSidebarHeaderForeground,
} from '../../common/theme.js';
import { Menus } from '../menus.js';
import { ProjectSwitcherWidget } from
	'../projectSwitcher/projectSwitcher.contribution.js';
import { IConfigurationService } from
	'../../../platform/configuration/common/configuration.js';

// Keep in sync with the floating Projects card geometry in media/omniHost.css.
const MODERN_UI_CARD_TOP_ALIGNMENT_OFFSET = 1;

/**
 * Shell-owned Projects surface for Omni windows.
 *
 * This is deliberately a plain workbench part, not a view container. The Omni
 * sidebar is therefore always Projects and cannot be replaced by Explorer, SCM,
 * or other regular workbench viewlets.
 */
export class ProjectsPart extends Part {

	readonly minimumWidth = 170;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 0;
	readonly maximumHeight = Number.POSITIVE_INFINITY;
	get snap(): boolean { return false; }

	private titleAreaElement: HTMLElement | undefined;
	private widget: ProjectSwitcherWidget | undefined;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
	) {
		super(
			Parts.SIDEBAR_PART,
			{ hasTitle: true, borderWidth: () => 0 },
			themeService,
			storageService,
			layoutService
		);
	}

	protected override createTitleArea(parent: HTMLElement): HTMLElement {
		const titleArea = append(parent, $('.hucode-omni-projects-title'));
		this.titleAreaElement = titleArea;

		prepend(titleArea, $('.titlebar-drag-region'));
		this.createTrafficLightSpacer(titleArea);

		const navigationActions = append(
			titleArea,
			$('div.hucode-omni-projects-title-navigation-actions')
		);
		this._register(this.instantiationService.createInstance(
			MenuWorkbenchToolBar,
			navigationActions,
			Menus.SidebarTitleNavigation,
			{
				hiddenItemStrategy: HiddenItemStrategy.NoHide,
				toolbarOptions: { primaryGroup: () => true },
				telemetrySource: 'omniProjectsTitleNavigation',
			}
		));

		const actions = append(
			titleArea,
			$('div.hucode-omni-projects-title-actions')
		);
		this._register(this.instantiationService.createInstance(
			MenuWorkbenchToolBar,
			actions,
			Menus.SidebarTitle,
			{
				hiddenItemStrategy: HiddenItemStrategy.NoHide,
				toolbarOptions: { primaryGroup: () => true },
				telemetrySource: 'omniProjectsTitle',
			}
		));

		return titleArea;
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;

		const content = append(parent, $('.content.hucode-omni-projects-view'));
		this.widget = this._register(
			this.instantiationService.createInstance(ProjectSwitcherWidget)
		);
		this.widget.render(content);
		return content;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		const floating = this.layoutService.isFloatingPanelsEnabled();
		super.layout(width, height, top, left);
		const layout = this.layoutContents(width, height);
		let contentWidth = layout.contentSize.width;
		let contentHeight = layout.contentSize.height;
		if (floating) {
			const borderTotal = 2;
			const horizontalCardInsets = (
				FLOATING_PANEL_MARGIN * 2 +
				borderTotal
			);
			const verticalCardInsets = (
				FLOATING_PANEL_MARGIN * 2 +
				FLOATING_PANEL_INNER_MARGIN +
				MODERN_UI_CARD_TOP_ALIGNMENT_OFFSET +
				borderTotal
			);
			contentWidth = Math.max(0, contentWidth - horizontalCardInsets);
			contentHeight = Math.max(0, contentHeight - verticalCardInsets);
		}

		this.widget?.layout(contentWidth, contentHeight);
	}

	/** Recomputes Projects geometry after Modern UI changes at the same grid size. */
	relayoutForModernUI(): void {
		const dimension = this.getRelayoutDimension();
		if (dimension && this.contentPosition) {
			this.layout(
				dimension.width,
				dimension.height,
				this.contentPosition.top,
				this.contentPosition.left
			);
		}
	}

	focus(): void {
		this.widget?.focus();
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = this.getContainer();
		if (container) {
			container.style.backgroundColor =
				this.getColor(sessionsSidebarBackground) || '';
			container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';
		}

		if (this.titleAreaElement) {
			this.titleAreaElement.style.backgroundColor =
				this.getColor(sessionsSidebarHeaderBackground) || '';
			this.titleAreaElement.style.color =
				this.getColor(sessionsSidebarHeaderForeground) || '';
		}
	}

	override toJSON(): object {
		return { type: Parts.SIDEBAR_PART };
	}

	private createTrafficLightSpacer(titleArea: HTMLElement): void {
		if (
			!isMacintosh ||
			!isNative ||
			hasNativeTitlebar(
				this.configurationService,
				getTitleBarStyle(this.configurationService)
			)
		) {
			return;
		}

		const spacer = $('div.window-controls-container');
		spacer.style.width = '70px';
		spacer.style.height = '100%';
		spacer.style.flexShrink = '0';
		spacer.style.order = '-1';
		prepend(titleArea, spacer);

		const updateSpacerVisibility = () => {
			spacer.style.display = isFullscreen(mainWindow) ? 'none' : '';
		};
		updateSpacerVisibility();
		this._register(onDidChangeFullscreen(windowId => {
			if (windowId === getWindowId(mainWindow)) {
				updateSpacerVisibility();
			}
		}));
	}
}
