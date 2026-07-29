/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	ListDragOverEffectPosition,
	ListDragOverEffectType,
} from '../../../../base/browser/ui/list/list.js';
import { getWindowId } from '../../../../base/browser/dom.js';
import { ElementsDragAndDropData, ListViewTargetSector } from
	'../../../../base/browser/ui/list/listView.js';
import { ITreeNode } from '../../../../base/browser/ui/tree/tree.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { ICommandService } from
	'../../../../platform/commands/common/commands.js';
import { IConfigurationService } from
	'../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from
	'../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from
	'../../../../platform/notification/common/notification.js';
import {
	IProjectManagerService,
	ProjectRecord,
} from '../../../../platform/projectManager/common/projectManager.js';
import { IStorageService } from
	'../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from
	'../../../../platform/workspace/common/workspace.js';
import { IHostService } from
	'../../../../workbench/services/host/browser/host.js';
import { IWorkbenchEnvironmentService } from
	'../../../../workbench/services/environment/common/environmentService.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellWindowStateChange,
	IHucodeShellService,
} from '../../../common/omniWindow.js';
import {
	PROJECTS_SECTION_HANDLE,
	ProjectSwitcherItem,
	ProjectSwitcherProjectItem,
	ProjectSwitcherWorkbenchItem,
	ProjectSwitcherWorktreeItem,
} from '../../../common/projectSwitcher/projectSwitcherTreeModel.js';
import {
	ProjectSwitcherAccessibilityProvider,
	ProjectSwitcherDragAndDrop,
	ProjectSwitcherRenderer,
	ProjectSwitcherWidget,
} from
	'../../../browser/projectSwitcher/projectSwitcher.contribution.js';

