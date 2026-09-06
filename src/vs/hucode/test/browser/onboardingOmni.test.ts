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
import { USLayoutResolvedKeybinding } from '../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import { MockKeybindingService } from '../../../platform/keybinding/test/common/mockKeybindingService.js';
import { OnboardingOmniAuthority } from '../../browser/onboarding/onboardingOmni.js';

suite('OnboardingOmniAuthority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Real resolved chords, so the labels under test are the ones the keybinding service would produce. */
	function chord(keybinding: number): ResolvedKeybinding {
		return USLayoutResolvedKeybinding.resolveKeybinding(decodeKeybinding(keybinding, OperatingSystem.Macintosh)!, OperatingSystem.Macintosh)[0];
	}

	function setup(bound: Record<string, ResolvedKeybinding> = {}) {
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
		return { authority: new OnboardingOmniAuthority(keybindingService, commandService), executed };
	}

	test('lists the four commands with a resolved chord where one is bound and none otherwise', () => {
		const unbound = setup().authority.snapshot().shortcuts;
		const bound = setup({
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
		const { authority, executed } = setup();
		await authority.addProject();
		await authority.openFolderAsWorkbench();
		assert.deepStrictEqual(executed, ['hucode.projectSwitcher.addProject', 'hucode.projectSwitcher.addWorkbench']);
	});
});
