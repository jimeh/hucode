/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/titlebar/media/titlebarpart.css';
import './media/titlebarpart.css';
import { MultiWindowParts, Part } from '../../../workbench/browser/part.js';
import { ITitleService } from
	'../../../workbench/services/title/browser/titleService.js';
import {
	getZoomFactor,
	isFullscreen,
	isWCOEnabled,
	getWCOTitlebarAreaRect,
	onDidChangeFullscreen,
} from '../../../base/browser/browser.js';
import {
	hasCustomTitlebar,
	hasNativeTitlebar,
	DEFAULT_CUSTOM_TITLEBAR_HEIGHT,
	TitlebarStyle,
	getTitleBarStyle,
	getWindowControlsStyle,
	WindowControlsStyle,
} from '../../../platform/window/common/window.js';
import { IContextMenuService } from
	'../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from
	'../../../platform/configuration/common/configuration.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IColorTheme, IThemeService } from
	'../../../platform/theme/common/themeService.js';
import {
	TITLE_BAR_ACTIVE_BACKGROUND,
	TITLE_BAR_INACTIVE_BACKGROUND,
	WORKBENCH_BACKGROUND,
} from '../../../workbench/common/theme.js';
import {
	hucodeOmniTitleBackground,
	hucodeOmniTitleForeground,
} from '../../common/theme.js';
import {
	isMacintosh,
	isNative,
	isWeb,
	platformLocale,
} from '../../../base/common/platform.js';
import { Color } from '../../../base/common/color.js';
import {
	$,
	EventHelper,
	EventType,
	addDisposableListener,
	append,
	getWindow,
	getWindowId,
	isHTMLElement,
	prepend,
} from '../../../base/browser/dom.js';
import { IInstantiationService } from
	'../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IStorageService } from
	'../../../platform/storage/common/storage.js';
import {
	IWorkbenchLayoutService,
	Parts,
} from '../../../workbench/services/layout/browser/layoutService.js';
import { IContextKeyService } from
	'../../../platform/contextkey/common/contextkey.js';
import { IHostService } from
	'../../../workbench/services/host/browser/host.js';
import { IEditorGroupsContainer } from
	'../../../workbench/services/editor/common/editorGroupsService.js';
import { CodeWindow, mainWindow } from '../../../base/browser/window.js';
import { safeIntl } from '../../../base/common/date.js';
import {
	IAuxiliaryTitlebarPart,
	ITitleProperties,
	ITitleVariable,
	ITitlebarPart,
} from '../../../workbench/browser/parts/titlebar/titlebarPart.js';
import { WindowTitle } from
	'../../../workbench/browser/parts/titlebar/windowTitle.js';
import { Menus } from '../menus.js';
import {
	HiddenItemStrategy,
	MenuWorkbenchToolBar,
} from '../../../platform/actions/browser/toolbar.js';

/**
 * Omni-specific titlebar part.
 *
 * The shell only owns the left-most strip next to the traffic lights. The
 * hosted workbench visually owns the rest of the top edge.
 */
export class TitlebarPart extends Part implements ITitlebarPart {

	readonly minimumWidth = 0;
	readonly maximumWidth = Number.POSITIVE_INFINITY;

	get minimumHeight(): number {
		const wcoEnabled = isWeb && isWCOEnabled();
		let value = DEFAULT_CUSTOM_TITLEBAR_HEIGHT;
		if (wcoEnabled) {
			value = Math.max(
				value,
				getWCOTitlebarAreaRect(getWindow(this.element))?.height ?? 0
			);
		}

		return value / (this.preventZoom ? getZoomFactor(
			getWindow(this.element)
		) : 1);
	}

	get maximumHeight(): number {
		return this.minimumHeight;
	}

	private readonly _onMenubarVisibilityChange = this._register(
		new Emitter<boolean>()
	);
	readonly onMenubarVisibilityChange = this._onMenubarVisibilityChange.event;

	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	private rootContainer!: HTMLElement;
	private windowControlsContainer: HTMLElement | undefined;
	private leftContent!: HTMLElement;
	private leftToolbarContainer!: HTMLElement;
	private rightContent!: HTMLElement;

	get leftContainer(): HTMLElement {
		return this.leftContent;
	}

	get rightContainer(): HTMLElement {
		return this.rightContent;
	}

	get rightWindowControlsContainer(): HTMLElement | undefined {
		return this.windowControlsContainer;
	}

	private readonly titleBarStyle: TitlebarStyle;
	private isInactive = false;

	constructor(
		id: string,
		targetWindow: CodeWindow,
		@IContextMenuService
		_contextMenuService: IContextMenuService,
		@IConfigurationService
		protected readonly configurationService: IConfigurationService,
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService
		layoutService: IWorkbenchLayoutService,
		@IContextKeyService
		_contextKeyService: IContextKeyService,
		@IHostService
		private readonly hostService: IHostService,
	) {
		super(id, { hasTitle: false }, themeService, storageService, layoutService);

		this.titleBarStyle = getTitleBarStyle(this.configurationService);
		this.registerListeners(getWindowId(targetWindow));
	}