suite('ProjectSwitcherContribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('recycled rows clear active ARIA and actions before rendering a section', () => {
		const commands: Array<{ id: string; args: readonly unknown[] }> = [];
		const renderer = new ProjectSwitcherRenderer(
			() => 'compact',
			{
				executeCommand: async (id: string, ...args: unknown[]) => {
					commands.push({ id, args });
				},
			} as unknown as ICommandService
		);
		const row = mainWindow.document.createElement('div');
		row.className = 'monaco-list-row';
		const container = mainWindow.document.createElement('div');
		row.appendChild(container);
		const template = renderer.renderTemplate(container);

		renderer.renderElement(treeNode(worktreeItem({
			isActive: true,
			hostedWorkbenchState: 'loaded',
		})), 0, template);
		template.trailingAction.button.click();
		const loaded = {
			active: row.classList.contains('hucode-project-switcher-active-row'),
			ariaCurrent: row.getAttribute('aria-current'),
			trailingLabel: template.trailingAction.button.getAttribute('aria-label'),
			commands: [...commands],
		};

		renderer.renderElement(treeNode({
			id: PROJECTS_SECTION_HANDLE,
			handle: PROJECTS_SECTION_HANDLE,
			kind: 'section',
			sectionKind: 'projects',
			label: 'Projects',
			contextValue: 'hucode-omni-section',
		}), 1, template);

		assert.deepStrictEqual({
			loaded,
			recycled: {
				active: row.classList.contains(
					'hucode-project-switcher-active-row'
				),
				ariaCurrent: row.getAttribute('aria-current'),
				leadingHidden: template.leadingAction.button.hidden,
				trailingLabel: template.trailingAction.button
					.getAttribute('aria-label'),
				actionsClass: template.actions.className,
			},
		}, {
			loaded: {
				active: true,
				ariaCurrent: 'true',
				trailingLabel: 'Unload',
				commands: [{
					id: 'hucode.projectSwitcher.unloadWorktree',
					args: [{
						$treeViewId: 'workbench.hucode.projectSwitcher.view',
						$treeItemHandle:
							'worktree:project-1:%2Frepo%2Ffeature',
					}],
				}],
			},
			recycled: {
				active: false,
				ariaCurrent: null,
				leadingHidden: true,
				trailingLabel: 'Add Project',
				actionsClass:
					'hucode-project-switcher-actions ' +
					'hucode-project-switcher-section-actions',
			},
		});

		renderer.disposeTemplate(template);
	});

	test('renders retained lifecycle states in accessible labels', () => {
		const provider = new ProjectSwitcherAccessibilityProvider();
		const labels = ([
			'loading',
			'active',
			'dormant',
			'crashed',
			'missing',
			'unloaded',
		] as const).map(state => provider.getAriaLabel(
			retainedWorkbenchItem({ hostedWorkbenchState: state })
		));

		assert.deepStrictEqual(labels, [
			'Scratch, /scratch, Loading',
			'Scratch, /scratch, Active',
			'Scratch, /scratch, Dormant',
			'Scratch, /scratch, Crashed',
			'Scratch, /scratch, Folder missing',
			'Scratch, /scratch, Unloaded',
		]);
	});

	test('accepts only valid project and worktree reorder boundaries', () => {
		const dragAndDrop = createDragAndDrop();
		const project = projectItem();
		const otherProject = projectItem({
			id: 'project:unpinned:project-2',
			handle: 'project:unpinned:project-2',
			projectId: 'project-2',
			rootPath: '/repo-2',
		});
		const main = worktreeItem({
			id: 'worktree:project-1:%2Frepo',
			handle: 'worktree:project-1:%2Frepo',
			worktreePath: '/repo',
			isMain: true,
		});
		const feature = worktreeItem();
		const sibling = worktreeItem({
			id: 'worktree:project-1:%2Frepo%2Fsibling',
			handle: 'worktree:project-1:%2Frepo%2Fsibling',
			worktreePath: '/repo/sibling',
			label: 'sibling',
		});

		assert.deepStrictEqual({
			projectBefore: dragAndDrop.onDragOver(
				new ElementsDragAndDropData([project]),
				otherProject,
				4,
				ListViewTargetSector.TOP,
				new DragEvent('dragover')
			),
			projectAfter: dragAndDrop.onDragOver(
				new ElementsDragAndDropData([project]),
				otherProject,
				4,
				ListViewTargetSector.BOTTOM,
				new DragEvent('dragover')
			),
			mainSource: dragAndDrop.onDragOver(
				new ElementsDragAndDropData([main]),
				feature,
				5,
				ListViewTargetSector.TOP,
				new DragEvent('dragover')
			),
			featureAfterMain: dragAndDrop.onDragOver(
				new ElementsDragAndDropData([feature]),
				main,
				5,
				ListViewTargetSector.TOP,
				new DragEvent('dragover')
			),
			featureAfterSibling: dragAndDrop.onDragOver(
				new ElementsDragAndDropData([feature]),
				sibling,
				6,
				ListViewTargetSector.BOTTOM,
				new DragEvent('dragover')
			),
		}, {
			projectBefore: {
				accept: true,
				effect: {
					type: ListDragOverEffectType.Move,
					position: ListDragOverEffectPosition.Before,
				},
				feedback: [4],
			},
			projectAfter: false,
			mainSource: false,
			featureAfterMain: {
				accept: true,
				effect: {
					type: ListDragOverEffectType.Move,
					position: ListDragOverEffectPosition.After,
				},
				feedback: [5],
			},
			featureAfterSibling: {
				accept: true,
				effect: {
					type: ListDragOverEffectType.Move,
					position: ListDragOverEffectPosition.After,
				},
				feedback: [6],
			},
		});
	});

	test('reports reorder failures without leaking a rejected drop', async () => {
		const errors: string[] = [];
		const dragAndDrop = createDragAndDrop({
			moveProject: async () => {
				throw new Error('move failed');
			},
			error: value => errors.push(String(value)),
		});

		await dragAndDrop.drop(
			new ElementsDragAndDropData([projectItem()]),
			undefined,
			undefined,
			ListViewTargetSector.BOTTOM,
			new DragEvent('drop')
		);

		assert.deepStrictEqual(errors, ['Error: move failed']);
	});

	test('prefers keyboard focus over stale tree selection', () => {
		const focused = worktreeItem();
		const selected = retainedWorkbenchItem();
		const host = prototypeHost(ProjectSwitcherWidget.prototype, {
			tree: {
				getFocus: () => [focused],
				getSelection: () => [selected],
			},
			environmentService: { isOmniWindow: true },
		});

		assert.deepStrictEqual(
			ProjectSwitcherWidget.prototype.getSelectionTarget.call(host),
			{ projectId: 'project-1', worktreePath: '/repo/feature' }
		);
	});

	test('does not select an item after an asynchronous reveal is superseded', async () => {
		const selected: ProjectSwitcherItem[][] = [];
		const focused: ProjectSwitcherItem[][] = [];
		const current = worktreeItem({ isActive: true });
		const replacement = worktreeItem({
			id: current.id,
			handle: current.handle,
			isActive: true,
		});
		const initialItems = new Map([[current.id, current]]);
		const replacementItems = new Map([[replacement.id, replacement]]);
		const host = prototypeHost(ProjectSwitcherWidget.prototype, {
			itemsById: initialItems,
			collapsedOmniSections: new Set<string>(),
			environmentService: { isOmniWindow: true },
			omniHostedWorkspaceState: {
				activeInstanceId: 'instance-1',
				projectsSidebarVisible: true,
				projectSwitcherCanGoBack: false,
				projectSwitcherCanGoForward: false,
				instances: [{
					instanceId: 'instance-1',
					worktreePath: current.worktreePath,
				}],
			},
			tree: {
				hasElement: () => true,
				reveal: async () => {
					host.itemsById = replacementItems;
				},
				setSelection: (items: ProjectSwitcherItem[]) =>
					selected.push(items),
				setFocus: (items: ProjectSwitcherItem[]) => focused.push(items),
			},
			viewItemContext: { set: () => undefined },
		}) as {
			itemsById: Map<string, ProjectSwitcherItem>;
		};
		const updateSelection = Reflect.get(
			ProjectSwitcherWidget.prototype,
			'updateCurrentWorktreeSelection'
		) as (this: object) => Promise<void>;

		await updateSelection.call(host);

		assert.deepStrictEqual({ selected, focused }, {
			selected: [],
			focused: [],
		});
	});

	test('keeps history position and reports a failed navigation', async () => {
		const errors: string[] = [];
		const contexts: Array<{ back: boolean; forward: boolean }> = [];
		const host = prototypeHost(ProjectSwitcherWidget.prototype, {
			worktreeNavigationHistory: [
				{ projectId: 'project-1', worktreePath: '/repo/previous' },
				{ projectId: 'project-1', worktreePath: '/repo/current' },
			],
			worktreeNavigationIndex: 1,
			projects: [projectRecord()],
			isNavigatingWorktreeHistory: false,
			projectManagerService: {
				getProjects: async () => [projectRecord()],
				setLastActiveWorktree: async () => undefined,
			},
			environmentService: {
				isOmniWindow: false,
				isHostedOmniWorkspace: false,
			},
			shellService: {},
			hostService: {
				openWindow: async () => {
					throw new Error('open failed');
				},
			},
			notificationService: {
				error: (value: unknown) => errors.push(String(value)),
			},
			canGoBackContext: {
				set: (back: boolean) => {
					contexts.push({ back, forward: false });
				},
			},
			canGoForwardContext: {
				set: (forward: boolean) => {
					contexts[contexts.length - 1].forward = forward;
				},
			},
		});
		const navigate = Reflect.get(
			ProjectSwitcherWidget.prototype,
			'navigateWorktreeHistory'
		) as (this: object, delta: -1 | 1) => Promise<void>;

		await navigate.call(host, -1);

		assert.deepStrictEqual({
			index: Reflect.get(host, 'worktreeNavigationIndex'),
			navigating: Reflect.get(host, 'isNavigatingWorktreeHistory'),
			errors,
			contexts,
		}, {
			index: 1,
			navigating: false,
			errors: ['Error: open failed'],
			contexts: [{ back: true, forward: false }],
		});
	});

	test('ignores hosted state notifications for another window', () => {
		let fireState:
			| ((change: { windowId: number; state: IHucodeHostedWorkspaceState }) => void)
			| undefined;
		const initialState = hostedState('initial');
		const widget = disposables.add(new ProjectSwitcherWidget(
			{
				createInstance: () => {
					throw new Error('not rendered');
				},
			} as never,
			{} as never,
			{
				createKey: () => ({ set: () => undefined }),
			} as unknown as IContextKeyService,
			{
				onDidChangeProjects: Event.None,
			} as unknown as IProjectManagerService,
			{
				onDidChangeWorkspaceFolders: Event.None,
				onDidChangeWorkbenchState: Event.None,
				getWorkbenchState: () => WorkbenchState.EMPTY,
			} as unknown as IWorkspaceContextService,
			{} as unknown as INotificationService,
			{} as unknown as ICommandService,
			{
				get: () => undefined,
				store: () => undefined,
			} as unknown as IStorageService,
			{ isOmniWindow: true } as IWorkbenchEnvironmentService,
			{
				onDidChangeWindowState: (
					listener: (change: IHucodeShellWindowStateChange) => void
				) => {
					fireState = listener;
					return { dispose: () => undefined };
				},
				setProjectSwitcherNavigationState: async () => undefined,
			} as unknown as IHucodeShellService,
			{ onDidChangeFocus: Event.None } as unknown as IHostService,
			{} as never,
			{
				onDidChangeConfiguration: Event.None,
				getValue: () => undefined,
			} as unknown as IConfigurationService,
		));
		Reflect.set(widget, 'omniHostedWorkspaceState', initialState);

		fireState?.({
			windowId: mainWindow.vscodeWindowId + 1,
			state: hostedState('other'),
		});
		const afterOtherWindow = (Reflect.get(
			widget,
			'omniHostedWorkspaceState'
		) as IHucodeHostedWorkspaceState).activeInstanceId;
		fireState?.({
			windowId: getWindowId(mainWindow),
			state: hostedState('same'),
		});

		assert.deepStrictEqual({
			afterOtherWindow,
			afterSameWindow: (Reflect.get(
				widget,
				'omniHostedWorkspaceState'
			) as IHucodeHostedWorkspaceState).activeInstanceId,
		}, {
			afterOtherWindow: 'initial',
			afterSameWindow: 'same',
		});
	});
});

