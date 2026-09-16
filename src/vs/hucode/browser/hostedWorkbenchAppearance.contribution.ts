/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { IConfigurationService } from
	'../../platform/configuration/common/configuration.js';
import { ColorScheme } from '../../platform/theme/common/theme.js';
import {
	HUCODE_HOSTED_APPEARANCE_COLOR_IDS,
	HucodeHostedAppearanceColorScheme,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedAppearanceSnapshot,
	IHucodeHostedShellService,
} from '../../platform/window/common/hucodeHostedShellService.js';
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from '../../workbench/common/contributions.js';
import { WORKBENCH_BACKGROUND } from '../../workbench/common/theme.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';
import { LayoutSettings } from
	'../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchThemeService, IWorkbenchColorTheme } from
	'../../workbench/services/themes/common/workbenchThemeService.js';
import { IUserDataProfileService } from
	'../../workbench/services/userDataProfile/common/userDataProfile.js';
import { observeHucodeHostedShellState } from './hostedShellStateObserver.js';
import '../common/theme.js';

/** Creates a transport-safe snapshot from the fully resolved hosted theme. */
export function createHucodeHostedAppearanceSnapshot(
	theme: IWorkbenchColorTheme,
	modernUI: boolean,
	modernUIUppercaseViewHeaders: boolean
): IHucodeHostedAppearanceSnapshot {
	const colors: Record<string, string> = {};
	for (const id of HUCODE_HOSTED_APPEARANCE_COLOR_IDS) {
		const color = theme.getColor(id, true);
		if (color) {
			colors[id] = color.toString();
		}
	}
	return {
		colorScheme: toHostedAppearanceColorScheme(theme.type),
		workbenchBackground: WORKBENCH_BACKGROUND(theme).toString(),
		colors,
		modernUI,
		modernUIUppercaseViewHeaders,
	};
}

function toHostedAppearanceColorScheme(
	scheme: ColorScheme
): HucodeHostedAppearanceColorScheme {
	switch (scheme) {
		case ColorScheme.LIGHT: return 'light';
		case ColorScheme.HIGH_CONTRAST_LIGHT: return 'hc-light';
		case ColorScheme.HIGH_CONTRAST_DARK: return 'hc-dark';
		default: return 'dark';
	}
}

/** Publishes only resolved appearance through the bound hosted capability. */
export class HostedWorkbenchAppearanceContribution extends Disposable
	implements IWorkbenchContribution {

	static readonly ID = 'hucode.hostedWorkbenchAppearance';
	private lastAttemptedSnapshot: string | undefined;
	private isDisposed = false;

	constructor(
		@IWorkbenchEnvironmentService
		environmentService: IWorkbenchEnvironmentService,
		@IHucodeHostedShellService
		private readonly shellService: IHucodeHostedShellService,
		@IWorkbenchThemeService
		private readonly themeService: IWorkbenchThemeService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@IUserDataProfileService
		userDataProfileService: IUserDataProfileService,
	) {
		super();
		if (!environmentService.isHostedOmniWorkspace ||
			!environmentService.hostedInstanceId) {
			return;
		}

		this._register(themeService.onDidColorThemeChange(theme => {
			void this.publish(theme);
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(LayoutSettings.MODERN_UI) ||
				event.affectsConfiguration(
					LayoutSettings.MODERN_UI_UPPERCASE_VIEW_HEADERS
				)) {
				void this.publish();
			}
		}));
		this._register(observeHucodeHostedShellState(shellService, state => {
			if (state.available && state.active) {
				void this.publish();
			}
		}));
		this._register(userDataProfileService.onDidChangeCurrentProfile(event => {
			event.join(new Promise<void>(resolve => {
				setTimeout(() => {
					if (this.isDisposed) {
						resolve();
						return;
					}
					void this.publish().finally(resolve);
				}, 0);
			}));
		}));
		void this.publish();
	}

	override dispose(): void {
		this.isDisposed = true;
		super.dispose();
	}

	private async publish(
		theme = this.themeService.getColorTheme()
	): Promise<void> {
		if (this.isDisposed) {
			return;
		}
		const snapshot = createHucodeHostedAppearanceSnapshot(
			theme,
			this.configurationService.getValue<boolean>(
				LayoutSettings.MODERN_UI
			) === true,
			this.configurationService.getValue<boolean>(
				LayoutSettings.MODERN_UI_UPPERCASE_VIEW_HEADERS
			) === true
		);
		const serialized = JSON.stringify(snapshot);
		if (serialized === this.lastAttemptedSnapshot) {
			return;
		}
		this.lastAttemptedSnapshot = serialized;
		let outcome: HucodeHostedShellOperationOutcome;
		try {
			outcome = await (this.shellService.publishAppearance?.(snapshot) ??
				Promise.resolve(HucodeHostedShellOperationOutcome.Unsupported));
		} catch {
			outcome = HucodeHostedShellOperationOutcome.Unavailable;
		}
		if (outcome !== HucodeHostedShellOperationOutcome.Accepted &&
			this.lastAttemptedSnapshot === serialized) {
			this.lastAttemptedSnapshot = undefined;
		}
	}
}

registerWorkbenchContribution2(
	HostedWorkbenchAppearanceContribution.ID,
	HostedWorkbenchAppearanceContribution,
	WorkbenchPhase.AfterRestored
);
