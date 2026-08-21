/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IConfigurationService } from
	'../../platform/configuration/common/configuration.js';
import { asCssVariableName } from
	'../../platform/theme/common/colorRegistry.js';
import { ColorScheme, ThemeTypeSelector } from
	'../../platform/theme/common/theme.js';
import { IHucodeShellControllerService } from
	'../../platform/window/common/hucodeShellControllerService.js';
import {
	HUCODE_HOSTED_APPEARANCE_COLOR_IDS,
	HucodeHostedAppearanceColorScheme,
	IHucodeHostedAppearanceSnapshot,
} from '../../platform/window/common/hucodeHostedShellService.js';
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from '../../workbench/common/contributions.js';
import { DEFAULT_SCROLLBAR_SIZE, setGlobalDefaultScrollbarSize } from
	'../../base/browser/ui/scrollbar/scrollableElement.js';
import { DEFAULT_NOTIFICATION_ROW_HEIGHT, setNotificationRowHeight } from
	'../../workbench/browser/parts/notifications/notificationsViewer.js';
import { DEFAULT_PANE_HEADER_SIZE, setGlobalPaneHeaderSize } from
	'../../base/browser/ui/splitview/paneview.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';
import { IWorkbenchLayoutService, LayoutSettings, Parts } from
	'../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchThemeService } from
	'../../workbench/services/themes/common/workbenchThemeService.js';
import { IHucodeHostedWorkspaceState } from '../common/omniWindow.js';

const BASE_THEME_CLASSES = [
	ThemeTypeSelector.VS,
	ThemeTypeSelector.VS_DARK,
	ThemeTypeSelector.HC_BLACK,
	ThemeTypeSelector.HC_LIGHT,
];
const MODERN_UI_CLASSES = [
	'modern-ui',
	'modern-ui-tabs',
	'floating-panels',
	'style-override',
];
const MODERN_UI_UPPERCASE_CLASS = 'modern-ui-uppercase-view-headers';

let projectedAppearance: IHucodeHostedAppearanceSnapshot | undefined;

/** Current ephemeral snapshot for Hucode-owned parts that recompute styles. */
export function getHucodeOmniProjectedAppearance():
	IHucodeHostedAppearanceSnapshot | undefined {
	return projectedAppearance;
}

/** Ephemeral layout override consumed only by the Hucode Omni workbench. */
export function getHucodeOmniProjectedModernUI(): boolean | undefined {
	return projectedAppearance?.modernUI;
}

/** Chooses the visible snapshot without reacting to inactive child updates. */
export class HucodeOmniAppearanceProjectionModel {
	private hadInstances = false;
	private projectedSnapshot: string | undefined;

	constructor(
		private readonly apply: (
			snapshot: IHucodeHostedAppearanceSnapshot | undefined
		) => void
	) { }

	update(state: IHucodeHostedWorkspaceState): void {
		if (state.instances.length === 0) {
			if (this.hadInstances) {
				this.hadInstances = false;
				this.projectedSnapshot = undefined;
				this.apply(undefined);
			}
			return;
		}
		this.hadInstances = true;
		const active = state.instances.find(instance =>
			instance.instanceId === state.activeInstanceId
		);
		if (!active?.appearance) {
			return;
		}
		const serialized = JSON.stringify(active.appearance);
		if (serialized === this.projectedSnapshot) {
			return;
		}
		this.projectedSnapshot = serialized;
		this.apply(active.appearance);
	}
}