function treeNode(item: ProjectSwitcherItem): ITreeNode<ProjectSwitcherItem, void> {
	return { element: item } as ITreeNode<ProjectSwitcherItem, void>;
}

function projectItem(
	overrides: Partial<ProjectSwitcherProjectItem> = {}
): ProjectSwitcherProjectItem {
	return {
		id: 'project:unpinned:project-1',
		handle: 'project:unpinned:project-1',
		kind: 'project',
		label: 'repo',
		contextValue: 'hucode-project',
		projectId: 'project-1',
		pinned: false,
		section: 'unpinned',
		rootPath: '/repo',
		hasCustomLabel: false,
		...overrides,
	};
}

function worktreeItem(
	overrides: Partial<ProjectSwitcherWorktreeItem> = {}
): ProjectSwitcherWorktreeItem {
	return {
		id: 'worktree:project-1:%2Frepo%2Ffeature',
		handle: 'worktree:project-1:%2Frepo%2Ffeature',
		kind: 'worktree',
		label: 'feature',
		description: '/repo/feature',
		contextValue: 'hucode-worktree',
		projectId: 'project-1',
		worktreePath: '/repo/feature',
		isMain: false,
		pinned: false,
		section: 'unpinned',
		isActive: false,
		hasCustomLabel: false,
		missingGitWorktree: false,
		...overrides,
	};
}

