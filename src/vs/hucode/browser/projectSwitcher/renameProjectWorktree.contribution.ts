/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { basename } from '../../../base/common/path.js';
import { isWeb } from '../../../base/common/platform.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from
	'../../../platform/actions/common/actions.js';
import { ServicesAccessor } from
	'../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from
	'../../../platform/notification/common/notification.js';
import { IProjectManagerService } from
	'../../../platform/projectManager/common/projectManager.js';
import { IQuickInputService } from
	'../../../platform/quickinput/common/quickInput.js';
import { TreeViewItemHandleArg } from
	'../../../workbench/common/views.js';
import { IWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/common/environmentService.js';
import { IHucodeShellService } from '../../common/omniWindow.js';
import {
	pathsEqual,
	RENAME_PROJECT_COMMAND_ID,
	RENAME_WORKTREE_COMMAND_ID,
} from './projectSwitcherCommon.js';
import { tryForwardShellRenameCommand } from
	'./renameProjectWorktreeRouting.js';

function parseProjectHandle(handle: string | undefined): string | undefined {
	if (!handle?.startsWith('project:')) {
		return undefined;
	}

	const [, section, projectId] = handle.split(':', 3);
	if ((section === 'pinned' || section === 'unpinned') && projectId) {
		return projectId;
	}

	return handle.slice('project:'.length);
}

function parseWorktreeHandle(
	handle: string | undefined
): { projectId: string; worktreePath: string } | undefined {
	if (!handle?.startsWith('worktree:')) {
		return undefined;
	}

	const [, projectId, encodedPath] = handle.split(':', 3);
	if (!projectId || !encodedPath) {
		return undefined;
	}

	return {
		projectId,
		worktreePath: decodeURIComponent(encodedPath),
	};
}

function getHandle(
	arg: string | TreeViewItemHandleArg | undefined
): string | undefined {
	if (typeof arg === 'string') {
		return arg;
	}

	return arg?.$treeItemHandle;
}

async function runShellRenameInput<T>(
	quickInputService: IQuickInputService,
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeShellService,
	callback: () => Promise<T>
): Promise<T> {
	if (environmentService.isOmniWindow) {
		await shellService.focusShell(dom.getWindowId(mainWindow));
	}

	const result = callback();
	if (environmentService.isOmniWindow) {
		mainWindow.requestAnimationFrame(() => quickInputService.focus());
		mainWindow.setTimeout(() => quickInputService.focus(), 0);
	}

	return result;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: RENAME_PROJECT_COMMAND_ID,
			title: localize2('renameProject', 'Rename Project'),
		});
	}

	async run(
		accessor: ServicesAccessor,
		handle?: string | TreeViewItemHandleArg
	): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const shellService = accessor.get(IHucodeShellService);

		try {
			const forwarded = await tryForwardShellRenameCommand(
				{
					isOmniWindow: environmentService.isOmniWindow,
					isWebClient: isWeb,
				},
				shellService,
				dom.getWindowId(mainWindow),
				RENAME_PROJECT_COMMAND_ID,
				handle
			);
			if (forwarded) {
				return;
			}

			const projectId = parseProjectHandle(getHandle(handle));
			if (!projectId) {
				return;
			}

			const projects = await projectManagerService.getProjects();
			const project = projects.find(entry => entry.id === projectId);
			if (!project) {
				return;
			}

			const label = await runShellRenameInput(
				quickInputService,
				environmentService,
				shellService,
				() => quickInputService.input({
					prompt: localize('renameProjectPrompt', 'Project label'),
					value: project.label,
					validateInput: async value => value.trim()
						? undefined
						: localize(
							'renameProjectValidate',
							'Project label is required.'
						),
				})
			);
			if (!label) {
				return;
			}

			await projectManagerService.renameProject(projectId, label);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: RENAME_WORKTREE_COMMAND_ID,
			title: localize2('renameWorktree', 'Rename Worktree'),
		});
	}

	async run(
		accessor: ServicesAccessor,
		handle?: string | TreeViewItemHandleArg
	): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const shellService = accessor.get(IHucodeShellService);

		try {
			const forwarded = await tryForwardShellRenameCommand(
				{
					isOmniWindow: environmentService.isOmniWindow,
					isWebClient: isWeb,
				},
				shellService,
				dom.getWindowId(mainWindow),
				RENAME_WORKTREE_COMMAND_ID,
				handle
			);
			if (forwarded) {
				return;
			}

			const parsed = parseWorktreeHandle(getHandle(handle));
			if (!parsed) {
				return;
			}

			const projects = await projectManagerService.getProjects();
			const project = projects.find(entry => entry.id === parsed.projectId);
			const worktree = project?.worktrees.find(entry =>
				pathsEqual(entry.path, parsed.worktreePath)
			);
			if (!project || !worktree) {
				return;
			}

			const defaultLabel = worktree.isMain
				? localize('localWorktree', 'local')
				: basename(worktree.path);
			const label = await runShellRenameInput(
				quickInputService,
				environmentService,
				shellService,
				() => quickInputService.input({
					prompt: localize('renameWorktreePrompt', 'Worktree label'),
					value: worktree.customLabel ?? defaultLabel,
					validateInput: async value => value.trim()
						? undefined
						: localize(
							'renameWorktreeValidate',
							'Worktree label is required.'
						),
				})
			);
			if (!label) {
				return;
			}

			await projectManagerService.renameWorktree(
				parsed.projectId,
				parsed.worktreePath,
				label
			);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});
