/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ConfigurationTarget } from '../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../platform/configuration/test/common/testConfigurationService.js';
import { ColorScheme } from '../../../platform/theme/common/theme.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../workbench/services/themes/common/workbenchThemeService.js';
import { OnboardingAppearanceAuthority, OnboardingAppearanceDraft, OnboardingAppearanceSnapshot } from '../../browser/onboarding/onboardingAppearance.js';

suite('OnboardingAppearanceAuthority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Installed themes as the theme service reports them; `settingsId` is what the settings take. */
	const INSTALLED: readonly [settingsId: string, label: string, type: ColorScheme][] = [
		['Monokai', 'Monokai', ColorScheme.DARK],
		['Dark 2026', 'Dark 2026', ColorScheme.DARK],
		['Default High Contrast', 'Dark High Contrast', ColorScheme.HIGH_CONTRAST_DARK],
		['Quiet Light', 'Quiet Light', ColorScheme.LIGHT],
		['Light 2026', 'Light 2026', ColorScheme.LIGHT],
		['Default High Contrast Light', 'Light High Contrast', ColorScheme.HIGH_CONTRAST_LIGHT],
	];

	function setup(currentId: string, settings: Record<string, unknown>, installed = INSTALLED) {
		const themes = installed.map(([settingsId, label, type]) => ({ settingsId, label, type, id: `vs-${settingsId}` } as unknown as IWorkbenchColorTheme));
		const current = themes.find(theme => theme.settingsId === currentId)!;
		const themeService = {
			getColorTheme: () => current,
			getColorThemes: async () => themes,
		} as unknown as IWorkbenchThemeService;
		const writes: (readonly unknown[])[] = [];
		const configurationService = new class extends TestConfigurationService {
			override updateValue(key: string, value: unknown, target?: unknown): Promise<void> {
				writes.push([key, value, target]);
				return Promise.resolve();
			}
		}(settings);
		return { authority: new OnboardingAppearanceAuthority(themeService, configurationService), writes };
	}

	function baseline(): OnboardingAppearanceSnapshot {
		return {
			mode: 'dark',
			colorTheme: 'Monokai',
			preferredLight: 'Light 2026',
			preferredDark: 'Dark 2026',
			lightThemes: [],
			darkThemes: [],
		};
	}

	test('reads the mode from auto-detection first, then from the current theme, and splits the lists by scheme', async () => {
		const modes = async (currentId: string, settings: Record<string, unknown>) => (await setup(currentId, settings).authority.snapshot()).mode;
		const full = await setup('Default High Contrast', { 'window.autoDetectColorScheme': false }).authority.snapshot();
		assert.deepStrictEqual({
			system: await modes('Monokai', { 'window.autoDetectColorScheme': true }),
			light: await modes('Quiet Light', { 'window.autoDetectColorScheme': false }),
			dark: await modes('Monokai', {}),
			highContrastLight: await modes('Default High Contrast Light', {}),
			// High-contrast themes join the list of their base scheme, sorted by label with the rest.
			full,
		}, {
			system: 'system',
			light: 'light',
			dark: 'dark',
			highContrastLight: 'light',
			full: {
				mode: 'dark',
				colorTheme: 'Default High Contrast',
				preferredLight: 'Light 2026',
				preferredDark: 'Default High Contrast',
				lightThemes: [
					{ id: 'Light 2026', label: 'Light 2026' },
					{ id: 'Default High Contrast Light', label: 'Light High Contrast' },
					{ id: 'Quiet Light', label: 'Quiet Light' },
				],
				darkThemes: [
					{ id: 'Dark 2026', label: 'Dark 2026' },
					{ id: 'Default High Contrast', label: 'Dark High Contrast' },
					{ id: 'Monokai', label: 'Monokai' },
				],
			},
		});
	});

	test('prefills each preference from its setting, falling back to the current theme, the product default, then the first entry', async () => {
		const preferred = async (currentId: string, settings: Record<string, unknown>, installed = INSTALLED) => {
			const snapshot = await setup(currentId, settings, installed).authority.snapshot();
			return [snapshot.preferredLight, snapshot.preferredDark];
		};
		assert.deepStrictEqual({
			configured: await preferred('Monokai', { 'workbench.preferredLightColorTheme': 'Quiet Light', 'workbench.preferredDarkColorTheme': 'Monokai' }),
			unset: await preferred('Monokai', {}),
			unknown: await preferred('Quiet Light', { 'workbench.preferredLightColorTheme': 'Uninstalled', 'workbench.preferredDarkColorTheme': 'Uninstalled' }),
			noDefault: await preferred('Monokai', {}, INSTALLED.filter(([id]) => id !== 'Light 2026' && id !== 'Dark 2026')),
			empty: await preferred('Monokai', {}, INSTALLED.filter(([, , type]) => type === ColorScheme.DARK)),
		}, {
			configured: ['Quiet Light', 'Monokai'],
			// The current theme is dark, so only the dark preference can follow it.
			unset: ['Light 2026', 'Monokai'],
			unknown: ['Quiet Light', 'Dark 2026'],
			noDefault: ['Default High Contrast Light', 'Monokai'],
			empty: ['', 'Monokai'],
		});
	});

	test('writes only the settings the draft moved, to the user target', async () => {
		const applied = async (draft: OnboardingAppearanceDraft, snapshot = baseline()) => {
			const { authority, writes } = setup('Monokai', {});
			await authority.apply(snapshot, draft);
			return writes;
		};
		const user = ConfigurationTarget.USER;
		assert.deepStrictEqual({
			unchanged: await applied({ mode: 'dark', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }),
			toSystem: await applied({ mode: 'system', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }),
			toLight: await applied({ mode: 'light', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }),
			darkPreferenceUnderDark: await applied({ mode: 'dark', preferredLight: 'Light 2026', preferredDark: 'Monokai' }),
			lightPreferenceUnderDark: await applied({ mode: 'dark', preferredLight: 'Quiet Light', preferredDark: 'Dark 2026' }),
			preferenceUnderSystem: await applied({ mode: 'system', preferredLight: 'Quiet Light', preferredDark: 'Monokai' }, { ...baseline(), mode: 'system' }),
			fromSystemToDark: await applied({ mode: 'dark', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }, { ...baseline(), mode: 'system' }),
			everything: await applied({ mode: 'light', preferredLight: 'Quiet Light', preferredDark: 'Monokai' }),
			// A scheme with no installed themes has an empty preferred id; the mode still moves, but nothing is pinned.
			toDarkWithNoDarkThemes: await applied({ mode: 'dark', preferredLight: 'Light 2026', preferredDark: '' }, { ...baseline(), mode: 'light', colorTheme: 'Light 2026', preferredDark: '' }),
		}, {
			unchanged: [],
			toSystem: [['window.autoDetectColorScheme', true, user]],
			toLight: [['window.autoDetectColorScheme', false, user], ['workbench.colorTheme', 'Light 2026', user]],
			// The staged dark preference is already the theme in use, so only the preference moves.
			darkPreferenceUnderDark: [['workbench.preferredDarkColorTheme', 'Monokai', user]],
			// Dark mode never applies the light preference.
			lightPreferenceUnderDark: [['workbench.preferredLightColorTheme', 'Quiet Light', user]],
			preferenceUnderSystem: [['workbench.preferredLightColorTheme', 'Quiet Light', user], ['workbench.preferredDarkColorTheme', 'Monokai', user]],
			fromSystemToDark: [['window.autoDetectColorScheme', false, user], ['workbench.colorTheme', 'Dark 2026', user]],
			everything: [
				['window.autoDetectColorScheme', false, user],
				['workbench.preferredLightColorTheme', 'Quiet Light', user],
				['workbench.preferredDarkColorTheme', 'Monokai', user],
				['workbench.colorTheme', 'Quiet Light', user],
			],
			toDarkWithNoDarkThemes: [['window.autoDetectColorScheme', false, user]],
		});
	});

	test('returns the snapshot the writes leave behind, with the theme in use where it is known', async () => {
		const after = async (draft: OnboardingAppearanceDraft, snapshot = baseline()) => {
			const next = await setup('Monokai', {}).authority.apply(snapshot, draft);
			return [next.mode, next.preferredLight, next.preferredDark, next.colorTheme];
		};
		assert.deepStrictEqual({
			unchanged: await after({ mode: 'dark', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }),
			toLight: await after({ mode: 'light', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }),
			// The preference already in use is now known to be the theme, though nothing was pinned.
			darkPreferenceUnderDark: await after({ mode: 'dark', preferredLight: 'Light 2026', preferredDark: 'Monokai' }),
			lightPreferenceUnderDark: await after({ mode: 'dark', preferredLight: 'Quiet Light', preferredDark: 'Dark 2026' }),
			// Under System the operating system decides, so the theme in use is unknown until the next pin.
			toSystem: await after({ mode: 'system', preferredLight: 'Light 2026', preferredDark: 'Dark 2026' }),
			toDarkWithNoDarkThemes: await after({ mode: 'dark', preferredLight: 'Light 2026', preferredDark: '' }, { ...baseline(), mode: 'light', colorTheme: 'Light 2026', preferredDark: '' }),
		}, {
			unchanged: ['dark', 'Light 2026', 'Dark 2026', 'Monokai'],
			toLight: ['light', 'Light 2026', 'Dark 2026', 'Light 2026'],
			darkPreferenceUnderDark: ['dark', 'Light 2026', 'Monokai', 'Monokai'],
			lightPreferenceUnderDark: ['dark', 'Quiet Light', 'Dark 2026', 'Monokai'],
			toSystem: ['system', 'Light 2026', 'Dark 2026', ''],
			toDarkWithNoDarkThemes: ['dark', 'Light 2026', '', 'Light 2026'],
		});
	});
});