function retainedWorkbenchItem(
	overrides: Partial<ProjectSwitcherWorkbenchItem> = {}
): ProjectSwitcherWorkbenchItem {
	return {
		id: 'workbench:scratch',
		handle: 'workbench:scratch',
		kind: 'workbench',
		label: 'Scratch',
		description: '/scratch',
		contextValue: 'hucode-retained-workbench',
		retainedWorkbenchId: 'scratch',
		worktreePath: '/scratch',
		desiredState: 'unloaded',
		hostedWorkbenchState: 'unloaded',
		isActive: false,
		order: 0,
		hasCustomLabel: false,
		...overrides,
	};
}

function createDragAndDrop(options: {
	readonly moveProject?: () => Promise<void>;
	readonly error?: (value: unknown) => void;
} = {}): ProjectSwitcherDragAndDrop {
	return new ProjectSwitcherDragAndDrop(
		() => undefined,
		(_target, targetIndex) => targetIndex,
		{
			moveProject: options.moveProject ?? (async () => undefined),
			moveWorktree: async () => undefined,
			getProjects: async () => [projectRecord()],
		} as unknown as IProjectManagerService,
		{
			error: options.error ?? (() => undefined),
		} as unknown as INotificationService,
		{
			getWindowState: async () => hostedState(),
			reorderRetainedWorkbenches: async () => undefined,
		} as unknown as IHucodeShellService
	);
}

function projectRecord(): ProjectRecord {
	return {
		id: 'project-1',
		label: 'repo',
		rootUri: URI.file('/repo'),
		pinned: false,
		order: 0,
		worktreeState: 'current',
		worktrees: [{
			path: '/repo/previous',
			label: 'previous',
			isMain: false,
			isDetached: false,
		}, {
			path: '/repo/current',
			label: 'current',
			isMain: true,
			isDetached: false,
		}],
	};
}

function hostedState(activeInstanceId?: string): IHucodeHostedWorkspaceState {
	return {
		activeInstanceId,
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: [],
	};
}

function prototypeHost<T extends object>(
	prototype: object,
	fields: T
): T {
	return Object.assign(Object.create(prototype) as object, fields) as T;
}