	private registerListeners(targetWindowId: number): void {
		this._register(this.hostService.onDidChangeFocus(focused =>
			focused ? this.onFocus() : this.onBlur()
		));
		this._register(this.hostService.onDidChangeActiveWindow(windowId =>
			windowId === targetWindowId ? this.onFocus() : this.onBlur()
		));
	}

	private onBlur(): void {
		this.isInactive = true;
		this.updateStyles();
	}

	private onFocus(): void {
		this.isInactive = false;
		this.updateStyles();
	}

	updateProperties(_properties: ITitleProperties): void { }

	registerVariables(_variables: ITitleVariable[]): void { }

	updateOptions(_options: { compact: boolean }): void { }

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.rootContainer = append(
			parent,
			$('.titlebar-container.hucode-omni-titlebar-container')
		);

		prepend(this.rootContainer, $('div.titlebar-drag-region'));

		this.leftContent = append(this.rootContainer, $('.titlebar-left'));
		append(this.rootContainer, $('.titlebar-center'));
		this.rightContent = append(this.rootContainer, $('.titlebar-right'));

		this.createWindowControlsSpacer();
		this.createLeftToolbar();

		this._register(addDisposableListener(
			this.rootContainer,
			EventType.CONTEXT_MENU,
			event => {
				EventHelper.stop(event);
			}
		));

		this.updateStyles();

		return this.element;
	}

	private createLeftToolbar(): void {
		this.leftToolbarContainer = append(
			this.leftContent,
			$('div.left-toolbar-container')
		);
		this._register(this.instantiationService.createInstance(
			MenuWorkbenchToolBar,
			this.leftToolbarContainer,
			Menus.TitleBarLeftLayout,
			{
				contextMenu: Menus.TitleBarContext,
				telemetrySource: 'titlePart.left',
				hiddenItemStrategy: HiddenItemStrategy.NoHide,
				toolbarOptions: { primaryGroup: () => true },
			}
		));
	}

	private createWindowControlsSpacer(): void {
		if (hasNativeTitlebar(this.configurationService, this.titleBarStyle)) {
			return;
		}

		let primaryWindowControlsLocation = isMacintosh ? 'left' : 'right';
		if (isMacintosh && isNative) {
			const localeInfo = safeIntl.Locale(platformLocale).value;
			const textInfo = (localeInfo as {
				textInfo?: { direction?: string };
			}).textInfo;
			if (textInfo?.direction === 'rtl') {
				primaryWindowControlsLocation = 'right';
			}
		}

		if (isMacintosh && isNative && primaryWindowControlsLocation === 'left') {
			const spacer = append(this.leftContent, $('div.window-controls-container'));
			spacer.style.width = '70px';
			spacer.style.flexShrink = '0';

			const updateSpacerVisibility = () => {
				spacer.style.display = isFullscreen(mainWindow) ? 'none' : '';
			};
			updateSpacerVisibility();
			this._register(onDidChangeFullscreen(windowId => {
				if (windowId === getWindowId(mainWindow)) {
					updateSpacerVisibility();
				}
			}));
			return;
		}

		if (getWindowControlsStyle(this.configurationService)
			=== WindowControlsStyle.HIDDEN) {
			return;
		}

		this.windowControlsContainer = append(
			primaryWindowControlsLocation === 'left'
				? this.leftContent
				: this.rightContent,
			$('div.window-controls-container')
		);
		if (isWeb) {
			append(
				primaryWindowControlsLocation === 'left'
					? this.rightContent
					: this.leftContent,
				$('div.window-controls-container')
			);
		}

		if (isWCOEnabled()) {
			this.windowControlsContainer.classList.add('wco-enabled');
		}
	}

	override updateStyles(): void {
		super.updateStyles();

		if (!this.element) {
			return;
		}

		this.element.classList.toggle('inactive', this.isInactive);

		const modernUI = this.layoutService.isFloatingPanelsEnabled();
		const makeOpaque = (color: Color, theme: IColorTheme) => color.isOpaque()
			? color
			: color.makeOpaque(WORKBENCH_BACKGROUND(theme));
		const titleBackground = (this.getColor(
			modernUI
				? this.isInactive
					? TITLE_BAR_INACTIVE_BACKGROUND
					: TITLE_BAR_ACTIVE_BACKGROUND
				: hucodeOmniTitleBackground,
			makeOpaque
		) || (modernUI && this.isInactive
			? this.getColor(TITLE_BAR_ACTIVE_BACKGROUND, makeOpaque)
			: undefined)) || '';
		this.element.style.backgroundColor = titleBackground;

		const workbenchContainer = this.layoutService.getContainer(
			getWindow(this.element)
		);
		if (modernUI && titleBackground) {
			workbenchContainer.style.setProperty(
				'--modern-ui-shell-background',
				titleBackground
			);
		} else {
			workbenchContainer.style.removeProperty(
				'--modern-ui-shell-background'
			);
		}

		if (titleBackground && Color.fromHex(titleBackground).isLighter()) {
			this.element.classList.add('light');
		} else {
			this.element.classList.remove('light');
		}

		const titleForeground = this.getColor(hucodeOmniTitleForeground);
		this.element.style.color = titleForeground || '';
	}

	get hasZoomableElements(): boolean {
		return false;
	}

	get preventZoom(): boolean {
		return getZoomFactor(getWindow(this.element)) < 1
			|| !this.hasZoomableElements;
	}

	override layout(width: number, height: number): void {
		this.updateLayout();
		super.layoutContents(width, height);
	}

	private updateLayout(): void {
		if (!hasCustomTitlebar(this.configurationService, this.titleBarStyle)) {
			return;
		}

		const zoomFactor = getZoomFactor(getWindow(this.element));
		this.element.style.setProperty('--zoom-factor', zoomFactor.toString());
		this.rootContainer.classList.toggle('counter-zoom', this.preventZoom);
	}

	focus(): void {
		const targetWindow = getWindow(this.leftToolbarContainer);
		const walker = targetWindow.document.createTreeWalker(
			this.leftToolbarContainer,
			targetWindow.NodeFilter.SHOW_ELEMENT
		);

		while (walker.nextNode()) {
			if (isHTMLElement(walker.currentNode)
				&& walker.currentNode.tabIndex >= 0) {
				walker.currentNode.focus();
				return;
			}
		}
	}

	toJSON(): object {
		return { type: Parts.TITLEBAR_PART };
	}

	override dispose(): void {
		this._onWillDispose.fire();
		super.dispose();
	}
}

