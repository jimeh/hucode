/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from
	'../../../platform/actions/common/actions.js';
import { ServicesAccessor } from
	'../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from
	'../../../platform/notification/common/notification.js';
import {
	CreateWorktreeOptions,
	IProjectManagerService,
	WorktreeRefRecord,
} from '../../../platform/projectManager/common/projectManager.js';
import {
	IQuickInputService,
	IQuickPickItem,
	QuickPickInput,
} from '../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/common/environmentService.js';
import { TreeViewItemHandleArg } from
	'../../../workbench/common/views.js';
import { IHucodeShellService } from '../../common/omniWindow.js';
import { CREATE_WORKTREE_COMMAND_ID } from './projectSwitcherCommon.js';

type CreateWorktreeRefQuickPick = IQuickPickItem & {
	readonly kind: 'ref';
	readonly ref: WorktreeRefRecord;
};

type CreateWorktreeQuickPick = IQuickPickItem & (
	| { readonly kind: 'createBranch' }
	| { readonly kind: 'createBranchFrom' }
	| CreateWorktreeRefQuickPick
);

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

function getProjectHandle(
	arg: string | TreeViewItemHandleArg | undefined
): string | undefined {
	if (typeof arg === 'string') {
		return arg;
	}

	return arg?.$treeItemHandle;
}

async function pickCreateWorktreeOptions(
	projectId: string,
	projectManagerService: IProjectManagerService,
	quickInputService: IQuickInputService,
	notificationService: INotificationService,
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeShellService
): Promise<CreateWorktreeOptions | undefined> {
	const refs = await projectManagerService.getWorktreeRefs(projectId);
	const createBranchPick: CreateWorktreeQuickPick = {
		kind: 'createBranch',
		label: localize(
			'createWorktreeNewBranch',
			'{0} Create new branch...',
			'$(plus)'
		),
	};
	const createBranchFromPick: CreateWorktreeQuickPick = {
		kind: 'createBranchFrom',
		label: localize(
			'createWorktreeNewBranchFrom',
			'{0} Create new branch from...',
			'$(plus)'
		),
	};
	const picks: QuickPickInput<CreateWorktreeQuickPick>[] = [
		createBranchPick,
		createBranchFromPick,
		{ type: 'separator' },
		...toCreateWorktreeRefPicks(refs, 'head'),
		...toCreateWorktreeRefPicks(refs, 'remote'),
		...toCreateWorktreeRefPicks(refs, 'tag'),
	];
	const choice = await runCreateWorktreeQuickInput(
		quickInputService,
		environmentService,
		shellService,
		() => quickInputService.pick(picks, {
			placeHolder: localize(
				'createWorktreePickRef',
				'Select a branch or tag to create the new worktree from'
			),
		})
	);
	if (!choice) {
		return undefined;
	}

	if (choice.kind === 'createBranch') {
		const branchName = await pickCreateWorktreeBranchName(
			projectId,
			refs,
			projectManagerService,
			quickInputService,
			environmentService,
			shellService
		);
		return branchName ? { branchName } : undefined;
	}

	if (choice.kind === 'createBranchFrom') {
		const startPoint = await runCreateWorktreeQuickInput(
			quickInputService,
			environmentService,
			shellService,
			() => quickInputService.pick(
				toCreateWorktreeBaseRefPicks(refs),
				{
					placeHolder: localize(
						'createWorktreePickBranchFromRef',
						'Select a branch or tag to create the new branch from'
					),
				}
			)
		);
		if (!startPoint) {
			return undefined;
		}

		const branchName = await pickCreateWorktreeBranchName(
			projectId,
			refs,
			projectManagerService,
			quickInputService,
			environmentService,
			shellService
		);
		return branchName
			? { branchName, startPoint: startPoint.ref.name }
			: undefined;
	}

	if (choice.ref.checkedOutPath) {
		notificationService.error(localize(
			'createWorktreeRefAlreadyCheckedOut',
			'Branch "{0}" is already checked out at "{1}".',
			choice.ref.name,
			choice.ref.checkedOutPath
		));
		return undefined;
	}

	return { startPoint: choice.ref.name };
}

function pickCreateWorktreeBranchName(
	projectId: string,
	refs: readonly WorktreeRefRecord[],
	projectManagerService: IProjectManagerService,
	quickInputService: IQuickInputService,
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeShellService
): Promise<string | undefined> {
	return runCreateWorktreeQuickInput(
		quickInputService,
		environmentService,
		shellService,
		() => quickInputService.input({
			prompt: localize('createWorktreeBranch', 'Branch name'),
			validateInput: value => validateCreateWorktreeBranchName(
				projectId,
				value,
				refs,
				projectManagerService
			),
		})
	);
}

async function runCreateWorktreeQuickInput<T>(
	quickInputService: IQuickInputService,
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeShellService,
	callback: () => Promise<T>
): Promise<T> {
	const windowId = dom.getWindowId(mainWindow);
	const shouldOcclude = environmentService.isOmniWindow;
	if (shouldOcclude) {
		await shellService.focusShell(windowId);
		await shellService.setWorkspaceOverlayOcclusion(windowId, true);
	}

	try {
		const result = callback();
		if (shouldOcclude) {
			mainWindow.requestAnimationFrame(() => quickInputService.focus());
			mainWindow.setTimeout(() => quickInputService.focus(), 0);
		}
		return await result;
	} finally {
		if (shouldOcclude) {
			await shellService.setWorkspaceOverlayOcclusion(windowId, false);
		}
	}
}

