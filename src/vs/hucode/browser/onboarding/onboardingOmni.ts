/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { ADD_PROJECT_COMMAND_ID } from '../../../platform/window/common/hucodeHostedShellActions.js';
import {
	ADD_WORKBENCH_COMMAND_ID,
	QUICK_SWITCH_LOADED_WORKTREE_COMMAND_ID,
	SWITCH_NEXT_LOADED_WORKTREE_COMMAND_ID,
	SWITCH_PREVIOUS_LOADED_WORKTREE_COMMAND_ID,
	SWITCH_WORKTREE_COMMAND_ID,
} from '../projectSwitcher/projectSwitcherCommon.js';

/** One command Meet Omni mentions, with the chord the running platform resolves for it, if any. */
export interface OnboardingOmniShortcut {
	readonly commandId: string;
	readonly label: string;
	readonly keybinding?: { readonly label: string; readonly ariaLabel: string };
}

/** What Meet Omni shows when it opens: the shortcuts to mention. */
export interface OnboardingOmniSnapshot {
	readonly shortcuts: readonly OnboardingOmniShortcut[];
}

/** Resolves the shortcut labels and runs the handoff commands for the session. */
export interface IOnboardingOmniAuthority {
	snapshot(): OnboardingOmniSnapshot;
	addProject(): Promise<void>;
	openFolderAsWorkbench(): Promise<void>;
}

/**
 * Omni authority over the keybinding and command services.
 *
 * The handoff commands own their own dialogs and path handling; nothing here opens one.
 */
export class OnboardingOmniAuthority implements IOnboardingOmniAuthority {
	constructor(
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
	) { }

	snapshot(): OnboardingOmniSnapshot {
		return {
			shortcuts: [
				this.shortcut(SWITCH_WORKTREE_COMMAND_ID, localize('onboarding.meetOmni.shortcut.switch', "Switch Workbench")),
				this.shortcut(QUICK_SWITCH_LOADED_WORKTREE_COMMAND_ID, localize('onboarding.meetOmni.shortcut.quickSwitch', "Quick Switch Loaded Workbench")),
				this.shortcut(SWITCH_NEXT_LOADED_WORKTREE_COMMAND_ID, localize('onboarding.meetOmni.shortcut.next', "Switch to Next Loaded Workbench")),
				this.shortcut(SWITCH_PREVIOUS_LOADED_WORKTREE_COMMAND_ID, localize('onboarding.meetOmni.shortcut.previous', "Switch to Previous Loaded Workbench")),
			],
		};
	}

	private shortcut(commandId: string, label: string): OnboardingOmniShortcut {
		const resolved = this.keybindingService.lookupKeybinding(commandId);
		const chord = resolved?.getLabel();
		const ariaLabel = resolved?.getAriaLabel();
		return chord && ariaLabel ? { commandId, label, keybinding: { label: chord, ariaLabel } } : { commandId, label };
	}

	async addProject(): Promise<void> {
		await this.commandService.executeCommand(ADD_PROJECT_COMMAND_ID);
	}

	async openFolderAsWorkbench(): Promise<void> {
		await this.commandService.executeCommand(ADD_WORKBENCH_COMMAND_ID);
	}
}