/**
 * Main Omni titlebar part.
 */
export class MainTitlebarPart extends TitlebarPart {

	constructor(
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
	) {
		super(
			Parts.TITLEBAR_PART,
			mainWindow,
			contextMenuService,
			configurationService,
			instantiationService,
			themeService,
			storageService,
			layoutService,
			contextKeyService,
			hostService
		);
	}
}

/**
 * Auxiliary Omni titlebar part.
 */
export class AuxiliaryTitlebarPart extends TitlebarPart
	implements IAuxiliaryTitlebarPart {

	private static COUNTER = 1;

	get height(): number {
		return this.minimumHeight;
	}

	constructor(
		readonly container: HTMLElement,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
	) {
		const id = AuxiliaryTitlebarPart.COUNTER++;
		super(
			`workbench.parts.auxiliaryTitle.${id}`,
			getWindow(container),
			contextMenuService,
			configurationService,
			instantiationService,
			themeService,
			storageService,
			layoutService,
			contextKeyService,
			hostService
		);
	}
}

/**
 * Omni title service.
 */
export class TitleService extends MultiWindowParts<TitlebarPart>
	implements ITitleService {

	declare _serviceBrand: undefined;

	readonly windowTitle: WindowTitle;
	readonly mainPart: TitlebarPart;

	constructor(
		@IInstantiationService
		protected readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService
	) {
		super('workbench.hucodeOmniTitleService', themeService, storageService);

		this.windowTitle = this._register(
			this.instantiationService.createInstance(WindowTitle, mainWindow)
		);
		this.mainPart = this._register(this.createMainTitlebarPart());
		this.onMenubarVisibilityChange = this.mainPart.onMenubarVisibilityChange;
		this._register(this.registerPart(this.mainPart));
	}

	protected createMainTitlebarPart(): TitlebarPart {
		return this.instantiationService.createInstance(MainTitlebarPart);
	}

	createAuxiliaryTitlebarPart(
		container: HTMLElement,
		_editorGroupsContainer: IEditorGroupsContainer,
		instantiationService: IInstantiationService
	): IAuxiliaryTitlebarPart {
		const titlebarPartContainer = $('.part.titlebar', { role: 'none' });
		titlebarPartContainer.style.position = 'relative';
		container.insertBefore(titlebarPartContainer, container.firstChild);

		const disposables = new DisposableStore();
		const titlebarPart = instantiationService.createInstance(
			AuxiliaryTitlebarPart,
			container
		);
		disposables.add(this.registerPart(titlebarPart));

		disposables.add(Event.runAndSubscribe(titlebarPart.onDidChange, () => {
			titlebarPartContainer.style.height = `${titlebarPart.height}px`;
		}));
		titlebarPart.create(titlebarPartContainer);

		Event.once(titlebarPart.onWillDispose)(() => disposables.dispose());

		return titlebarPart;
	}

	readonly onMenubarVisibilityChange: Event<boolean>;

	updateProperties(properties: ITitleProperties): void {
		this.windowTitle.updateProperties(properties);
		for (const part of this.parts) {
			part.updateProperties(properties);
		}
	}

	registerVariables(variables: ITitleVariable[]): void {
		this.windowTitle.registerVariables(variables);
		for (const part of this.parts) {
			part.registerVariables(variables);
		}
	}
}
