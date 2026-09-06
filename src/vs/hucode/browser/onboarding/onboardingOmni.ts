/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { ADD_PROJECT_COMMAND_ID } from '../../../platform/window/common/hucodeHostedShellActions.js';
import {
	HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING,
	HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING,
	HucodeOmniItemLayout,
	normalizeHucodeOmniItemLayout,
} from '../../common/retainedWorkbench.js';
import {
	ADD_WORKBENCH_COMMAND_ID,
	QUICK_SWITCH_LOADED_WORKTREE_COMMAND_ID,
	SWITCH_NEXT_LOADED_WORKTREE_COMMAND_ID,
	SWITCH_PREVIOUS_LOADED_WORKTREE_COMMAND_ID,
	SWITCH_WORKTREE_COMMAND_ID,
} from '../projectSwitcher/projectSwitcherCommon.js';

/** The list density Meet Omni previews and writes: one value for both Omni layout settings. */
export type OnboardingDensity = HucodeOmniItemLayout;

/** One command Meet Omni mentions, with the chord the running platform resolves for it, if any. */
export interface OnboardingOmniShortcut {
	readonly commandId: string;
	readonly label: string;
	readonly keybinding?: { readonly label: string; readonly ariaLabel: string };
}

/** What Meet Omni shows when it opens: the density in effect and the shortcuts to mention. */
export interface OnboardingOmniSnapshot {
	readonly density: OnboardingDensity;
	readonly shortcuts: readonly OnboardingOmniShortcut[];
}

/** Reads the Omni layout, resolves the shortcut labels, and runs the handoff commands for the session. */
export interface IOnboardingOmniAuthority {
	snapshot(): OnboardingOmniSnapshot;
	/** Writes both layout settings to `density`, each only where its current value differs. */
	applyDensity(density: OnboardingDensity): Promise<void>;
	addProject(): Promise<void>;
	openFolderAsWorkbench(): Promise<void>;
}

/** The text naming the density on show, visible beside the preview and announced when it changes. */
export function onboardingDensityLabel(density: OnboardingDensity): string {
	return density === 'compact'
		? localize('onboarding.meetOmni.density.compact', "Showing compact lists.")
		: localize('onboarding.meetOmni.density.default', "Showing default lists.");
}

const LAYOUT_SETTINGS: readonly string[] = [HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING, HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING];

/**
 * Omni authority over the configuration, keybinding, and command services.
 *
 * The two layout settings are independent in Settings, but onboarding offers one switch: the
 * snapshot reports `compact` only when both are, so the switch reads as off whenever a user has
 * mixed them, and Continue then writes only the setting that still differs. The handoff commands
 * own their own dialogs and path handling; nothing here opens one.
 */
export class OnboardingOmniAuthority implements IOnboardingOmniAuthority {
	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
	) { }

	snapshot(): OnboardingOmniSnapshot {
		const layouts = LAYOUT_SETTINGS.map(key => normalizeHucodeOmniItemLayout(this.configurationService.getValue(key)));
		return {
			density: layouts.every(layout => layout === 'compact') ? 'compact' : 'default',
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

	async applyDensity(density: OnboardingDensity): Promise<void> {
		for (const key of LAYOUT_SETTINGS) {
			if (normalizeHucodeOmniItemLayout(this.configurationService.getValue(key)) !== density) {
				await this.configurationService.updateValue(key, density, ConfigurationTarget.USER);
			}
		}
	}

	async addProject(): Promise<void> {
		await this.commandService.executeCommand(ADD_PROJECT_COMMAND_ID);
	}

	async openFolderAsWorkbench(): Promise<void> {
		await this.commandService.executeCommand(ADD_WORKBENCH_COMMAND_ID);
	}
}