/** Applies active hosted appearance ephemerally to shell-owned DOM only. */
export class OmniAppearanceProjectionContribution extends Disposable
	implements IWorkbenchContribution {

	static readonly ID = 'hucode.omniAppearanceProjection';
	private current: IHucodeHostedAppearanceSnapshot | undefined;
	private isDisposed = false;
	private readonly model: HucodeOmniAppearanceProjectionModel;

	constructor(
		@IWorkbenchEnvironmentService
		environmentService: IWorkbenchEnvironmentService,
		@IHucodeShellControllerService
		shellService: IHucodeShellControllerService,
		@IWorkbenchLayoutService
		private readonly layoutService: IWorkbenchLayoutService,
		@IWorkbenchThemeService
		private readonly themeService: IWorkbenchThemeService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
	) {
		super();
		this.model = new HucodeOmniAppearanceProjectionModel(snapshot =>
			this.applySnapshot(snapshot)
		);
		if (!environmentService.isOmniShellWindow) {
			return;
		}

		let didReceiveStateChange = false;
		this._register(shellService.onDidChangeState(state => {
			didReceiveStateChange = true;
			this.model.update(state);
		}));
		this._register(layoutService.onDidAddContainer(({ container }) => {
			if (this.current) {
				this.applyToContainer(container, this.current);
			}
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (this.current && (
				event.affectsConfiguration(LayoutSettings.MODERN_UI) ||
				event.affectsConfiguration(
					LayoutSettings.MODERN_UI_UPPERCASE_VIEW_HEADERS
				)
			)) {
				this.applySnapshot(this.current, true);
			}
		}));
		void shellService.getState().then(state => {
			if (!this.isDisposed && !didReceiveStateChange) {
				this.model.update(state);
			}
		});
	}

	private applySnapshot(
		snapshot: IHucodeHostedAppearanceSnapshot | undefined,
		force = false
	): void {
		const previousModernUI = this.current?.modernUI;
		this.current = snapshot;
		projectedAppearance = snapshot;
		if (snapshot) {
			for (const container of this.layoutService.containers) {
				this.applyToContainer(container, snapshot);
			}
			this.applyPartSurfaces(snapshot);
			this.applyModernUIMetrics(snapshot.modernUI);
		} else {
			for (const container of this.layoutService.containers) {
				this.clearContainer(container);
			}
			this.clearPartSurfaces();
			this.restoreShellModernUI();
		}
		this.updatePartStyles();
		if (force || previousModernUI !== snapshot?.modernUI) {
			this.layoutService.layout();
		}
	}

	override dispose(): void {
		this.isDisposed = true;
		projectedAppearance = undefined;
		super.dispose();
	}

	private applyToContainer(
		container: HTMLElement,
		snapshot: IHucodeHostedAppearanceSnapshot
	): void {
		container.classList.remove(...BASE_THEME_CLASSES);
		container.classList.add(toThemeClass(snapshot.colorScheme));
		for (const id of HUCODE_HOSTED_APPEARANCE_COLOR_IDS) {
			const value = snapshot.colors[id];
			if (value) {
				container.style.setProperty(asCssVariableName(id), value);
			} else {
				container.style.removeProperty(asCssVariableName(id));
			}
		}
		for (const className of MODERN_UI_CLASSES) {
			container.classList.toggle(className, snapshot.modernUI);
		}
		container.classList.toggle(
			MODERN_UI_UPPERCASE_CLASS,
			snapshot.modernUI && snapshot.modernUIUppercaseViewHeaders
		);
	}

	private clearContainer(container: HTMLElement): void {
		container.classList.remove(...BASE_THEME_CLASSES);
		container.classList.add(toThemeClass(
			this.themeService.getColorTheme().type
		));
		for (const id of HUCODE_HOSTED_APPEARANCE_COLOR_IDS) {
			container.style.removeProperty(asCssVariableName(id));
		}
		const modernUI = this.configurationService.getValue<boolean>(
			LayoutSettings.MODERN_UI
		) === true;
		for (const className of MODERN_UI_CLASSES) {
			container.classList.toggle(className, modernUI);
		}
		container.classList.toggle(
			MODERN_UI_UPPERCASE_CLASS,
			modernUI && this.configurationService.getValue<boolean>(
				LayoutSettings.MODERN_UI_UPPERCASE_VIEW_HEADERS
			) === true
		);
	}

	private applyPartSurfaces(snapshot: IHucodeHostedAppearanceSnapshot): void {
		this.setPartColors(
			Parts.TITLEBAR_PART,
			snapshot.colors['titleBar.activeBackground'],
			snapshot.colors['titleBar.activeForeground']
		);
		this.setPartColors(
			Parts.SIDEBAR_PART,
			snapshot.colors['sessionsSidebar.background'] ??
			snapshot.colors['sideBar.background'],
			snapshot.colors['sideBar.foreground']
		);
	}

	private clearPartSurfaces(): void {
		this.setPartColors(Parts.TITLEBAR_PART);
		this.setPartColors(Parts.SIDEBAR_PART);
	}

	private updatePartStyles(): void {
		const layoutService = this.layoutService as IWorkbenchLayoutService & {
			getPart?(part: Parts): { updateStyles(): void } | undefined;
		};
		layoutService.getPart?.(Parts.TITLEBAR_PART)?.updateStyles();
		layoutService.getPart?.(Parts.SIDEBAR_PART)?.updateStyles();
	}

	private setPartColors(
		part: Parts,
		background?: string,
		foreground?: string
	): void {
		const container = this.layoutService.getContainer(mainWindow, part);
		if (!container) {
			return;
		}
		container.style.backgroundColor = background ?? '';
		container.style.color = foreground ?? '';
	}

	private applyModernUIMetrics(enabled: boolean): void {
		setGlobalDefaultScrollbarSize(enabled ? 8 : DEFAULT_SCROLLBAR_SIZE);
		setNotificationRowHeight(enabled ? 34 : DEFAULT_NOTIFICATION_ROW_HEIGHT);
		setGlobalPaneHeaderSize(enabled ? 28 : DEFAULT_PANE_HEADER_SIZE);
	}

	private restoreShellModernUI(): void {
		this.applyModernUIMetrics(this.configurationService.getValue<boolean>(
			LayoutSettings.MODERN_UI
		) === true);
	}
}

function toThemeClass(
	scheme: HucodeHostedAppearanceColorScheme | ColorScheme
): ThemeTypeSelector {
	switch (scheme) {
		case 'light':
			return ThemeTypeSelector.VS;
		case 'hc-light':
		case ColorScheme.HIGH_CONTRAST_LIGHT:
			return ThemeTypeSelector.HC_LIGHT;
		case 'hc-dark':
		case ColorScheme.HIGH_CONTRAST_DARK:
			return ThemeTypeSelector.HC_BLACK;
		default:
			return ThemeTypeSelector.VS_DARK;
	}
}

registerWorkbenchContribution2(
	OmniAppearanceProjectionContribution.ID,
	OmniAppearanceProjectionContribution,
	WorkbenchPhase.AfterRestored
);
