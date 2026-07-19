/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { Codicon } from '../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { basename } from '../../../base/common/path.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from
	'../../../platform/actions/common/actions.js';
import { HucodeMenuId } from
	'../../../platform/actions/common/hucodeMenuIds.js';
import { ContextKeyExpr } from
	'../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from
	'../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from
	'../../../platform/keybinding/common/keybinding.js';
import { KeybindingsRegistry, KeybindingWeight } from
	'../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILabelService } from
	'../../../platform/label/common/label.js';
import { INotificationService } from
	'../../../platform/notification/common/notification.js';
import {
	IProjectManagerService,
	ProjectRecord,
	WorktreeRecord,
} from '../../../platform/projectManager/common/projectManager.js';
import { IQuickInputService, IQuickNavigateConfiguration } from
	'../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, WorkbenchState } from
	'../../../platform/workspace/common/workspace.js';
import { getQuickNavigateHandler, inQuickPickContext } from
	'../../../workbench/browser/quickaccess.js';
import { IHostService } from
	'../../../workbench/services/host/browser/host.js';
import { IWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/common/environmentService.js';
import {
	IsHostedOmniWorkspaceContext,
	IsOmniWindowContext,
} from '../../../workbench/common/contextkeys.js';
import {
	combineProjectSwitcherTargets,
	compareSwitchWorktreePicks,
	filterSwitchWorktreePicks,
	getAdjacentProjectWorktreeTarget,
	getDefaultSwitchWorktreeActivePick,
	getLastActiveSwitchWorkbenchPick,
	getLoadedProjectWorktreeTargets,
	getLoadedSwitchWorktreePicks,
	getVisualProjectWorktreeTargets,
	IProjectSwitcherSelectionTarget,
	SwitchWorktreeQuickPick,
	SwitchWorktreeSearchField,
	withSwitchWorktreeSeparators,
} from '../../common/projectSwitcher/switchProjectWorktreeModel.js';
import {
	DEFAULT_PROJECT_SWITCHER_OMNI_SECTION_ORDER,
	ProjectSwitcherOmniSection,
} from '../../common/projectSwitcher/projectSwitcherViewState.js';
import { getRetainedWorkbenchPresentation } from
	'../../common/projectSwitcher/projectSwitcherTreeModel.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../../common/omniWindow.js';
import { isHostedWorkspaceAvailable } from
	'../../common/hostedWorkspaceState.js';
import { Menus } from '../menus.js';
import {
	ProjectsSidebarHiddenContext,
	ProjectsTitleBarControlsEnabledContext,
} from
	'../omniProjectsSidebarActions.js';
import {
	getWorktreeDisplayLabel,
	pathsEqual,
	QUICK_SWITCH_LOADED_WORKTREE_COMMAND_ID,
	QUICK_SWITCH_LOADED_WORKTREE_CONTEXT_KEY,
	QUICK_SWITCH_LOADED_WORKTREE_NAVIGATE_NEXT_COMMAND_ID,
	QUICK_SWITCH_LOADED_WORKTREE_NAVIGATE_PREVIOUS_COMMAND_ID,
	SWITCH_LAST_ACTIVE_WORKTREE_COMMAND_ID,
	SWITCH_NEXT_LOADED_WORKTREE_COMMAND_ID,
	SWITCH_NEXT_WORKTREE_COMMAND_ID,
	SWITCH_PREVIOUS_LOADED_WORKTREE_COMMAND_ID,
	SWITCH_PREVIOUS_WORKTREE_COMMAND_ID,
	SWITCH_WORKTREE_COMMAND_ID,
} from './projectSwitcherCommon.js';
import {
	openProjectSwitcherTargetInWindow,
} from './openProjectSwitcherTarget.js';

export type { IProjectSwitcherSelectionTarget } from
	'../../common/projectSwitcher/switchProjectWorktreeModel.js';
export { setLastActiveWorktreeBestEffort } from './openProjectSwitcherTarget.js';

interface ILoadedWorkbenchWorktree {
	readonly path: string;
	readonly lastActiveAt?: number;
}

function getProjectPickLabel(project: ProjectRecord): string {
	const projectBasename = basename(URI.revive(project.rootUri).fsPath);
	const projectLabel = project.label === projectBasename
		? project.label
		: `${project.label} (${projectBasename})`;

	return projectLabel;
}

function getWorktreePickIconClass(worktree: WorktreeRecord): string {
	return ThemeIcon.asClassName(
		worktree.isMain ? Codicon.repo : Codicon.gitBranch
	);
}

function getWorktreePickDescription(
	worktree: WorktreeRecord,
	worktreeLabel: string
): string {
	const worktreeBasename = basename(worktree.path);
	return worktree.isMain ||
		worktreeLabel === worktreeBasename
		? worktreeLabel
		: `${worktreeLabel} (${worktreeBasename})`;
}

function getWorktreeBranchLabel(worktree: WorktreeRecord): string {
	return worktree.branch ??
		(worktree.isDetached
			? localize('detachedWorktree', 'Detached')
			: localize('unknownWorktreeBranch', 'Unknown branch'));
}

function getWorktreePickDetail(
	worktree: WorktreeRecord,
	labelService: ILabelService
): string {
	const branchLabel = getWorktreeBranchLabel(worktree);
	const pathLabel = labelService.getUriLabel(URI.file(worktree.path));

	return `${branchLabel} - ${pathLabel}`;
}

function getSwitchWorktreeSearchFields(
	projectLabel: string,
	worktreeDescription: string,
	branchLabel: string
): readonly SwitchWorktreeSearchField[] {
	return [
		{ target: 'label', text: projectLabel },
		{ target: 'description', text: worktreeDescription },
		{ target: 'detail', text: branchLabel },
	];
}

function getSwitchWorktreePicks(
	projects: readonly ProjectRecord[],
	activeWorktreePath: string | undefined,
	loadedWorktrees: readonly ILoadedWorkbenchWorktree[],
	labelService: ILabelService
): SwitchWorktreeQuickPick[] {
	const picks: SwitchWorktreeQuickPick[] = [];
	for (const project of projects) {
		for (const [worktreeOrder, worktree] of project.worktrees.entries()) {
			const worktreeLabel = getWorktreeDisplayLabel(worktree);
			const branchLabel = getWorktreeBranchLabel(worktree);
			const projectLabel = getProjectPickLabel(project);
			const isCurrent = activeWorktreePath !== undefined &&
				pathsEqual(activeWorktreePath, worktree.path);
			const worktreeDescription = getWorktreePickDescription(
				worktree,
				worktreeLabel
			);
			const loadedWorktree = loadedWorktrees.find(entry =>
				pathsEqual(entry.path, worktree.path)
			);
			picks.push({
				projectId: project.id,
				worktreePath: worktree.path,
				isCurrent,
				isLoaded: isCurrent || !!loadedWorktree,
				lastVisitedAt: loadedWorktree?.lastActiveAt ??
					worktree.lastVisitedAt,
				projectOrder: project.order,
				worktreeOrder,
				label: projectLabel,
				iconClass: getWorktreePickIconClass(worktree),
				description: worktreeDescription,
				detail: getWorktreePickDetail(worktree, labelService),
				tooltip: worktree.path,
				searchFields: getSwitchWorktreeSearchFields(
					projectLabel,
					worktreeDescription,
					branchLabel
				),
			});
		}
	}

	return picks.sort(compareSwitchWorktreePicks);
}

function getRetainedWorkbenchPicks(
	state: IHucodeHostedWorkspaceState | undefined,
	activeWorktreePath: string | undefined,
	labelService: ILabelService
): SwitchWorktreeQuickPick[] {
	if (!state) {
		return [];
	}
	return (state.retainedWorkbenches ?? [])
		.toSorted((a, b) => a.order - b.order)
		.map(record => {
			const presentation = getRetainedWorkbenchPresentation(
				record,
				path => labelService.getUriLabel(URI.file(path))
			);
			const path = presentation.path;
			const instance = state.instances.find(candidate =>
				pathsEqual(candidate.worktreePath, path)
			);
			const isLoaded = !!instance && isHostedWorkspaceAvailable(instance);
			const lifecycleState = instance?.state ??
				(record.folderStatus === 'missing'
					? 'missing'
					: record.desiredState === 'loaded' ? 'dormant' : 'unloaded');
			const isDormant = lifecycleState === 'dormant';
			const label = presentation.label;
			const description = presentation.pathLabel;
			return {
				worktreePath: path,
				isCurrent: activeWorktreePath !== undefined &&
					pathsEqual(activeWorktreePath, path),
				isLoaded,
				isDormant,
				lastVisitedAt: instance?.lastActiveAt ?? record.lastActiveAt,
				projectOrder: -1,
				worktreeOrder: record.order,
				label,
				iconClass: ThemeIcon.asClassName(
					lifecycleState === 'restore-pending' ||
						lifecycleState === 'loading'
						? ThemeIcon.modify(Codicon.loading, 'spin')
						: isDormant ? Codicon.debugPause
							: lifecycleState === 'unloaded'
								? Codicon.circleOutline
								: lifecycleState === 'missing' ||
									lifecycleState === 'crashed'
									? Codicon.warning
									: Codicon.window
				),
				description,
				tooltip: path,
				searchFields: [
					{ target: 'label' as const, text: label },
					{ target: 'description' as const, text: description },
					{ target: 'detail' as const, text: path },
				],
			};
		});
}

async function getOmniHostedWorkspaceState(
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeShellService,
	projects: readonly ProjectRecord[]
): Promise<IHucodeHostedWorkspaceState | undefined> {
	if (!environmentService.isOmniWindow &&
		!environmentService.isHostedOmniWorkspace
	) {
		return undefined;
	}
	const windowId = dom.getWindowId(mainWindow);
	await shellService.reconcileRetainedWorkbenches(
		windowId,
		projects.flatMap(project => project.worktrees.map(worktree => ({
			projectId: project.id,
			folderUri: URI.file(worktree.path).toJSON(),
		})))
	);
	return shellService.getWindowState(windowId);
}

function getCombinedSwitchWorkbenchPicks(
	projects: readonly ProjectRecord[],
	state: IHucodeHostedWorkspaceState | undefined,
	activeWorktreePath: string | undefined,
	loadedWorktrees: readonly ILoadedWorkbenchWorktree[],
	labelService: ILabelService,
	sectionOrder: readonly ProjectSwitcherOmniSection[] =
		DEFAULT_PROJECT_SWITCHER_OMNI_SECTION_ORDER
): SwitchWorktreeQuickPick[] {
	const projectPicks = getSwitchWorktreePicks(
		projects,
		activeWorktreePath,
		loadedWorktrees,
		labelService
	).map(pick => {
		const instance = state?.instances.find(candidate =>
			pathsEqual(candidate.worktreePath, pick.worktreePath)
		);
		const icon = !state
			? undefined
			: instance?.state === 'restore-pending' ||
				instance?.state === 'loading'
				? ThemeIcon.modify(Codicon.loading, 'spin')
				: instance?.state === 'dormant'
					? Codicon.debugPause
					: instance?.state === 'crashed' ||
						instance?.state === 'missing'
						? Codicon.warning
						: instance?.state === 'unloaded' || !instance
							? Codicon.circleOutline
							: undefined;
		return {
			...pick,
			...(instance?.state === 'dormant' ? { isDormant: true } : {}),
			lastVisitedAt: instance?.lastActiveAt ?? pick.lastVisitedAt,
			...(icon ? { iconClass: ThemeIcon.asClassName(icon) } : {}),
		};
	});
	return combineProjectSwitcherTargets(
		getRetainedWorkbenchPicks(state, activeWorktreePath, labelService),
		projectPicks,
		pathsEqual,
		sectionOrder
	).sort((a, b) => compareSwitchWorktreePicks(
		a,
		b,
		state ? sectionOrder : undefined
	));
}

async function getActiveWorkbenchWorktreePath(
	environmentService: IWorkbenchEnvironmentService,
	workspaceContextService: IWorkspaceContextService,
	shellService: IHucodeShellService
): Promise<string | undefined> {
	if (environmentService.isOmniWindow) {
		const state = await shellService.getWindowState(
			dom.getWindowId(mainWindow)
		);
		return state.instances.find(instance =>
			instance.instanceId === state.activeInstanceId
		)?.worktreePath;
	}

	if (workspaceContextService.getWorkbenchState() !== WorkbenchState.FOLDER) {
		return undefined;
	}

	const folderUri = workspaceContextService.getWorkspace().folders[0]?.uri;
	return folderUri?.scheme === 'file' ? folderUri.fsPath : undefined;
}

async function getLoadedWorkbenchWorktreePaths(
	environmentService: IWorkbenchEnvironmentService,
	workspaceContextService: IWorkspaceContextService,
	shellService: IHucodeShellService
): Promise<readonly string[]> {
	return (await getLoadedWorkbenchWorktrees(
		environmentService,
		workspaceContextService,
		shellService
	)).map(worktree => worktree.path);
}

async function getLoadedWorkbenchWorktrees(
	environmentService: IWorkbenchEnvironmentService,
	workspaceContextService: IWorkspaceContextService,
	shellService: IHucodeShellService
): Promise<readonly ILoadedWorkbenchWorktree[]> {
	if (
		environmentService.isOmniWindow ||
		environmentService.isHostedOmniWorkspace
	) {
		const state = await shellService.getWindowState(
			dom.getWindowId(mainWindow)
		);
		return state.instances
			.filter(isHostedWorkspaceAvailable)
			.map(instance => ({
				path: instance.worktreePath,
				lastActiveAt: instance.lastActiveAt,
			}));
	}

	if (workspaceContextService.getWorkbenchState() !== WorkbenchState.FOLDER) {
		return [];
	}

	const folderUri = workspaceContextService.getWorkspace().folders[0]?.uri;
	return folderUri?.scheme === 'file' ? [{ path: folderUri.fsPath }] : [];
}

export async function openProjectSwitcherTarget(
	target: IProjectSwitcherSelectionTarget,
	projectManagerService: IProjectManagerService,
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeShellService,
	hostService: IHostService
): Promise<void> {
	await openProjectSwitcherTargetInWindow(
		target,
		dom.getWindowId(mainWindow),
		projectManagerService,
		environmentService,
		shellService,
		hostService
	);
}

function pickSwitchWorktree(
	quickInputService: IQuickInputService,
	picks: readonly SwitchWorktreeQuickPick[],
	options: {
		readonly contextKey?: string;
		readonly hideInput?: boolean;
		readonly quickNavigate?: IQuickNavigateConfiguration;
	} = {}
): Promise<SwitchWorktreeQuickPick | undefined> {
	const disposables = new DisposableStore();
	const quickPick =
		disposables.add(quickInputService.createQuickPick<SwitchWorktreeQuickPick>({
			useSeparators: true,
		}));
	quickPick.placeholder = localize(
		'switchWorktreePlaceholder',
		'Select a workbench'
	);
	quickPick.matchOnLabel = false;
	quickPick.matchOnDescription = false;
	quickPick.matchOnDetail = false;
	quickPick.sortByLabel = false;
	quickPick.contextKey = options.contextKey;
	quickPick.hideInput = options.hideInput ?? false;
	quickPick.quickNavigate = options.quickNavigate;
	const setItems = (query: string): void => {
		const filteredPicks = filterSwitchWorktreePicks(picks, query);
		quickPick.items = withSwitchWorktreeSeparators(filteredPicks);
		const activePick = query.trim()
			? filteredPicks[0]
			: getDefaultSwitchWorktreeActivePick(filteredPicks);
		quickPick.activeItems = activePick ? [activePick] : [];
	};
	setItems('');

	return new Promise(resolve => {
		let didResolve = false;
		let acceptedPick: SwitchWorktreeQuickPick | undefined;
		const finish = (pick: SwitchWorktreeQuickPick | undefined): void => {
			if (didResolve) {
				return;
			}
			didResolve = true;
			disposables.dispose();
			resolve(pick);
		};
		disposables.add(quickPick.onDidAccept(() => {
			acceptedPick = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
			quickPick.hide();
		}));
		disposables.add(quickPick.onDidHide(() => finish(acceptedPick)));
		disposables.add(quickPick.onDidChangeValue(value => setItems(value)));

		quickPick.show();
		if (!options.hideInput) {
			quickPick.focusOnInput();
			mainWindow.requestAnimationFrame(() => quickPick.focusOnInput());
			mainWindow.setTimeout(() => quickPick.focusOnInput(), 0);
		}
	});
}

async function tryForwardShellSwitchCommand(
	commandId: string,
	environmentService: IWorkbenchEnvironmentService,
	shellService: IHucodeShellService
): Promise<boolean> {
	if (!environmentService.isOmniWindow) {
		return false;
	}

	return shellService.runActionInWorkspace(
		dom.getWindowId(mainWindow),
		{ id: commandId, from: 'keybinding' }
	);
}

async function switchAdjacentProjectWorktree(
	accessor: ServicesAccessor,
	direction: -1 | 1,
	commandId: string,
	loadedOnly = false
): Promise<void> {
	const projectManagerService = accessor.get(IProjectManagerService);
	const notificationService = accessor.get(INotificationService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const shellService = accessor.get(IHucodeShellService);
	const hostService = accessor.get(IHostService);

	try {
		const forwarded = await tryForwardShellSwitchCommand(
			commandId,
			environmentService,
			shellService
		);
		if (forwarded) {
			return;
		}

		const projects = await projectManagerService.getProjects();
		const omniState = await getOmniHostedWorkspaceState(
			environmentService,
			shellService,
			projects
		);
		const visualTargets = combineProjectSwitcherTargets(
			(omniState?.retainedWorkbenches ?? [])
				.toSorted((a, b) => a.order - b.order)
				.map(record => ({
					worktreePath: URI.revive(record.folderUri).fsPath,
				})),
			getVisualProjectWorktreeTargets(projects),
			pathsEqual,
			omniState?.projectSwitcherSectionOrder
		);
		const targets = loadedOnly
			? getLoadedProjectWorktreeTargets(
				visualTargets,
				await getLoadedWorkbenchWorktreePaths(
					environmentService,
					workspaceContextService,
					shellService
				),
				pathsEqual
			)
			: visualTargets;
		const activeWorktreePath = await getActiveWorkbenchWorktreePath(
			environmentService,
			workspaceContextService,
			shellService
		);
		const target = getAdjacentProjectWorktreeTarget(
			targets,
			activeWorktreePath,
			direction,
			pathsEqual
		);
		if (
			!target ||
			(activeWorktreePath !== undefined &&
				pathsEqual(target.worktreePath, activeWorktreePath))
		) {
			return;
		}

		await openProjectSwitcherTarget(
			target,
			projectManagerService,
			environmentService,
			shellService,
			hostService
		);
	} catch (error) {
		notificationService.error(String(error));
	}
}

async function switchLastActiveProjectWorktree(
	accessor: ServicesAccessor
): Promise<void> {
	const projectManagerService = accessor.get(IProjectManagerService);
	const labelService = accessor.get(ILabelService);
	const notificationService = accessor.get(INotificationService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const shellService = accessor.get(IHucodeShellService);
	const hostService = accessor.get(IHostService);

	try {
		const forwarded = await tryForwardShellSwitchCommand(
			SWITCH_LAST_ACTIVE_WORKTREE_COMMAND_ID,
			environmentService,
			shellService
		);
		if (forwarded) {
			return;
		}

		const projects = await projectManagerService.getProjects();
		const activeWorktreePath = await getActiveWorkbenchWorktreePath(
			environmentService,
			workspaceContextService,
			shellService
		);
		const loadedWorktrees = await getLoadedWorkbenchWorktrees(
			environmentService,
			workspaceContextService,
			shellService
		);
		const omniState = await getOmniHostedWorkspaceState(
			environmentService,
			shellService,
			projects
		);
		const picks = getCombinedSwitchWorkbenchPicks(
			projects,
			omniState,
			activeWorktreePath,
			loadedWorktrees,
			labelService,
			omniState?.projectSwitcherSectionOrder
		);
		const pick = getLastActiveSwitchWorkbenchPick(picks);
		if (
			!pick ||
			(activeWorktreePath !== undefined &&
				pathsEqual(pick.worktreePath, activeWorktreePath))
		) {
			return;
		}

		await openProjectSwitcherTarget(
			pick,
			projectManagerService,
			environmentService,
			shellService,
			hostService
		);
	} catch (error) {
		notificationService.error(String(error));
	}
}

async function quickSwitchLoadedProjectWorktree(
	accessor: ServicesAccessor
): Promise<void> {
	const projectManagerService = accessor.get(IProjectManagerService);
	const quickInputService = accessor.get(IQuickInputService);
	const keybindingService = accessor.get(IKeybindingService);
	const labelService = accessor.get(ILabelService);
	const notificationService = accessor.get(INotificationService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const shellService = accessor.get(IHucodeShellService);
	const hostService = accessor.get(IHostService);

	try {
		if (environmentService.isOmniWindow) {
			const windowId = dom.getWindowId(mainWindow);
			const forwarded = await tryForwardShellSwitchCommand(
				QUICK_SWITCH_LOADED_WORKTREE_COMMAND_ID,
				environmentService,
				shellService
			);
			if (forwarded) {
				return;
			}

			await shellService.focusShell(windowId);
		}

		const projects = await projectManagerService.getProjects();
		const activeWorktreePath = await getActiveWorkbenchWorktreePath(
			environmentService,
			workspaceContextService,
			shellService
		);
		const loadedWorktrees = await getLoadedWorkbenchWorktrees(
			environmentService,
			workspaceContextService,
			shellService
		);
		const omniState = await getOmniHostedWorkspaceState(
			environmentService,
			shellService,
			projects
		);
		const picks = getLoadedSwitchWorktreePicks(getCombinedSwitchWorkbenchPicks(
			projects,
			omniState,
			activeWorktreePath,
			loadedWorktrees,
			labelService,
			omniState?.projectSwitcherSectionOrder
		));
		if (!picks.some(pick => !pick.isCurrent)) {
			return;
		}

		const pick = await pickSwitchWorktree(
			quickInputService,
			picks,
			{
				contextKey: QUICK_SWITCH_LOADED_WORKTREE_CONTEXT_KEY,
				hideInput: true,
				quickNavigate: {
					keybindings: keybindingService.lookupKeybindings(
						QUICK_SWITCH_LOADED_WORKTREE_COMMAND_ID
					),
				},
			}
		);
		if (
			!pick ||
			(activeWorktreePath !== undefined &&
				pathsEqual(pick.worktreePath, activeWorktreePath))
		) {
			return;
		}

		await openProjectSwitcherTarget(
			pick,
			projectManagerService,
			environmentService,
			shellService,
			hostService
		);
	} catch (error) {
		notificationService.error(String(error));
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SWITCH_WORKTREE_COMMAND_ID,
			title: localize2(
				'switchProjectWorktree',
				'Switch Workbench...'
			),
			icon: Codicon.search,
			menu: [
				{
					id: Menus.SidebarTitle,
					group: 'navigation',
					when: IsOmniWindowContext,
					order: 5,
				},
				{
					id: HucodeMenuId.TitleBarLeft,
					group: 'navigation',
					when: ContextKeyExpr.and(
						IsHostedOmniWorkspaceContext,
						ProjectsSidebarHiddenContext,
						ProjectsTitleBarControlsEnabledContext
					),
					order: 3,
				},
			],
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: 0,
				mac: {
					primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyP,
				},
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const quickInputService = accessor.get(IQuickInputService);
		const labelService = accessor.get(ILabelService);
		const notificationService = accessor.get(INotificationService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const shellService = accessor.get(IHucodeShellService);
		const hostService = accessor.get(IHostService);

		try {
			if (environmentService.isOmniWindow) {
				const windowId = dom.getWindowId(mainWindow);
				const forwarded = await tryForwardShellSwitchCommand(
					SWITCH_WORKTREE_COMMAND_ID,
					environmentService,
					shellService
				);
				if (forwarded) {
					return;
				}

				await shellService.focusShell(windowId);
			}

			const projects = await projectManagerService.getProjects();
			const activeWorktreePath = await getActiveWorkbenchWorktreePath(
				environmentService,
				workspaceContextService,
				shellService
			);
			const loadedWorktrees = await getLoadedWorkbenchWorktrees(
				environmentService,
				workspaceContextService,
				shellService
			);
			const omniState = await getOmniHostedWorkspaceState(
				environmentService,
				shellService,
				projects
			);
			const picks = getCombinedSwitchWorkbenchPicks(
				projects,
				omniState,
				activeWorktreePath,
				loadedWorktrees,
				labelService,
				omniState?.projectSwitcherSectionOrder
			);
			if (!picks.length) {
				notificationService.info(localize(
					'switchWorktreeNoProjects',
					'No workbenches are available.'
				));
				return;
			}

			const pick = await pickSwitchWorktree(
				quickInputService,
				picks
			);
			if (!pick) {
				return;
			}

			await openProjectSwitcherTarget(
				pick,
				projectManagerService,
				environmentService,
				shellService,
				hostService
			);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: QUICK_SWITCH_LOADED_WORKTREE_COMMAND_ID,
			title: localize2(
				'quickSwitchLoadedProjectWorktree',
				'Quick Switch Loaded Workbench'
			),
			icon: Codicon.history,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: 0,
				mac: {
					primary: KeyMod.CtrlCmd |
						KeyMod.WinCtrl |
						KeyCode.Tab,
				},
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await quickSwitchLoadedProjectWorktree(accessor);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SWITCH_LAST_ACTIVE_WORKTREE_COMMAND_ID,
			title: localize2(
				'switchLastActiveProjectWorktree',
				'Switch to Last Active Workbench'
			),
			icon: Codicon.history,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: 0,
				mac: {
					primary: KeyMod.CtrlCmd |
						KeyMod.WinCtrl |
						KeyMod.Alt |
						KeyCode.KeyP,
				},
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await switchLastActiveProjectWorktree(accessor);
	}
});

const quickSwitchLoadedWorktreeContext = ContextKeyExpr.and(
	inQuickPickContext,
	ContextKeyExpr.has(QUICK_SWITCH_LOADED_WORKTREE_CONTEXT_KEY)
);

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: QUICK_SWITCH_LOADED_WORKTREE_NAVIGATE_NEXT_COMMAND_ID,
	weight: KeybindingWeight.WorkbenchContrib + 50,
	handler: getQuickNavigateHandler(
		QUICK_SWITCH_LOADED_WORKTREE_NAVIGATE_NEXT_COMMAND_ID,
		true
	),
	when: quickSwitchLoadedWorktreeContext,
	primary: 0,
	mac: {
		primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.Tab,
	},
});

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: QUICK_SWITCH_LOADED_WORKTREE_NAVIGATE_PREVIOUS_COMMAND_ID,
	weight: KeybindingWeight.WorkbenchContrib + 50,
	handler: getQuickNavigateHandler(
		QUICK_SWITCH_LOADED_WORKTREE_NAVIGATE_PREVIOUS_COMMAND_ID,
		false
	),
	when: quickSwitchLoadedWorktreeContext,
	primary: 0,
	mac: {
		primary: KeyMod.CtrlCmd |
			KeyMod.WinCtrl |
			KeyMod.Shift |
			KeyCode.Tab,
	},
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SWITCH_PREVIOUS_WORKTREE_COMMAND_ID,
			title: localize2(
				'switchPreviousProjectWorktree',
				'Switch to Previous Workbench'
			),
			icon: Codicon.arrowUp,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: 0,
				mac: {
					primary: KeyMod.CtrlCmd |
						KeyMod.WinCtrl |
						KeyMod.Alt |
						KeyCode.BracketLeft,
				},
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await switchAdjacentProjectWorktree(
			accessor,
			-1,
			SWITCH_PREVIOUS_WORKTREE_COMMAND_ID
		);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SWITCH_PREVIOUS_LOADED_WORKTREE_COMMAND_ID,
			title: localize2(
				'switchPreviousLoadedProjectWorktree',
				'Switch to Previous Loaded Workbench'
			),
			icon: Codicon.arrowUp,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: 0,
				mac: {
					primary: KeyMod.CtrlCmd |
						KeyMod.WinCtrl |
						KeyCode.BracketLeft,
				},
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await switchAdjacentProjectWorktree(
			accessor,
			-1,
			SWITCH_PREVIOUS_LOADED_WORKTREE_COMMAND_ID,
			true
		);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SWITCH_NEXT_WORKTREE_COMMAND_ID,
			title: localize2(
				'switchNextProjectWorktree',
				'Switch to Next Workbench'
			),
			icon: Codicon.arrowDown,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: 0,
				mac: {
					primary: KeyMod.CtrlCmd |
						KeyMod.WinCtrl |
						KeyMod.Alt |
						KeyCode.BracketRight,
				},
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await switchAdjacentProjectWorktree(
			accessor,
			1,
			SWITCH_NEXT_WORKTREE_COMMAND_ID
		);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SWITCH_NEXT_LOADED_WORKTREE_COMMAND_ID,
			title: localize2(
				'switchNextLoadedProjectWorktree',
				'Switch to Next Loaded Workbench'
			),
			icon: Codicon.arrowDown,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: 0,
				mac: {
					primary: KeyMod.CtrlCmd |
						KeyMod.WinCtrl |
						KeyCode.BracketRight,
				},
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await switchAdjacentProjectWorktree(
			accessor,
			1,
			SWITCH_NEXT_LOADED_WORKTREE_COMMAND_ID,
			true
		);
	}
});
