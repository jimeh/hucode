/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../base/common/event.js';
import { KeyChord, KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { ResolvedKeybinding, decodeKeybinding } from '../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ICommandEvent, ICommandService } from '../../../platform/commands/common/commands.js';
import { ConfigurationTarget } from '../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../platform/configuration/test/common/testConfigurationService.js';
import { USLayoutResolvedKeybinding } from '../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import { MockKeybindingService } from '../../../platform/keybinding/test/common/mockKeybindingService.js';
import { OnboardingOmniAuthority } from '../../browser/onboarding/onboardingOmni.js';

suite('OnboardingOmniAuthority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const WORKTREE = 'hucode.omni.worktreeItemLayout';
	const WORKBENCH = 'hucode.omni.workbenchItemLayout';

	/** Real resolved chords, so the labels under test are the ones the keybinding service would produce. */
	function chord(keybinding: number): ResolvedKeybinding {
		return USLayoutResolvedKeybinding.resolveKeybinding(decodeKeybinding(keybinding, OperatingSystem.Macintosh)!, OperatingSystem.Macintosh)[0];
	}

	function setup(settings: Record<string, unknown>, bound: Record<string, ResolvedKeybinding> = {}) {
		const writes: (readonly unknown[])[] = [];
		const configurationService = new class extends TestConfigurationService {
			override updateValue(key: string, value: unknown, target?: unknown): Promise<void> {
				writes.push([key, value, target]);
				return Promise.resolve();
			}
		}(settings);
		const keybindingService = new class extends MockKeybindingService {
			override lookupKeybinding(commandId: string): ResolvedKeybinding | undefined {
				return bound[commandId];
			}
		}();
		const executed: string[] = [];
		const commandService = new class implements ICommandService {
			declare readonly _serviceBrand: undefined;
			readonly onWillExecuteCommand: Event<ICommandEvent> = Event.None;
			readonly onDidExecuteCommand: Event<ICommandEvent> = Event.None;
			executeCommand<R>(commandId: string): Promise<R | undefined> {
				executed.push(commandId);
				return Promise.resolve(undefined);
			}
		}();
		return { authority: new OnboardingOmniAuthority(configurationService, keybindingService, commandService), writes, executed };
	}

	test('reports compact only when both layout settings are compact', () => {
		const density = (settings: Record<string, unknown>) => setup(settings).authority.snapshot().density;
		assert.deepStrictEqual({
			unset: density({}),
			both: density({ [WORKTREE]: 'compact', [WORKBENCH]: 'compact' }),
			worktreeOnly: density({ [WORKTREE]: 'compact' }),
			workbenchOnly: density({ [WORKBENCH]: 'compact', [WORKTREE]: 'default' }),
			garbage: density({ [WORKTREE]: 'dense', [WORKBENCH]: 'compact' }),
		}, {
			unset: 'default',
			both: 'compact',
			worktreeOnly: 'default',
			workbenchOnly: 'default',
			garbage: 'default',
		});
	});

	test('writes each layout setting to the user target only where it differs', async () => {
		const applied = async (settings: Record<string, unknown>, density: 'default' | 'compact') => {
			const { authority, writes } = setup(settings);
			await authority.applyDensity(density);
			return writes;
		};
		const user = ConfigurationTarget.USER;
		assert.deepStrictEqual({
			toCompact: await applied({}, 'compact'),
			alreadyCompact: await applied({ [WORKTREE]: 'compact', [WORKBENCH]: 'compact' }, 'compact'),
			mixedToCompact: await applied({ [WORKTREE]: 'compact' }, 'compact'),
			mixedToDefault: await applied({ [WORKTREE]: 'compact' }, 'default'),
			alreadyDefault: await applied({}, 'default'),
		}, {
			toCompact: [[WORKTREE, 'compact', user], [WORKBENCH, 'compact', user]],
			alreadyCompact: [],
			mixedToCompact: [[WORKBENCH, 'compact', user]],
			mixedToDefault: [[WORKTREE, 'default', user]],
			alreadyDefault: [],
		});
	});

	test('lists the four commands with a resolved chord where one is bound and none otherwise', () => {
		const unbound = setup({}).authority.snapshot().shortcuts;
		const bound = setup({}, {
			'hucode.projectSwitcher.switchWorktree': chord(KeyMod.CtrlCmd | KeyCode.KeyO),
			'hucode.projectSwitcher.switchNextLoadedWorktree': chord(KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.DownArrow)),
		}).authority.snapshot().shortcuts;
		assert.deepStrictEqual({ unbound, bound }, {
			unbound: [
				{ commandId: 'hucode.projectSwitcher.switchWorktree', label: 'Switch Workbench' },
				{ commandId: 'hucode.projectSwitcher.quickSwitchLoadedWorktree', label: 'Quick Switch Loaded Workbench' },
				{ commandId: 'hucode.projectSwitcher.switchNextLoadedWorktree', label: 'Switch to Next Loaded Workbench' },
				{ commandId: 'hucode.projectSwitcher.switchPreviousLoadedWorktree', label: 'Switch to Previous Loaded Workbench' },
			],
			bound: [
				{ commandId: 'hucode.projectSwitcher.switchWorktree', label: 'Switch Workbench', keybinding: { label: '⌘O', ariaLabel: 'Command+O' } },
				{ commandId: 'hucode.projectSwitcher.quickSwitchLoadedWorktree', label: 'Quick Switch Loaded Workbench' },
				{ commandId: 'hucode.projectSwitcher.switchNextLoadedWorktree', label: 'Switch to Next Loaded Workbench', keybinding: { label: '⌘K ⌘↓', ariaLabel: 'Command+K Command+DownArrow' } },
				{ commandId: 'hucode.projectSwitcher.switchPreviousLoadedWorktree', label: 'Switch to Previous Loaded Workbench' },
			],
		});
	});

	test('runs the handoff commands by id and opens no dialog of its own', async () => {
		const { authority, executed } = setup({});
		await authority.addProject();
		await authority.openFolderAsWorkbench();
		assert.deepStrictEqual(executed, ['hucode.projectSwitcher.addProject', 'hucode.projectSwitcher.addWorkbench']);
	});
});