function toCreateWorktreeBaseRefPicks(
	refs: readonly WorktreeRefRecord[]
): QuickPickInput<CreateWorktreeRefQuickPick>[] {
	return [
		...toCreateWorktreeRefPicks(refs, 'head'),
		...toCreateWorktreeRefPicks(refs, 'remote'),
		...toCreateWorktreeRefPicks(refs, 'tag'),
	];
}

async function validateCreateWorktreeBranchName(
	projectId: string,
	value: string,
	refs: readonly WorktreeRefRecord[],
	projectManagerService: IProjectManagerService
): Promise<string | undefined> {
	const branchName = value.trim();
	if (!branchName) {
		return localize(
			'createWorktreeBranchValidate',
			'Branch name is required.'
		);
	}
	if (branchName !== value) {
		return localize(
			'createWorktreeBranchWhitespaceValidate',
			'Branch name cannot start or end with whitespace.'
		);
	}
	if (refs.some(ref => ref.type === 'head' && ref.name === branchName)) {
		return localize(
			'createWorktreeBranchExistsValidate',
			'Branch "{0}" already exists.',
			branchName
		);
	}
	if (!(await projectManagerService.isValidBranchName(projectId, branchName))) {
		return localize(
			'createWorktreeBranchInvalidValidate',
			'Branch name is not valid.'
		);
	}

	return undefined;
}

function toCreateWorktreeRefPicks(
	refs: readonly WorktreeRefRecord[],
	type: WorktreeRefRecord['type']
): QuickPickInput<CreateWorktreeRefQuickPick>[] {
	const matchingRefs = refs.filter(ref => ref.type === type);
	if (!matchingRefs.length) {
		return [];
	}

	const label = type === 'head'
		? localize('createWorktreeLocalBranches', 'branches')
		: type === 'remote'
			? localize('createWorktreeRemoteBranches', 'remote branches')
			: localize('createWorktreeTags', 'tags');
	return [
		{ type: 'separator', label },
		...matchingRefs.map(ref => ({
			kind: 'ref' as const,
			ref,
			label: `${getWorktreeRefIcon(ref)} ${ref.name}`,
			description: getWorktreeRefDescription(ref),
			detail: getWorktreeRefDetail(ref),
		})),
	];
}

function getWorktreeRefIcon(ref: WorktreeRefRecord): string {
	switch (ref.type) {
		case 'head':
			return '$(git-branch)';
		case 'remote':
			return '$(cloud)';
		case 'tag':
			return '$(tag)';
	}
}

function getWorktreeRefDescription(
	ref: WorktreeRefRecord
): string | undefined {
	const parts: string[] = [];
	if (ref.checkedOutPath) {
		parts.push(localize('createWorktreeCheckedOut', 'checked out'));
	}
	if (ref.tracking && ref.type === 'head') {
		parts.push(formatWorktreeRefTracking(ref.tracking));
	}
	if (ref.relativeDate) {
		parts.push(ref.relativeDate);
	}
	if (parts.length) {
		return parts.join('$(circle-small-filled)');
	}
	if (ref.commit) {
		if (ref.type === 'remote') {
			return localize(
				'createWorktreeRemoteBranchAt',
				'Remote branch at {0}',
				ref.commit
			);
		}
		if (ref.type === 'tag') {
			return localize('createWorktreeTagAt', 'Tag at {0}', ref.commit);
		}
		return ref.commit;
	}
	return undefined;
}

function formatWorktreeRefTracking(tracking: string): string {
	const ahead = /ahead (\d+)/.exec(tracking)?.[1];
	const behind = /behind (\d+)/.exec(tracking)?.[1];
	if (ahead !== undefined && behind !== undefined) {
		return `${behind}↓ ${ahead}↑`;
	}
	if (ahead !== undefined) {
		return `0↓ ${ahead}↑`;
	}
	if (behind !== undefined) {
		return `${behind}↓ 0↑`;
	}
	return tracking;
}

function getWorktreeRefDetail(ref: WorktreeRefRecord): string | undefined {
	const parts = [
		ref.authorName,
		ref.commit,
		ref.subject,
	].filter((part): part is string => !!part);

	if (parts.length) {
		return parts.join('$(circle-small-filled)');
	}

	return ref.checkedOutPath;
}

async function tryForwardShellCreateWorktreeCommand(
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeShellService,
	handle: string | TreeViewItemHandleArg | undefined
): Promise<boolean> {
	if (!environmentService.isOmniWindow) {
		return false;
	}

	return shellService.runActionInWorkspace(
		dom.getWindowId(mainWindow),
		{
			id: CREATE_WORKTREE_COMMAND_ID,
			from: 'mouse',
			args: handle !== undefined ? [handle] : undefined,
		}
	);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CREATE_WORKTREE_COMMAND_ID,
			title: localize2('createWorktree', 'Create Worktree'),
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
			const forwarded = await tryForwardShellCreateWorktreeCommand(
				environmentService,
				shellService,
				handle
			);
			if (forwarded) {
				return;
			}

			const projectId = parseProjectHandle(getProjectHandle(handle));
			if (!projectId) {
				return;
			}

			const options = await pickCreateWorktreeOptions(
				projectId,
				projectManagerService,
				quickInputService,
				notificationService,
				environmentService,
				shellService
			);
			if (!options) {
				return;
			}

			await projectManagerService.createWorktree(projectId, options);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});
