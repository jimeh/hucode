/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Color } from '../../../base/common/color.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ColorScheme } from '../../../platform/theme/common/theme.js';
import { IHucodeHostedAppearanceSnapshot } from
	'../../../platform/window/common/hucodeHostedShellService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	createHucodeHostedAppearanceSnapshot,
	HostedWorkbenchAppearanceContribution,
} from '../../browser/hostedWorkbenchAppearance.contribution.js';
import {
	getHucodeOmniProjectedAppearance,
	HucodeOmniAppearanceProjectionModel,
	OmniAppearanceProjectionContribution,
} from
	'../../browser/omniAppearanceProjection.contribution.js';
import { IHucodeHostedWorkspaceState } from '../../common/omniWindow.js';
import { IWorkbenchColorTheme } from
	'../../../workbench/services/themes/common/workbenchThemeService.js';

suite('Hucode Omni appearance projection', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('builds resolved light, dark, and high-contrast snapshots', () => {
		for (const [type, colorScheme] of [
			[ColorScheme.LIGHT, 'light'],
			[ColorScheme.DARK, 'dark'],
			[ColorScheme.HIGH_CONTRAST_LIGHT, 'hc-light'],
			[ColorScheme.HIGH_CONTRAST_DARK, 'hc-dark'],
		] as const) {
			const snapshot = createHucodeHostedAppearanceSnapshot({
				type,
				getColor: id => {
					switch (id) {
						case 'sideBar.background':
							return Color.fromHex('#123456');
						case 'scrollbarSlider.background':
							return Color.fromHex('#234567');
						case 'list.focusOutline':
							return Color.fromHex('#345678');
						default:
							return undefined;
					}
				},
			} as IWorkbenchColorTheme, true, false);
			assert.strictEqual(snapshot.colorScheme, colorScheme);
			assert.strictEqual(
				snapshot.workbenchBackground,
				colorScheme === 'light' ? '#f3f3f3' :
					colorScheme === 'hc-light' ? '#ffffff' :
						colorScheme === 'hc-dark' ? '#000000' : '#252526'
			);
			assert.strictEqual(
				snapshot.colors['sideBar.background'],
				'#123456'
			);
			assert.strictEqual(
				snapshot.colors['scrollbarSlider.background'],
				'#234567'
			);
			assert.strictEqual(
				snapshot.colors['list.focusOutline'],
				'#345678'
			);
			assert.strictEqual(snapshot.modernUI, true);
			assert.strictEqual(
				snapshot.modernUIUppercaseViewHeaders,
				false
			);
		}
	});

	test('projects active cache and preserves it across shell focus', () => {
		const applied: Array<IHucodeHostedAppearanceSnapshot | undefined> = [];
		const model = new HucodeOmniAppearanceProjectionModel(snapshot =>
			applied.push(snapshot)
		);
		const dark = appearance('dark', '#111111');
		const light = appearance('light', '#eeeeee');

		model.update(state('one', [instance('one', dark)]));
		model.update({
			...state('one', [instance('one', dark)]),
			projectsSidebarVisible: true,
			instances: [{ ...instance('one', dark), focused: false }],
		});
		model.update(state('one', [
			instance('one', dark),
			instance('two', light),
		]));
		assert.deepStrictEqual(applied, [dark]);

		model.update(state('two', [
			instance('one', dark),
			instance('two', light),
		]));
		assert.deepStrictEqual(applied, [dark, light]);
	});

	test('ignores inactive updates and clears an uncached active projection', () => {
		const applied: Array<IHucodeHostedAppearanceSnapshot | undefined> = [];
		const model = new HucodeOmniAppearanceProjectionModel(snapshot =>
			applied.push(snapshot)
		);
		const dark = appearance('dark', '#111111');
		const inactivePreview = appearance('hc-light', '#abcdef');

		model.update(state('one', [
			instance('one', dark),
			instance('two'),
		]));
		model.update(state('one', [
			instance('one', dark),
			instance('two', inactivePreview),
		]));
		model.update(state('two', [
			instance('one', dark),
			instance('two'),
		]));
		assert.deepStrictEqual(applied, [dark, undefined]);

		model.update(state('two', [
			instance('one', dark),
			instance('two', inactivePreview),
		]));
		model.update(state(undefined, []));
		assert.deepStrictEqual(applied, [
			dark,
			undefined,
			inactivePreview,
			undefined,
		]);
	});

	test('applies persisted, preview, cancel, and Modern UI changes', () => {
		const applied: Array<IHucodeHostedAppearanceSnapshot | undefined> = [];
		const model = new HucodeOmniAppearanceProjectionModel(snapshot =>
			applied.push(snapshot)
		);
		const persisted = appearance('dark', '#111111');
		const preview = appearance('light', '#eeeeee', true, true);

		model.update(state('one', [instance('one', persisted)]));
		model.update(state('one', [instance('one', preview)]));
		model.update(state('one', [instance('one', persisted)]));
		assert.deepStrictEqual(applied, [persisted, preview, persisted]);
	});

	test('publisher republishes preview, configuration, active, and profile changes',
		async () => {
			const themeChanges = disposables.add(
				new Emitter<IWorkbenchColorTheme>()
			);
			const configurationChanges = disposables.add(new Emitter<{
				affectsConfiguration(key: string): boolean;
			}>());
			const profileChanges = disposables.add(new Emitter<{
				readonly previous: object;
				readonly profile: object;
				join(promise: Promise<void>): void;
			}>());
			const shellStateChanges = disposables.add(new Emitter<never>());
			let currentTheme = theme(ColorScheme.DARK, '#111111');
			let modernUI = false;
			let uppercase = false;
			const published: IHucodeHostedAppearanceSnapshot[] = [];
			const contribution = disposables.add(
				new HostedWorkbenchAppearanceContribution(
					{ isHostedOmniWorkspace: true, hostedInstanceId: 'one' } as never,
					{
						onDidChangeState: shellStateChanges.event,
						getState: async () => ({
							available: true,
							projectsSidebarVisible: false,
							projectSwitcherCanGoBack: false,
							projectSwitcherCanGoForward: false,
							active: true,
							visible: true,
						}),
						publishAppearance: async (
							snapshot: IHucodeHostedAppearanceSnapshot
						) => {
							published.push(snapshot);
							return 'accepted';
						},
					} as never,
					{
						getColorTheme: () => currentTheme,
						onDidColorThemeChange: themeChanges.event,
					} as never,
					{
						getValue: (key: string) => key.endsWith(
							'modernUIUppercaseViewHeaders'
						) ? uppercase : modernUI,
						onDidChangeConfiguration: configurationChanges.event,
					} as never,
					{ onDidChangeCurrentProfile: profileChanges.event } as never
				)
			);
			assert.ok(contribution);
			await settled();
			assert.strictEqual(published.at(-1)?.colorScheme, 'dark');

			currentTheme = theme(ColorScheme.LIGHT, '#eeeeee');
			themeChanges.fire(currentTheme);
			await settled();
			assert.strictEqual(published.at(-1)?.colorScheme, 'light');

			modernUI = true;
			uppercase = true;
			configurationChanges.fire({
				affectsConfiguration: () => true,
			});
			await settled();
			assert.deepStrictEqual({
				modernUI: published.at(-1)?.modernUI,
				uppercase: published.at(-1)?.modernUIUppercaseViewHeaders,
			}, { modernUI: true, uppercase: true });

			currentTheme = theme(ColorScheme.HIGH_CONTRAST_DARK, '#000000');
			const joins: Promise<void>[] = [];
			profileChanges.fire({
				previous: {},
				profile: {},
				join: promise => joins.push(promise),
			});
			await Promise.all(joins);
			assert.strictEqual(published.at(-1)?.colorScheme, 'hc-dark');
		});

	test('DOM projection applies colors and Modern UI then restores fallback',
		async () => {
			const stateChanges = disposables.add(
				new Emitter<IHucodeHostedWorkspaceState>()
			);
			const configurationChanges = disposables.add(new Emitter<never>());
			const container = document.createElement('div');
			const title = document.createElement('div');
			const sidebar = document.createElement('div');
			container.classList.add('monaco-workbench', 'vs');
			let layouts = 0;
			let partStyleUpdates = 0;
			const partAppearances: Array<
				IHucodeHostedAppearanceSnapshot | undefined
			> = [];
			const fallbackTheme = theme(ColorScheme.LIGHT, '#ffffff');
			const contribution = disposables.add(
				new OmniAppearanceProjectionContribution(
					{ isOmniShellWindow: true } as never,
					{
						onDidChangeState: stateChanges.event,
						getState: async () => state(undefined, []),
					} as never,
					{
						containers: [container],
						onDidAddContainer: Event.None,
						getContainer: (_window: Window, part: string) =>
							part.endsWith('titlebar') ? title : sidebar,
						getPart: () => ({
							updateStyles: () => {
								partStyleUpdates++;
								partAppearances.push(
									getHucodeOmniProjectedAppearance()
								);
							},
						}),
						layout: () => layouts++,
					} as never,
					{ getColorTheme: () => fallbackTheme } as never,
					{
						getValue: () => false,
						onDidChangeConfiguration: configurationChanges.event,
					} as never
				)
			);
			assert.ok(contribution);
			const projected: IHucodeHostedAppearanceSnapshot = {
				...appearance('hc-dark', '#101010', true, true),
				colors: {
					'sideBar.background': '#101010',
					'scrollbarSlider.background': '#303030',
					'list.focusOutline': '#404040',
					'titleBar.activeBackground': '#202020',
					'titleBar.activeForeground': '#fefefe',
					'sideBar.foreground': '#fafafa',
				},
			};
			stateChanges.fire(state('one', [instance('one', projected)]));

			assert.strictEqual(container.classList.contains('hc-black'), true);
			assert.strictEqual(container.classList.contains('modern-ui'), true);
			assert.strictEqual(container.classList.contains(
				'modern-ui-uppercase-view-headers'
			), true);
			assert.strictEqual(
				container.style.getPropertyValue('--vscode-sideBar-background'),
				'#101010'
			);
			assert.strictEqual(container.style.backgroundColor, 'rgb(16, 16, 16)');
			assert.strictEqual(
				container.style.getPropertyValue(
					'--vscode-scrollbarSlider-background'
				),
				'#303030'
			);
			assert.strictEqual(
				container.style.getPropertyValue('--vscode-list-focusOutline'),
				'#404040'
			);
			assert.strictEqual(title.style.backgroundColor, 'rgb(32, 32, 32)');
			assert.strictEqual(sidebar.style.color, 'rgb(250, 250, 250)');
			assert.strictEqual(layouts, 1);
			assert.strictEqual(partStyleUpdates, 2);
			assert.deepStrictEqual(partAppearances, [projected, projected]);

			stateChanges.fire(state(undefined, []));
			assert.strictEqual(container.classList.contains('vs'), true);
			assert.strictEqual(container.classList.contains('modern-ui'), false);
			assert.strictEqual(
				container.style.getPropertyValue('--vscode-sideBar-background'),
				''
			);
			assert.strictEqual(container.style.backgroundColor, '');
			assert.strictEqual(layouts, 2);
			assert.strictEqual(partStyleUpdates, 4);
			assert.deepStrictEqual(partAppearances.slice(2), [
				undefined,
				undefined,
			]);
		});
});

function appearance(
	colorScheme: IHucodeHostedAppearanceSnapshot['colorScheme'],
	background: string,
	modernUI = false,
	modernUIUppercaseViewHeaders = false
): IHucodeHostedAppearanceSnapshot {
	return {
		colorScheme,
		workbenchBackground: background,
		colors: { 'sideBar.background': background },
		modernUI,
		modernUIUppercaseViewHeaders,
	};
}

function instance(
	instanceId: string,
	appearance?: IHucodeHostedAppearanceSnapshot
) {
	return {
		instanceId,
		worktreePath: `/${instanceId}`,
		state: 'active' as const,
		visible: true,
		focused: true,
		appearance,
	};
}

function state(
	activeInstanceId: string | undefined,
	instances: IHucodeHostedWorkspaceState['instances']
): IHucodeHostedWorkspaceState {
	return {
		activeInstanceId,
		projectsSidebarVisible: false,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances,
	};
}

function theme(
	type: ColorScheme,
	background: string
): IWorkbenchColorTheme {
	return {
		type,
		getColor: id => id === 'sideBar.background'
			? Color.fromHex(background)
			: undefined,
	} as IWorkbenchColorTheme;
}

function settled(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}
