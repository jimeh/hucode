/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigurationTarget, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { isDark } from '../../../platform/theme/common/theme.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService, ThemeSettingDefaults, ThemeSettings } from '../../../workbench/services/themes/common/workbenchThemeService.js';

/** System follows the OS scheme; Light and Dark pin the matching preferred theme. */
export type OnboardingAppearanceMode = 'system' | 'light' | 'dark';

export type OnboardingColorScheme = 'light' | 'dark';

/** One installed color theme, keyed by the value `workbench.colorTheme` takes. */
export interface OnboardingThemeOption {
	readonly id: string;
	readonly label: string;
}

/** What the appearance stage lets the user change. */
export interface OnboardingAppearanceDraft {
	readonly mode: OnboardingAppearanceMode;
	readonly preferredLight: string;
	readonly preferredDark: string;
}

/**
 * The appearance as last read or written, and the themes on offer.
 *
 * The draft fields are the values the controls are prefilled with, and the baseline `apply`
 * diffs a draft against; every successful write yields the next baseline. `colorTheme` is the
 * theme in use, kept so a Light or Dark choice can tell whether `workbench.colorTheme` already
 * matches; it is empty while System mode derives the theme from the operating system, so the
 * next Light or Dark choice always pins.
 */
export interface OnboardingAppearanceSnapshot extends OnboardingAppearanceDraft {
	readonly colorTheme: string;
	readonly lightThemes: readonly OnboardingThemeOption[];
	readonly darkThemes: readonly OnboardingThemeOption[];
}

/** Reads and writes the appearance values on behalf of the onboarding session. */
export interface IOnboardingAppearanceAuthority {
	snapshot(): Promise<OnboardingAppearanceSnapshot>;
	/**
	 * Writes the settings whose draft value differs from the snapshot, nothing when none does, and
	 * returns the snapshot those writes leave behind.
	 */
	apply(snapshot: OnboardingAppearanceSnapshot, draft: OnboardingAppearanceDraft): Promise<OnboardingAppearanceSnapshot>;
}

/** True when the draft names exactly the snapshot's values, so there is nothing to write. */
export function isOnboardingAppearanceApplied(snapshot: OnboardingAppearanceSnapshot, draft: OnboardingAppearanceDraft): boolean {
	return draft.mode === snapshot.mode && draft.preferredLight === snapshot.preferredLight && draft.preferredDark === snapshot.preferredDark;
}

/** The theme list a draft field selects from. */
export function onboardingThemesFor(snapshot: OnboardingAppearanceSnapshot, scheme: OnboardingColorScheme): readonly OnboardingThemeOption[] {
	return scheme === 'light' ? snapshot.lightThemes : snapshot.darkThemes;
}

function schemeOf(theme: IWorkbenchColorTheme): OnboardingColorScheme {
	return isDark(theme.type) ? 'dark' : 'light';
}

/**
 * The preferred theme a list is prefilled with.
 *
 * The configured preference wins when it names an installed theme. Otherwise the theme in use is
 * the best guess when it belongs to the list, then the product default, then whatever is first;
 * an empty list yields an empty id, which `apply` never pins as the theme.
 */
function preferredThemeId(configured: unknown, current: string, productDefault: string, themes: readonly OnboardingThemeOption[]): string {
	const offered = (id: unknown): id is string => typeof id === 'string' && themes.some(theme => theme.id === id);
	if (offered(configured)) {
		return configured;
	}
	if (offered(current)) {
		return current;
	}
	if (offered(productDefault)) {
		return productDefault;
	}
	return themes[0]?.id ?? '';
}

function compareThemes(left: OnboardingThemeOption, right: OnboardingThemeOption): number {
	return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}

/**
 * Appearance authority over the workbench theme and configuration services.
 *
 * Writes go to `ConfigurationTarget.USER`, which in the Omni shell window is the Default profile's
 * user settings: the onboarding host plan settles that the appearance step writes there, and the
 * stage copy says so. High-contrast themes are offered in the list of their base scheme, so a user
 * already on one sees it preselected rather than an unexplained substitute.
 */
export class OnboardingAppearanceAuthority implements IOnboardingAppearanceAuthority {
	constructor(
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	async snapshot(): Promise<OnboardingAppearanceSnapshot> {
		const current = this.themeService.getColorTheme();
		const themes = await this.themeService.getColorThemes();
		const lightThemes: OnboardingThemeOption[] = [];
		const darkThemes: OnboardingThemeOption[] = [];
		for (const theme of themes) {
			(schemeOf(theme) === 'dark' ? darkThemes : lightThemes).push({ id: theme.settingsId, label: theme.label });
		}
		lightThemes.sort(compareThemes);
		darkThemes.sort(compareThemes);
		const autoDetect = this.configurationService.getValue(ThemeSettings.DETECT_COLOR_SCHEME) === true;
		return {
			mode: autoDetect ? 'system' : schemeOf(current),
			colorTheme: current.settingsId,
			preferredLight: preferredThemeId(this.configurationService.getValue(ThemeSettings.PREFERRED_LIGHT_THEME), current.settingsId, ThemeSettingDefaults.COLOR_THEME_LIGHT, lightThemes),
			preferredDark: preferredThemeId(this.configurationService.getValue(ThemeSettings.PREFERRED_DARK_THEME), current.settingsId, ThemeSettingDefaults.COLOR_THEME_DARK, darkThemes),
			lightThemes,
			darkThemes,
		};
	}

	async apply(snapshot: OnboardingAppearanceSnapshot, draft: OnboardingAppearanceDraft): Promise<OnboardingAppearanceSnapshot> {
		const writes: [key: string, value: unknown][] = [];
		let colorTheme = snapshot.colorTheme;
		if (draft.mode !== snapshot.mode) {
			writes.push([ThemeSettings.DETECT_COLOR_SCHEME, draft.mode === 'system']);
		}
		if (draft.preferredLight !== snapshot.preferredLight) {
			writes.push([ThemeSettings.PREFERRED_LIGHT_THEME, draft.preferredLight]);
		}
		if (draft.preferredDark !== snapshot.preferredDark) {
			writes.push([ThemeSettings.PREFERRED_DARK_THEME, draft.preferredDark]);
		}
		// Under System the theme service derives the theme from the preferences; pinning it here
		// would only be overwritten, and which theme it derives is not known here. Light and Dark
		// mean the matching preferred theme is the theme, but only a changed mode or preference may
		// move it: a user who touched nothing keeps a current theme that happens to differ from the
		// preference.
		if (draft.mode === 'system') {
			colorTheme = '';
		} else {
			const theme = draft.mode === 'light' ? draft.preferredLight : draft.preferredDark;
			const decided = draft.mode !== snapshot.mode
				|| (draft.mode === 'light' ? draft.preferredLight !== snapshot.preferredLight : draft.preferredDark !== snapshot.preferredDark);
			// An empty id means the scheme has no installed themes; there is nothing to pin.
			if (decided && theme !== '') {
				colorTheme = theme;
				if (theme !== snapshot.colorTheme) {
					writes.push([ThemeSettings.COLOR_THEME, theme]);
				}
			}
		}
		for (const [key, value] of writes) {
			await this.configurationService.updateValue(key, value, ConfigurationTarget.USER);
		}
		return { ...snapshot, ...draft, colorTheme };
	}
}
