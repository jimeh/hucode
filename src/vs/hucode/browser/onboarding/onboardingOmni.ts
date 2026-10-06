/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { URI } from '../../../base/common/uri.js';
import { IDialogService, IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IProjectManagerService } from '../../../platform/projectManager/common/projectManager.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { IHucodeShellControllerService } from '../../../platform/window/common/hucodeShellControllerService.js';
import { pickProjectSwitcherFolder, resolveOnboardingFolderTarget } from '../projectSwitcher/projectSwitcherOperations.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import {
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

/** Resolves shortcut labels and opens the chosen first project or workbench. */
export interface IOnboardingOmniAuthority {
	snapshot(): OnboardingOmniSnapshot;
	addProject(handoffProfileId?: string): Promise<void>;
	openFolderAsWorkbench(handoffProfileId?: string): Promise<void>;
}

/** Resolves folder selection and explicit profile offers through main-owned admission. */
export class OnboardingOmniAuthority implements IOnboardingOmniAuthority {
	constructor(
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IDialogService private readonly dialogService: IDialogService,
		@IProjectManagerService private readonly projectManagerService: IProjectManagerService,
		@IHucodeShellControllerService private readonly shellService: IHucodeShellControllerService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
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

	async addProject(handoffProfileId?: string): Promise<void> {
		await this.handoff('project', handoffProfileId);
	}

	async openFolderAsWorkbench(handoffProfileId?: string): Promise<void> {
		await this.handoff('workbench', handoffProfileId);
	}

	private async handoff(kind: 'project' | 'workbench', handoffProfileId?: string): Promise<void> {
		try {
			const selected = await pickProjectSwitcherFolder(kind, this.fileDialogService, this.projectManagerService, this.shellService, true);
			if (selected.kind === 'failed') { throw selected.error; }
			if (selected.kind === 'cancelled') { return; }
			const projects = await this.projectManagerService.getProjects();
			let target = resolveOnboardingFolderTarget(selected.folder, projects, selected.project);
			if (!target) {
				const project = selected.project ?? projects.find(candidate => candidate.rootUri.toString() === selected.folder.toString());
				const picked = await this.quickInputService.pick((project?.worktrees ?? []).map(worktree => ({ label: worktree.path, worktree })), { placeHolder: localize('onboarding.pickWorktree', "Choose a worktree to open") });
				if (!picked || !project) { return; }
				target = { worktreePath: picked.worktree.path, projectId: project.id };
			}
			for (; ;) {
				const offer = await this.shellService.inspectOnboardingTarget(target.worktreePath, handoffProfileId);
				let profileId: string | undefined;
				if (!offer.alreadyOpen && offer.importedProfile && offer.importedProfile.id !== offer.associatedProfileId) {
					const choice = await this.dialogService.prompt<'keep' | 'use' | 'cancel'>({
						message: localize('onboarding.profileOffer', "Choose the profile for {0}", offer.worktreePath),
						detail: localize('onboarding.profileOfferDetail', "The imported profile '{0}' is available. This choice applies only to this folder, including this worktree. Other worktrees keep their existing profiles. Review any unresolved import items through Hucode: Import Editor Profile.", offer.importedProfile.name),
						buttons: [
							{ label: localize('onboarding.keepProfile', "Keep {0}", offer.associatedProfileName ?? 'Default'), run: () => 'keep' },
							{ label: localize('onboarding.useProfile', "Use {0}", offer.importedProfile.name), run: () => 'use' },
						],
						cancelButton: { run: () => 'cancel' },
					});
					if (choice.result === 'cancel') { return; }
					if (choice.result === 'use') {
						if (offer.associatedProfileId) {
							const confirmation = await this.dialogService.prompt<boolean>({
								message: localize('onboarding.replaceProfile', "Replace '{0}' with '{1}' for {2}?", offer.associatedProfileName ?? 'Default', offer.importedProfile.name, offer.worktreePath),
								buttons: [
									{ label: localize('onboarding.keepExisting', "Keep Existing Profile"), run: () => false },
									{ label: localize('onboarding.replace', "Replace Profile"), run: () => true },
								],
								cancelButton: { run: () => false },
							});
							if (confirmation.result) { profileId = offer.importedProfile.id; }
						} else { profileId = offer.importedProfile.id; }
					}
				}
				const result = await this.shellService.openOnboardingWorkbench({ worktreePath: offer.worktreePath, projectId: target.projectId, profileId, expectedProfileId: offer.associatedProfileId });
				if (result.kind === 'conflict') {
					this.notificationService.info(localize('onboarding.associationChanged', "The folder's profile changed while the offer was open. Review its current association."));
					continue;
				}
				if (result.kind === 'failed') {
					this.notificationService.error(result.associationSaved ? localize('onboarding.openFailedAfterProfile', "The profile association was saved, but the workbench could not be opened: {0}", result.message) : result.message);
				} else if (result.kind === 'alreadyOpen') {
					this.notificationService.info(localize('onboarding.alreadyOpen', "{0} is already open. Its profile is unchanged. Use that workbench's profile command to switch profiles.", URI.file(offer.worktreePath).fsPath));
				}
				return;
			}
		} catch (error) {
			this.notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
}
