/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/projectSwitcher.css';
import * as dom from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IAction, Separator, toAction } from
	'../../../base/common/actions.js';
import {
	IListVirtualDelegate,
	ListDragOverEffectPosition,
	ListDragOverEffectType,
} from '../../../base/browser/ui/list/list.js';
import {
	ElementsDragAndDropData,
	ListViewTargetSector,
} from '../../../base/browser/ui/list/listView.js';
import { IListAccessibilityProvider } from
	'../../../base/browser/ui/list/listWidget.js';
import {
	IObjectTreeElement,
	ITreeContextMenuEvent,
	ITreeDragAndDrop,
	ITreeDragOverReaction,
	ITreeNode,
	ITreeRenderer,
} from '../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../base/common/codicons.js';
import { isEqual } from '../../../base/common/extpath.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { basename } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { hasKey } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from
	'../../../platform/actions/common/actions.js';
import { IContextKey } from
	'../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from
	'../../../platform/contextview/browser/contextView.js';
import { IFileDialogService, IDialogService } from
	'../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from
	'../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from
	'../../../platform/list/browser/listService.js';
import { INotificationService } from
	'../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from
	'../../../platform/storage/common/storage.js';
import { IQuickInputService } from
	'../../../platform/quickinput/common/quickInput.js';
import { asCssVariable } from
	'../../../platform/theme/common/colorUtils.js';
import { sessionsSidebarBackground } from
	'../../common/theme.js';
import {
	TreeViewItemHandleArg,
	TreeViewPaneHandleArg,
} from '../../../workbench/common/views.js';
import { Menus } from '../menus.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/common/environmentService.js';
import { IWorkspaceContextService, WorkbenchState } from
	'../../../platform/workspace/common/workspace.js';
import { ICommandService } from
	'../../../platform/commands/common/commands.js';
import {
	CreateWorktreeOptions,
	IProjectManagerService,
	ProjectRecord,
	WorktreeRecord,
} from '../../../platform/projectManager/common/projectManager.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../../common/omniWindow.js';

export const PROJECT_SWITCHER_VIEW_ID = 'workbench.hucode.projectSwitcher.view';

const ADD_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.addProject';
const OPEN_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.openProject';
const OPEN_WORKTREE_COMMAND_ID = 'hucode.projectSwitcher.openWorktree';
const RENAME_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.renameProject';
const PIN_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.pinProject';
const UNPIN_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.unpinProject';
const REMOVE_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.removeProject';
const CREATE_WORKTREE_COMMAND_ID = 'hucode.projectSwitcher.createWorktree';
const REMOVE_WORKTREE_COMMAND_ID = 'hucode.projectSwitcher.removeWorktree';
const UNLOAD_WORKTREE_COMMAND_ID = 'hucode.projectSwitcher.unloadWorktree';
const REFRESH_PROJECTS_COMMAND_ID = 'hucode.projectSwitcher.refresh';
const COLLAPSE_ALL_PROJECTS_COMMAND_ID =
	'hucode.projectSwitcher.collapseAll';

const PROJECT_CONTEXT_VALUE = 'hucode-project';
const PINNED_PROJECT_CONTEXT_VALUE = 'hucode-project-pinned';
const WORKTREE_CONTEXT_VALUE = 'hucode-worktree';
const MAIN_WORKTREE_CONTEXT_VALUE = 'hucode-worktree-main';
const PROJECT_GROUP_SEPARATOR_CONTEXT_VALUE =
	'hucode-project-group-separator';
const PINNED_SEPARATOR_HANDLE = 'separator:pinned';
const UNPINNED_SEPARATOR_HANDLE = 'separator:unpinned';

const PROJECT_SWITCHER_ITEM_HEIGHT = 22;
const PROJECT_SWITCHER_VIEW_STATE_VERSION = 1;
const PROJECT_SWITCHER_VIEW_STATE_STORAGE_KEY =
	'hucode.projectSwitcher.viewState';

interface ProjectSwitcherViewState {
	version?: number;
	collapsedProjectIds?: string[];
}

let currentProjectSwitcherWidget: ProjectSwitcherWidget | undefined;

function encodeWorktreeHandle(projectId: string, worktreePath: string): string {
	return `worktree:${projectId}:${encodeURIComponent(worktreePath)}`;
}

function getWorktreeItemId(
	projectId: string,
	worktreePath: string,
	hostedWorkbenchInstanceId?: string
): string {
	const handle = encodeWorktreeHandle(projectId, worktreePath);
	return hostedWorkbenchInstanceId
		? `${handle}:loaded:${hostedWorkbenchInstanceId}`
		: `${handle}:idle`;
}

function getTreeItemHandle(
	arg?: TreeViewItemHandleArg | TreeViewPaneHandleArg
): string | undefined {
	if (!arg || !hasKey(arg, { $treeItemHandle: true })) {
		return undefined;
	}

	return arg.$treeItemHandle;
}

function parseProjectHandle(handle: string | undefined): string | undefined {
	if (!handle?.startsWith('project:')) {
		return undefined;
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

function pathsEqual(pathA: string, pathB: string): boolean {
	return isEqual(pathA, pathB, !isLinux);
}

interface ProjectSwitcherBaseItem {
	readonly id: string;
	readonly handle: string;
	readonly kind: 'project' | 'worktree' | 'separator';
	readonly label: string;
	readonly description?: string;
	readonly tooltip?: string;
	readonly contextValue: string;
	readonly themeIcon?: ThemeIcon;
}

interface ProjectSwitcherProjectItem extends ProjectSwitcherBaseItem {
	readonly kind: 'project';
	readonly projectId: string;
	readonly pinned: boolean;
	readonly rootPath: string;
}

interface ProjectSwitcherWorktreeItem extends ProjectSwitcherBaseItem {
	readonly kind: 'worktree';
	readonly projectId: string;
	readonly worktreePath: string;
	readonly isMain: boolean;
	readonly hostedWorkbenchInstanceId?: string;
	readonly isActive: boolean;
}

interface ProjectSwitcherSeparatorItem extends ProjectSwitcherBaseItem {
	readonly kind: 'separator';
}

export interface IProjectSwitcherSelectionTarget {
	readonly projectId: string;
	readonly worktreePath: string;
}

type ProjectSwitcherItem =
	| ProjectSwitcherProjectItem
	| ProjectSwitcherWorktreeItem
	| ProjectSwitcherSeparatorItem;

function isProjectItem(
	item: ProjectSwitcherItem | undefined
): item is ProjectSwitcherProjectItem {
	return item?.kind === 'project';
}

function isWorktreeItem(
	item: ProjectSwitcherItem | undefined
): item is ProjectSwitcherWorktreeItem {
	return item?.kind === 'worktree';
}

function isSeparatorItem(
	item: ProjectSwitcherItem | undefined
): item is ProjectSwitcherSeparatorItem {
	return item?.kind === 'separator';
}

function isBeforeDropPosition(
	targetSector: ListViewTargetSector | undefined
): boolean {
	return targetSector === ListViewTargetSector.TOP ||
		targetSector === ListViewTargetSector.CENTER_TOP;
}

function getDropPosition(
	targetSector: ListViewTargetSector | undefined
): ListDragOverEffectPosition {
	return isBeforeDropPosition(targetSector)
		? ListDragOverEffectPosition.Before
		: ListDragOverEffectPosition.After;
}

function toHandleArg(item: ProjectSwitcherItem): TreeViewItemHandleArg {
	return {
		$treeViewId: PROJECT_SWITCHER_VIEW_ID,
		$treeItemHandle: item.handle,
	};
}

class ProjectSwitcherAccessibilityProvider
	implements IListAccessibilityProvider<ProjectSwitcherItem> {

	getWidgetAriaLabel(): string {
		return localize('projectSwitcherAriaLabel', 'Projects');
	}

	getAriaLabel(item: ProjectSwitcherItem): string | null {
		if (isSeparatorItem(item)) {
			return localize(
				'projectGroupAriaLabel',
				'{0} projects',
				item.label
			);
		}

		return item.description
			? `${item.label}, ${item.description}`
			: item.label;
	}
}

class ProjectSwitcherDelegate
	implements IListVirtualDelegate<ProjectSwitcherItem> {

	getHeight(_item: ProjectSwitcherItem): number {
		return PROJECT_SWITCHER_ITEM_HEIGHT;
	}

	getTemplateId(): string {
		return ProjectSwitcherRenderer.ID;
	}
}

interface ProjectSwitcherTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly text: HTMLElement;
	readonly label: HTMLSpanElement;
	readonly description: HTMLSpanElement;
	readonly action: HTMLButtonElement;
	currentAction?: () => void;
	readonly disposables: readonly (() => void)[];
}

class ProjectSwitcherRenderer
	implements ITreeRenderer<ProjectSwitcherItem, void, ProjectSwitcherTemplate> {

	static readonly ID = 'hucodeProjectSwitcherItem';
	readonly templateId = ProjectSwitcherRenderer.ID;

	constructor(
		@ICommandService
		private readonly commandService: ICommandService,
	) {
	}

	renderTemplate(container: HTMLElement): ProjectSwitcherTemplate {
		const item = dom.append(container, dom.$('.hucode-project-switcher-item'));
		const icon = dom.append(item, dom.$('.hucode-project-switcher-icon'));
		const text = dom.append(item, dom.$('.hucode-project-switcher-text'));
		const label = dom.append(
			text,
			dom.$('span.hucode-project-switcher-label')
		) as HTMLSpanElement;
		const description = dom.append(
			text,
			dom.$('span.hucode-project-switcher-description')
		) as HTMLSpanElement;
		const action = dom.append(
			item,
			dom.$('button.hucode-project-switcher-action-button')
		) as HTMLButtonElement;
		action.type = 'button';

		const stopPropagation = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
		};
		const onClick = (event: MouseEvent) => {
			stopPropagation(event);
			template.currentAction?.();
		};
		action.addEventListener('mousedown', stopPropagation);
		action.addEventListener('dblclick', stopPropagation);
		action.addEventListener('click', onClick);

		const template: ProjectSwitcherTemplate = {
			container: item,
			icon,
			text,
			label,
			description,
			action,
			disposables: [
				() => action.removeEventListener('mousedown', stopPropagation),
				() => action.removeEventListener('dblclick', stopPropagation),
				() => action.removeEventListener('click', onClick),
			],
		};

		return template;
	}

	renderElement(
		node: ITreeNode<ProjectSwitcherItem, void>,
		_index: number,
		templateData: ProjectSwitcherTemplate
	): void {
		const item = node.element;
		const row = templateData.container.closest('.monaco-list-row');

		row?.classList.remove('hucode-project-switcher-active-row');
		row?.removeAttribute('aria-current');
		templateData.container.className = 'hucode-project-switcher-item';
		templateData.icon.className = 'hucode-project-switcher-icon';
		templateData.text.className = 'hucode-project-switcher-text';
		templateData.action.className = 'hucode-project-switcher-action-button';
		templateData.label.textContent = item.label;
		templateData.description.textContent = item.description ?? '';
		templateData.description.style.display = item.description ? '' : 'none';
		templateData.container.title = item.tooltip ?? '';
		templateData.action.style.display = 'none';
		templateData.action.title = '';
		templateData.action.setAttribute('aria-label', '');
		templateData.currentAction = undefined;

		if (isSeparatorItem(item)) {
			templateData.container.classList.add(
				'hucode-project-switcher-separator'
			);
			templateData.icon.style.display = 'none';
			templateData.description.style.display = 'none';
			return;
		}

		if (isProjectItem(item)) {
			const label = item.pinned
				? localize('unpinProjectButton', 'Unpin Project')
				: localize('pinProjectButton', 'Pin Project');
			const icon = item.pinned ? Codicon.pinned : Codicon.pin;
			templateData.container.classList.add(
				'hucode-project-switcher-project'
			);
			templateData.action.style.display = '';
			templateData.action.title = label;
			templateData.action.setAttribute('aria-label', label);
			templateData.action.classList.add(
				...ThemeIcon.asClassNameArray(icon)
			);
			templateData.currentAction = () => {
				void this.commandService.executeCommand(
					item.pinned ? UNPIN_PROJECT_COMMAND_ID : PIN_PROJECT_COMMAND_ID,
					toHandleArg(item)
				);
			};
		}

		if (isWorktreeItem(item)) {
			if (item.isActive) {
				row?.classList.add('hucode-project-switcher-active-row');
				row?.setAttribute('aria-current', 'true');
			}

			if (item.hostedWorkbenchInstanceId) {
				const label = localize('unloadWorkbenchButton', 'Unload');
				templateData.container.classList.add(
					'hucode-project-switcher-worktree-loaded'
				);
				templateData.action.style.display = '';
				templateData.action.title = label;
				templateData.action.setAttribute('aria-label', label);
				templateData.action.classList.add(
					...ThemeIcon.asClassNameArray(Codicon.chromeMinimize)
				);
				templateData.currentAction = () => {
					void this.commandService.executeCommand(
						UNLOAD_WORKTREE_COMMAND_ID,
						toHandleArg(item)
					);
				};
			} else {
				templateData.container.classList.add(
					'hucode-project-switcher-worktree-unloaded'
				);
				if (!item.isMain) {
					const label = localize(
						'removeWorktreeButton',
						'Remove Worktree'
					);
					templateData.action.style.display = '';
					templateData.action.title = label;
					templateData.action.setAttribute('aria-label', label);
					templateData.action.classList.add(
						...ThemeIcon.asClassNameArray(Codicon.close)
					);
					templateData.currentAction = () => {
						void this.commandService.executeCommand(
							REMOVE_WORKTREE_COMMAND_ID,
							toHandleArg(item)
						);
					};
				}
			}
		} else {
			templateData.container.removeAttribute('aria-current');
		}

		templateData.icon.style.display = '';
		if (item.themeIcon) {
			templateData.icon.classList.add(
				...ThemeIcon.asClassNameArray(item.themeIcon)
			);
		}
	}

	disposeTemplate(templateData: ProjectSwitcherTemplate): void {
		for (const dispose of templateData.disposables) {
			dispose();
		}
	}
}

class ProjectSwitcherDragAndDrop
	implements ITreeDragAndDrop<ProjectSwitcherItem> {

	constructor(
		@IProjectManagerService
		private readonly projectManagerService: IProjectManagerService,
		@INotificationService
		private readonly notificationService: INotificationService,
	) {
	}

	getDragURI(item: ProjectSwitcherItem): string | null {
		if (isProjectItem(item)) {
			return item.rootPath;
		}
		if (isWorktreeItem(item)) {
			return item.worktreePath;
		}

		return null;
	}

	getDragLabel(
		elems: ProjectSwitcherItem[]
	): string | undefined {
		return elems[0]?.label;
	}

	onDragOver(
		data: unknown,
		target: ProjectSwitcherItem | undefined,
		targetIndex: number | undefined,
		targetSector: ListViewTargetSector | undefined,
		_originalEvent: DragEvent,
	): boolean | ITreeDragOverReaction {
		if (!(data instanceof ElementsDragAndDropData) || data.elements.length !== 1) {
			return false;
		}

		const source = data.elements[0] as ProjectSwitcherItem | undefined;
		if (!source || isSeparatorItem(source)) {
			return false;
		}

		if (isProjectItem(source)) {
			return this.getProjectDragReaction(
				source,
				target,
				targetIndex,
				targetSector
			);
		}

		return this.getWorktreeDragReaction(
			source,
			target,
			targetIndex,
			targetSector
		);
	}

	async drop(
		data: unknown,
		target: ProjectSwitcherItem | undefined,
		_targetIndex: number | undefined,
		targetSector: ListViewTargetSector | undefined,
		_originalEvent: DragEvent,
	): Promise<void> {
		if (!(data instanceof ElementsDragAndDropData) || data.elements.length !== 1) {
			return;
		}

		const source = data.elements[0] as ProjectSwitcherItem | undefined;
		if (!source || isSeparatorItem(source)) {
			return;
		}

		try {
			if (isProjectItem(source)) {
				await this.dropProject(source, target, targetSector);
				return;
			}

			await this.dropWorktree(source, target, targetSector);
		} catch (error) {
			this.notificationService.error(String(error));
		}
	}

	dispose(): void {
	}

	private getProjectDragReaction(
		source: ProjectSwitcherProjectItem,
		target: ProjectSwitcherItem | undefined,
		targetIndex: number | undefined,
		targetSector: ListViewTargetSector | undefined
	): boolean | ITreeDragOverReaction {
		if (!target) {
			return this.createReaction(
				targetIndex,
				ListDragOverEffectPosition.After
			);
		}

		if (!isProjectItem(target) || target.projectId === source.projectId) {
			return false;
		}

		if (target.pinned !== source.pinned) {
			return false;
		}

		if (!isBeforeDropPosition(targetSector)) {
			return false;
		}

		return this.createReaction(targetIndex, getDropPosition(targetSector));
	}

	private getWorktreeDragReaction(
		source: ProjectSwitcherWorktreeItem,
		target: ProjectSwitcherItem | undefined,
		targetIndex: number | undefined,
		targetSector: ListViewTargetSector | undefined
	): boolean | ITreeDragOverReaction {
		if (source.isMain || !target || !isWorktreeItem(target)) {
			return false;
		}

		if (target.projectId !== source.projectId ||
			pathsEqual(target.worktreePath, source.worktreePath)
		) {
			return false;
		}

		if (target.isMain) {
			return this.createReaction(
				targetIndex,
				ListDragOverEffectPosition.After
			);
		}

		return this.createReaction(targetIndex, getDropPosition(targetSector));
	}

	private createReaction(
		targetIndex: number | undefined,
		position: ListDragOverEffectPosition
	): ITreeDragOverReaction {
		return {
			accept: true,
			effect: { type: ListDragOverEffectType.Move, position },
			feedback: [targetIndex ?? -1],
		};
	}

	private async dropProject(
		source: ProjectSwitcherProjectItem,
		target: ProjectSwitcherItem | undefined,
		targetSector: ListViewTargetSector | undefined
	): Promise<void> {
		if (!target) {
			await this.projectManagerService.moveProject(source.projectId);
			return;
		}

		if (!isProjectItem(target) || target.pinned !== source.pinned) {
			return;
		}

		await this.projectManagerService.moveProject(
			source.projectId,
			target.projectId
		);
	}

	private async dropWorktree(
		source: ProjectSwitcherWorktreeItem,
		target: ProjectSwitcherItem | undefined,
		targetSector: ListViewTargetSector | undefined
	): Promise<void> {
		if (source.isMain || !target || !isWorktreeItem(target)) {
			return;
		}

		if (target.projectId !== source.projectId ||
			pathsEqual(target.worktreePath, source.worktreePath)
		) {
			return;
		}

		if (target.isMain) {
			await this.projectManagerService.moveWorktree(
				source.projectId,
				source.worktreePath,
				target.worktreePath
			);
			return;
		}

		const projects = await this.projectManagerService.getProjects();
		const project = projects.find(entry => entry.id === source.projectId);
		if (!project) {
			return;
		}

		const siblings = project.worktrees.filter(worktree =>
			!worktree.isMain && !pathsEqual(worktree.path, source.worktreePath)
		);
		const beforeWorktreePath = isBeforeDropPosition(targetSector)
			? target.worktreePath
			: siblings.find((worktree, index) =>
				pathsEqual(worktree.path, target.worktreePath) &&
				index + 1 < siblings.length
			)?.path;
		await this.projectManagerService.moveWorktree(
			source.projectId,
			source.worktreePath,
			beforeWorktreePath
		);
	}
}

export class ProjectSwitcherWidget extends Disposable {
	private tree: WorkbenchObjectTree<ProjectSwitcherItem, void> | undefined;
	private viewItemContext:
		| IContextKey<string>
		| undefined;
	private itemsById = new Map<string, ProjectSwitcherItem>();
	private projects: readonly ProjectRecord[] = [];
	private hasProjects = false;
	private treeContainer: HTMLElement | undefined;
	private emptyContainer: HTMLElement | undefined;
	private height = 0;
	private width = 0;
	private collapsedProjectIds = new Set<string>();
	private omniHostedWorkspaceState: IHucodeHostedWorkspaceState = {
		instances: [],
	};

	constructor(
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@IContextMenuService
		private readonly contextMenuService: IContextMenuService,
		@IProjectManagerService
		private readonly projectManagerService: IProjectManagerService,
		@IWorkspaceContextService
		private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService
		private readonly notificationService: INotificationService,
		@ICommandService
		private readonly commandService: ICommandService,
		@IStorageService
		private readonly storageService: IStorageService,
		@IWorkbenchEnvironmentService
		private readonly environmentService: IWorkbenchEnvironmentService,
		@IHucodeShellService
		private readonly shellService: IHucodeShellService,
	) {
		super();
		currentProjectSwitcherWidget = this;
		this.loadViewState();
		this._register(toDisposable(() => {
			this.saveState();
			if (currentProjectSwitcherWidget === this) {
				currentProjectSwitcherWidget = undefined;
			}
		}));

		this._register(this.projectManagerService.onDidChangeProjects(projects => {
			void this.handleProjectsChanged(projects);
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			void this.handleWorkspaceContextChange();
		}));
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => {
			void this.handleWorkspaceContextChange();
		}));
		if (this.environmentService.isOmniWindow) {
			this._register(this.shellService.onDidChangeWindowState(change => {
				if (change.windowId !== this.windowId) {
					return;
				}

				this.updateOmniHostedWorkspaceState(change.state);
			}));
		}
	}

	private get windowId(): number {
		return dom.getWindowId(mainWindow);
	}

	render(container: HTMLElement): void {
		container.classList.add('hucode-project-switcher-view');
		this.treeContainer = dom.append(
			container,
			dom.$('.hucode-project-switcher-tree.file-icon-themable-tree')
		);
		this.emptyContainer = dom.append(
			container,
			dom.$('.hucode-project-switcher-empty')
		);
		const emptyMessage = dom.append(
			this.emptyContainer,
			dom.$('div.hucode-project-switcher-empty-message')
		);
		emptyMessage.textContent = localize(
			'projectSwitcherEmpty',
			'No projects have been added yet.'
		);
		const addButton = dom.append(
			this.emptyContainer,
			dom.$('button.hucode-project-switcher-empty-button')
		) as HTMLButtonElement;
		addButton.type = 'button';
		addButton.textContent = localize('addProjectLink', 'Add Project');
		this._register(dom.addDisposableListener(addButton, 'click', () => {
			void this.commandService.executeCommand(ADD_PROJECT_COMMAND_ID);
		}));

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<ProjectSwitcherItem, void>,
			PROJECT_SWITCHER_VIEW_ID,
			this.treeContainer,
			new ProjectSwitcherDelegate(),
			[this.instantiationService.createInstance(ProjectSwitcherRenderer)],
			{
				accessibilityProvider: new ProjectSwitcherAccessibilityProvider(),
				identityProvider: { getId: item => item.id },
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: item => item.label,
				},
				expandOnlyOnTwistieClick: true,
				multipleSelectionSupport: false,
				dnd: this.instantiationService.createInstance(
					ProjectSwitcherDragAndDrop
				),
				overrideStyles: {
					listBackground: asCssVariable(sessionsSidebarBackground),
				},
			}
		));
		this.viewItemContext = this.tree.contextKeyService.createKey(
			'viewItem',
			''
		);

		this._register(this.tree.onDidChangeSelection(() => {
			this.updateItemContext();
		}));
		this._register(this.tree.onDidChangeFocus(() => {
			this.updateItemContext();
		}));
		this._register(this.tree.onDidChangeCollapseState(event => {
			const item = event.node.element ?? undefined;
			if (!isProjectItem(item)) {
				return;
			}

			this.setProjectCollapsed(item.projectId, event.node.collapsed);
		}));
		this._register(this.tree.onContextMenu(event => this.onContextMenu(event)));
		this._register(this.tree.onDidOpen(event => {
			void this.onDidOpenItem(event.element);
		}));
		this.updateEmptyState();

		void this.loadCachedProjects();
		if (this.environmentService.isOmniWindow) {
			void this.initializeOmniHostedWorkspaceState();
		}
	}

	layout(width: number, height: number): void {
		this.height = height;
		this.width = width;
		this.tree?.layout(height, width);
	}

	focus(): void {
		this.tree?.domFocus();
	}

	getSelectionTarget(): IProjectSwitcherSelectionTarget | undefined {
		const item = this.tree?.getFocus()[0] ?? this.tree?.getSelection()[0] ?? undefined;
		if (isWorktreeItem(item)) {
			return {
				projectId: item.projectId,
				worktreePath: item.worktreePath,
			};
		}

		if (isProjectItem(item)) {
			if (this.environmentService.isOmniWindow) {
				return undefined;
			}

			return this.getProjectSelectionTarget(item.projectId);
		}

		if (this.environmentService.isOmniWindow) {
			return undefined;
		}

		return this.projects[0]
			? this.getProjectSelectionTarget(this.projects[0].id)
			: undefined;
	}

	collapseAll(): void {
		this.tree?.collapseAll();
	}

	private async loadCachedProjects(): Promise<void> {
		try {
			await this.handleProjectsChanged(
				await this.projectManagerService.getProjects()
			);
		} catch (error) {
			this.notificationService.error(String(error));
		}
	}

	private async handleProjectsChanged(
		projects: readonly ProjectRecord[]
	): Promise<void> {
		this.projects = projects;
		this.renderProjects(projects);
		await this.syncCurrentWorkspace(projects);
		await this.updateCurrentWorktreeSelection(projects);
	}

	private async handleWorkspaceContextChange(): Promise<void> {
		this.renderProjects(this.projects);
		await this.syncCurrentWorkspace(this.projects);
		await this.updateCurrentWorktreeSelection(this.projects);
	}

	private renderProjects(projects: readonly ProjectRecord[]): void {
		this.captureTreeExpansionState();
		const { roots, itemsById } = this.buildRoots(projects);
		this.hasProjects = projects.length > 0;
		this.itemsById = itemsById;
		this.tree?.setChildren(null, roots);
		this.tree?.rerender();
		this.updateEmptyState();
		this.layout(this.width, this.height);
	}

	private updateEmptyState(): void {
		if (!this.treeContainer || !this.emptyContainer) {
			return;
		}

		this.treeContainer.classList.toggle('hidden', !this.hasProjects);
		this.emptyContainer.classList.toggle('hidden', this.hasProjects);
	}

	private buildRoots(projects: readonly ProjectRecord[]): {
		roots: readonly IObjectTreeElement<ProjectSwitcherItem>[];
		itemsById: Map<string, ProjectSwitcherItem>;
	} {
		const itemsById = new Map<string, ProjectSwitcherItem>();
		const roots: IObjectTreeElement<ProjectSwitcherItem>[] = [];
		const pinnedProjects = projects.filter(project => project.pinned);
		const unpinnedProjects = projects.filter(project => !project.pinned);

		if (pinnedProjects.length) {
			const separator: ProjectSwitcherSeparatorItem = {
				id: PINNED_SEPARATOR_HANDLE,
				handle: PINNED_SEPARATOR_HANDLE,
				kind: 'separator',
				label: localize('pinnedProjects', 'Pinned'),
				contextValue: PROJECT_GROUP_SEPARATOR_CONTEXT_VALUE,
			};
			itemsById.set(separator.handle, separator);
			roots.push({ element: separator });

			for (const project of pinnedProjects) {
				roots.push(this.toProjectElement(project, itemsById));
			}
		}

		if (pinnedProjects.length && unpinnedProjects.length) {
			const separator: ProjectSwitcherSeparatorItem = {
				id: UNPINNED_SEPARATOR_HANDLE,
				handle: UNPINNED_SEPARATOR_HANDLE,
				kind: 'separator',
				label: localize('unpinnedProjects', 'Unpinned'),
				contextValue: PROJECT_GROUP_SEPARATOR_CONTEXT_VALUE,
			};
			itemsById.set(separator.handle, separator);
			roots.push({ element: separator });
		}

		for (const project of unpinnedProjects) {
			roots.push(this.toProjectElement(project, itemsById));
		}

		return { roots, itemsById };
	}

	private toProjectElement(
		project: ProjectRecord,
		itemsById: Map<string, ProjectSwitcherItem>
	): IObjectTreeElement<ProjectSwitcherItem> {
		const rootUri = URI.revive(project.rootUri);
		const rootPath = rootUri.fsPath;
		const item: ProjectSwitcherProjectItem = {
			id: `project:${project.id}`,
			handle: `project:${project.id}`,
			kind: 'project',
			projectId: project.id,
			pinned: project.pinned,
			rootPath,
			label: project.label,
			description: basename(rootPath),
			tooltip: rootPath,
			contextValue: project.pinned
				? PINNED_PROJECT_CONTEXT_VALUE
				: PROJECT_CONTEXT_VALUE,
			themeIcon: Codicon.folder,
		};
		itemsById.set(item.handle, item);

		return {
			element: item,
			collapsible: true,
			collapsed: this.collapsedProjectIds.has(project.id),
			children: project.worktrees.map(worktree =>
				this.toWorktreeElement(project, worktree, itemsById)
			),
		};
	}

	private toWorktreeElement(
		project: ProjectRecord,
		worktree: WorktreeRecord,
		itemsById: Map<string, ProjectSwitcherItem>
	): IObjectTreeElement<ProjectSwitcherItem> {
		const hostedWorkbenchInstanceId = this.getHostedWorkbenchInstanceId(
			worktree.path
		);
		const isActive = this.isActiveWorktree(worktree.path);
		const item: ProjectSwitcherWorktreeItem = {
			id: getWorktreeItemId(
				project.id,
				worktree.path,
				hostedWorkbenchInstanceId
			),
			handle: encodeWorktreeHandle(project.id, worktree.path),
			kind: 'worktree',
			projectId: project.id,
			worktreePath: worktree.path,
			isMain: worktree.isMain,
			hostedWorkbenchInstanceId,
			isActive,
			label: worktree.isMain
				? localize('mainWorktree', 'Main')
				: basename(worktree.path),
			description: worktree.label,
			tooltip: worktree.path,
			contextValue: worktree.isMain
				? MAIN_WORKTREE_CONTEXT_VALUE
				: WORKTREE_CONTEXT_VALUE,
			themeIcon: worktree.isMain ? Codicon.repo : Codicon.gitBranch,
		};
		itemsById.set(item.handle, item);
		return { element: item };
	}

	private getProjectSelectionTarget(
		projectId: string
	): IProjectSwitcherSelectionTarget | undefined {
		const project = this.projects.find(entry => entry.id === projectId);
		if (!project) {
			return undefined;
		}

		const worktree = project.worktrees.find(entry =>
			project.lastActiveWorktreePath !== undefined &&
			pathsEqual(entry.path, project.lastActiveWorktreePath)
		) ?? project.worktrees.find(entry => entry.isMain) ?? project.worktrees[0];
		if (!worktree) {
			return undefined;
		}

		return {
			projectId,
			worktreePath: worktree.path,
		};
	}

	private updateItemContext(): void {
		const item = this.tree?.getFocus()[0] ?? this.tree?.getSelection()[0];
		this.viewItemContext?.set(item?.contextValue ?? '');
	}

	private async onDidOpenItem(
		item: ProjectSwitcherItem | undefined
	): Promise<void> {
		if (this.environmentService.isOmniWindow) {
			if (isProjectItem(item)) {
				this.toggleProjectCollapsed(item);
				return;
			}

			await this.commandService.executeCommand(
				'workbench.action.omniWindow.openSelectedInOmniWindow'
			);
			return;
		}

		if (isProjectItem(item)) {
			await this.commandService.executeCommand(
				OPEN_PROJECT_COMMAND_ID,
				item.projectId
			);
			return;
		}

		if (isWorktreeItem(item)) {
			await this.commandService.executeCommand(
				OPEN_WORKTREE_COMMAND_ID,
				item.worktreePath
			);
		}
	}

	private async initializeOmniHostedWorkspaceState(): Promise<void> {
		try {
			this.updateOmniHostedWorkspaceState(
				await this.shellService.getWindowState(
					this.windowId
				)
			);
		} catch (error) {
			this.notificationService.error(String(error));
		}
	}

	private updateOmniHostedWorkspaceState(
		state: IHucodeHostedWorkspaceState
	): void {
		this.omniHostedWorkspaceState = state;
		if (!this.tree) {
			return;
		}

		this.renderProjects(this.projects);
		this.updateItemContext();
	}

	private getHostedWorkbenchInstanceId(
		worktreePath: string
	): string | undefined {
		if (!this.environmentService.isOmniWindow) {
			return undefined;
		}

		return this.omniHostedWorkspaceState.instances.find(instance =>
			pathsEqual(instance.worktreePath, worktreePath)
		)?.instanceId;
	}

	private isActiveWorktree(worktreePath: string): boolean {
		const activeWorktreePath = this.getActiveWorktreePath();
		return typeof activeWorktreePath === 'string' &&
			pathsEqual(activeWorktreePath, worktreePath);
	}

	private getActiveWorktreePath(): string | undefined {
		if (this.environmentService.isOmniWindow) {
			const activeInstanceId = this.omniHostedWorkspaceState.activeInstanceId;
			if (!activeInstanceId) {
				return undefined;
			}

			return this.omniHostedWorkspaceState.instances.find(instance =>
				instance.instanceId === activeInstanceId
			)?.worktreePath;
		}

		if (this.workspaceContextService.getWorkbenchState() !== WorkbenchState.FOLDER) {
			return undefined;
		}

		const folderUri = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		return folderUri?.scheme === 'file' ? folderUri.fsPath : undefined;
	}

	private toggleProjectCollapsed(item: ProjectSwitcherProjectItem): void {
		if (!this.tree) {
			return;
		}

		const collapsed = this.tree.isCollapsed(item);
		if (collapsed) {
			this.tree.expand(item);
			this.setProjectCollapsed(item.projectId, false);
			return;
		}

		this.tree.collapse(item);
		this.setProjectCollapsed(item.projectId, true);
	}

	private onContextMenu(
		event: ITreeContextMenuEvent<ProjectSwitcherItem | null>
	): void {
		const item = event.element;
		if (!item || isSeparatorItem(item) || !this.tree) {
			return;
		}

		event.browserEvent.preventDefault();
		event.browserEvent.stopPropagation();

		this.tree.setFocus([item]);
		this.tree.setSelection([item]);
		this.viewItemContext?.set(item.contextValue);

		const actions = this.getContextActions(item);
		if (!actions.length) {
			return;
		}

		this.contextMenuService.showContextMenu({
			getAnchor: () => event.anchor,
			getActions: () => actions,
			forceNative: this.environmentService.isOmniWindow,
			onHide: (wasCancelled?: boolean) => {
				if (wasCancelled) {
					this.tree?.domFocus();
				}
			},
		});
	}

	private getContextActions(item: ProjectSwitcherItem): IAction[] {
		if (isProjectItem(item)) {
			const projectHandle = toHandleArg(item);
			return [
				toAction({
					id: RENAME_PROJECT_COMMAND_ID,
					label: localize('renameProject', 'Rename Project'),
					run: () => this.commandService.executeCommand(
						RENAME_PROJECT_COMMAND_ID,
						projectHandle
					),
				}),
				toAction({
					id: item.pinned ? UNPIN_PROJECT_COMMAND_ID : PIN_PROJECT_COMMAND_ID,
					label: item.pinned
						? localize('unpinProject', 'Unpin Project')
						: localize('pinProject', 'Pin Project'),
					run: () => this.commandService.executeCommand(
						item.pinned ? UNPIN_PROJECT_COMMAND_ID : PIN_PROJECT_COMMAND_ID,
						projectHandle
					),
				}),
				new Separator(),
				toAction({
					id: CREATE_WORKTREE_COMMAND_ID,
					label: localize('createWorktree', 'Create Worktree'),
					run: () => this.commandService.executeCommand(
						CREATE_WORKTREE_COMMAND_ID,
						projectHandle
					),
				}),
				toAction({
					id: REFRESH_PROJECTS_COMMAND_ID,
					label: localize('refreshProject', 'Refresh Project'),
					run: () => this.commandService.executeCommand(
						REFRESH_PROJECTS_COMMAND_ID,
						projectHandle
					),
				}),
				new Separator(),
				toAction({
					id: REMOVE_PROJECT_COMMAND_ID,
					label: localize('removeProject', 'Remove Project'),
					run: () => this.commandService.executeCommand(
						REMOVE_PROJECT_COMMAND_ID,
						projectHandle
					),
				}),
			];
		}

		if (isWorktreeItem(item)) {
			const worktreeHandle = toHandleArg(item);
			const hostedWorkbenchInstanceId =
				this.getHostedWorkbenchInstanceId(item.worktreePath);
			const actions: IAction[] = [
				toAction({
					id: REFRESH_PROJECTS_COMMAND_ID,
					label: localize('refreshProject', 'Refresh Project'),
					run: () => this.commandService.executeCommand(
						REFRESH_PROJECTS_COMMAND_ID,
						worktreeHandle
					),
				}),
			];
			if (hostedWorkbenchInstanceId) {
				actions.push(toAction({
					id: UNLOAD_WORKTREE_COMMAND_ID,
					label: localize('unloadWorkbench', 'Unload'),
					run: () => this.commandService.executeCommand(
						UNLOAD_WORKTREE_COMMAND_ID,
						worktreeHandle
					),
				}));
			}
			if (!item.isMain) {
				actions.push(new Separator());
				actions.push(toAction({
					id: REMOVE_WORKTREE_COMMAND_ID,
					label: localize('removeWorktree', 'Remove Worktree'),
					run: () => this.commandService.executeCommand(
						REMOVE_WORKTREE_COMMAND_ID,
						worktreeHandle
					),
				}));
			}
			return actions;
		}

		return [];
	}

	private async syncCurrentWorkspace(
		projects: readonly ProjectRecord[]
	): Promise<void> {
		if (this.workspaceContextService.getWorkbenchState() !== WorkbenchState.FOLDER) {
			return;
		}

		const folderUri = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!folderUri || folderUri.scheme !== 'file') {
			return;
		}

		for (const project of projects) {
			const worktree = project.worktrees.find(entry =>
				pathsEqual(entry.path, folderUri.fsPath)
			);
			if (worktree && project.lastActiveWorktreePath !== worktree.path) {
				await this.projectManagerService.setLastActiveWorktree(
					project.id,
					worktree.path
				);
			}
		}
	}

	private async updateCurrentWorktreeSelection(
		projects: readonly ProjectRecord[]
	): Promise<void> {
		if (!this.tree) {
			return;
		}

		const currentWorktree = this.getCurrentWorktreeItem(projects);
		if (!currentWorktree) {
			this.tree.setSelection([]);
			this.tree.setFocus([]);
			return;
		}

		const projectItem = this.itemsById.get(
			`project:${currentWorktree.projectId}`
		);
		if (isProjectItem(projectItem)) {
			this.tree.expand(projectItem);
			this.setProjectCollapsed(projectItem.projectId, false);
		}

		await this.tree.reveal(currentWorktree);
		this.tree.setSelection([currentWorktree]);
		this.tree.setFocus([currentWorktree]);
		this.viewItemContext?.set(currentWorktree.contextValue);
	}

	private getCurrentWorktreeItem(
		projects: readonly ProjectRecord[]
	): ProjectSwitcherWorktreeItem | undefined {
		if (this.workspaceContextService.getWorkbenchState() !== WorkbenchState.FOLDER) {
			return undefined;
		}

		const folderUri = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!folderUri || folderUri.scheme !== 'file') {
			return undefined;
		}

		for (const project of projects) {
			const worktree = project.worktrees.find(entry =>
				pathsEqual(entry.path, folderUri.fsPath)
			);
			if (worktree) {
				const item = this.itemsById.get(
					encodeWorktreeHandle(project.id, worktree.path)
				);
				if (isWorktreeItem(item)) {
					return item;
				}
			}
		}

		return undefined;
	}

	saveState(): void {
		this.captureTreeExpansionState();
		const state: ProjectSwitcherViewState = {
			version: PROJECT_SWITCHER_VIEW_STATE_VERSION,
			collapsedProjectIds: [...this.collapsedProjectIds].sort(),
		};
		this.storageService.store(
			PROJECT_SWITCHER_VIEW_STATE_STORAGE_KEY,
			JSON.stringify(state),
			StorageScope.PROFILE,
			StorageTarget.MACHINE
		);
	}

	private loadViewState(): void {
		const rawState = this.storageService.get(
			PROJECT_SWITCHER_VIEW_STATE_STORAGE_KEY,
			StorageScope.PROFILE
		);
		if (!rawState) {
			this.collapsedProjectIds.clear();
			return;
		}

		let state: ProjectSwitcherViewState;
		try {
			state = JSON.parse(rawState) as ProjectSwitcherViewState;
		} catch {
			this.collapsedProjectIds.clear();
			return;
		}

		if (state.version !== PROJECT_SWITCHER_VIEW_STATE_VERSION ||
			!Array.isArray(state.collapsedProjectIds)
		) {
			this.collapsedProjectIds.clear();
			return;
		}

		this.collapsedProjectIds = new Set(state.collapsedProjectIds);
	}

	private captureTreeExpansionState(): void {
		if (!this.tree) {
			return;
		}

		for (const item of this.itemsById.values()) {
			if (!isProjectItem(item)) {
				continue;
			}

			this.setProjectCollapsed(item.projectId, this.tree.isCollapsed(item));
		}
	}

	private setProjectCollapsed(projectId: string, collapsed: boolean): void {
		if (collapsed) {
			this.collapsedProjectIds.add(projectId);
			return;
		}

		this.collapsedProjectIds.delete(projectId);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ADD_PROJECT_COMMAND_ID,
			title: localize2('addProject', 'Add Project'),
			icon: Codicon.add,
			menu: {
				id: Menus.SidebarTitle,
				group: 'navigation',
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const projectManagerService = accessor.get(IProjectManagerService);
		const notificationService = accessor.get(INotificationService);

		try {
			const folder = await fileDialogService.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: localize('addProjectOpenLabel', 'Add Project'),
				title: localize('addProjectTitle', 'Add Git Project'),
			});
			if (!folder?.length) {
				return;
			}

			await projectManagerService.addProject(folder[0]);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

export function getSelectedProjectSwitcherTarget():
	| IProjectSwitcherSelectionTarget
	| undefined {
	return currentProjectSwitcherWidget?.getSelectionTarget();
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: REFRESH_PROJECTS_COMMAND_ID,
			title: localize2('refreshProjects', 'Refresh Projects'),
			icon: Codicon.refresh,
			menu: {
				id: Menus.SidebarTitle,
				group: 'navigation',
				order: 10,
			},
			f1: true,
		});
	}

	async run(
		accessor: ServicesAccessor,
		handle?: TreeViewItemHandleArg | TreeViewPaneHandleArg
	): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const notificationService = accessor.get(INotificationService);

		try {
			const handleId = getTreeItemHandle(handle);
			const projectId = parseProjectHandle(handleId) ??
				parseWorktreeHandle(handleId)?.projectId;
			await projectManagerService.refresh(projectId);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: COLLAPSE_ALL_PROJECTS_COMMAND_ID,
			title: localize2('collapseAllProjects', 'Collapse All'),
			icon: Codicon.collapseAll,
			menu: {
				id: Menus.SidebarTitle,
				group: 'navigation',
				order: 20,
			},
			f1: true,
		});
	}

	async run(): Promise<void> {
		currentProjectSwitcherWidget?.collapseAll();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_PROJECT_COMMAND_ID,
			title: localize2('openProject', 'Open Project'),
		});
	}

	async run(
		accessor: ServicesAccessor,
		projectId: string | TreeViewItemHandleArg
	): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const hostService = accessor.get(IHostService);
		const notificationService = accessor.get(INotificationService);

		try {
			const resolvedProjectId = typeof projectId === 'string'
				? projectId
				: parseProjectHandle(projectId.$treeItemHandle);
			if (!resolvedProjectId) {
				return;
			}

			const projects = await projectManagerService.getProjects();
			const project = projects.find(entry => entry.id === resolvedProjectId);
			if (!project) {
				return;
			}

			const worktree = project.worktrees.find(entry =>
				project.lastActiveWorktreePath !== undefined &&
				pathsEqual(entry.path, project.lastActiveWorktreePath)
			) ?? project.worktrees.find(entry => entry.isMain) ?? project.worktrees[0];
			if (!worktree) {
				return;
			}

			await hostService.openWindow(
				[{ folderUri: URI.file(worktree.path) }],
				{ forceReuseWindow: true }
			);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_WORKTREE_COMMAND_ID,
			title: localize2('openWorktree', 'Open Worktree'),
		});
	}

	async run(
		accessor: ServicesAccessor,
		worktreePath: string | TreeViewItemHandleArg
	): Promise<void> {
		const hostService = accessor.get(IHostService);
		const notificationService = accessor.get(INotificationService);

		try {
			const resolvedWorktreePath = typeof worktreePath === 'string'
				? worktreePath
				: parseWorktreeHandle(worktreePath.$treeItemHandle)?.worktreePath;
			if (!resolvedWorktreePath) {
				return;
			}

			await hostService.openWindow(
				[{ folderUri: URI.file(resolvedWorktreePath) }],
				{ forceReuseWindow: true }
			);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: RENAME_PROJECT_COMMAND_ID,
			title: localize2('renameProject', 'Rename Project'),
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		try {
			const projectId = parseProjectHandle(handle.$treeItemHandle);
			if (!projectId) {
				return;
			}

			const projects = await projectManagerService.getProjects();
			const project = projects.find(entry => entry.id === projectId);
			if (!project) {
				return;
			}

			const label = await quickInputService.input({
				prompt: localize('renameProjectPrompt', 'Project label'),
				value: project.label,
				validateInput: async value => value.trim()
					? undefined
					: localize(
						'renameProjectValidate',
						'Project label is required.'
					),
			});
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
			id: PIN_PROJECT_COMMAND_ID,
			title: localize2('pinProject', 'Pin Project'),
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const projectId = parseProjectHandle(handle.$treeItemHandle);
		if (!projectId) {
			return;
		}

		await accessor.get(IProjectManagerService).setPinned(projectId, true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: UNPIN_PROJECT_COMMAND_ID,
			title: localize2('unpinProject', 'Unpin Project'),
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const projectId = parseProjectHandle(handle.$treeItemHandle);
		if (!projectId) {
			return;
		}

		await accessor.get(IProjectManagerService).setPinned(projectId, false);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: REMOVE_PROJECT_COMMAND_ID,
			title: localize2('removeProject', 'Remove Project'),
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);

		try {
			const projectId = parseProjectHandle(handle.$treeItemHandle);
			if (!projectId) {
				return;
			}

			const projects = await projectManagerService.getProjects();
			const project = projects.find(entry => entry.id === projectId);
			if (!project) {
				return;
			}

			const result = await dialogService.confirm({
				type: 'warning',
				message: localize(
					'removeProjectConfirm',
					'Remove project "{0}" from Hucode?',
					project.label
				),
				detail: localize(
					'removeProjectDetail',
					'This only removes the project from the sidebar. Repository files are left untouched.'
				),
			});
			if (!result.confirmed) {
				return;
			}

			await projectManagerService.removeProject(projectId);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CREATE_WORKTREE_COMMAND_ID,
			title: localize2('createWorktree', 'Create Worktree'),
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		try {
			const projectId = parseProjectHandle(handle.$treeItemHandle);
			if (!projectId) {
				return;
			}

			const branchName = await quickInputService.input({
				prompt: localize('createWorktreeBranch', 'Branch name'),
				validateInput: async value => value.trim()
					? undefined
					: localize(
						'createWorktreeBranchValidate',
						'Branch name is required.'
					),
			});
			if (!branchName) {
				return;
			}

			const startPoint = await quickInputService.input({
				prompt: localize('createWorktreeStartPoint', 'Start point'),
				value: 'HEAD',
			});
			if (startPoint === undefined) {
				return;
			}

			const options: CreateWorktreeOptions = {
				branchName,
				startPoint,
			};
			await projectManagerService.createWorktree(projectId, options);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: REMOVE_WORKTREE_COMMAND_ID,
			title: localize2('removeWorktree', 'Remove Worktree'),
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);

		try {
			const parsed = parseWorktreeHandle(handle.$treeItemHandle);
			if (!parsed) {
				return;
			}

			if (workspaceContextService.getWorkbenchState() === WorkbenchState.FOLDER) {
				const currentFolder = workspaceContextService.getWorkspace().folders[0]?.uri;
				if (currentFolder?.scheme === 'file' &&
					pathsEqual(currentFolder.fsPath, parsed.worktreePath)
				) {
					notificationService.error(localize(
						'removeCurrentWorktreeBlocked',
						'The current worktree cannot be removed from this window.'
					));
					return;
				}
			}

			const result = await dialogService.confirm({
				type: 'warning',
				message: localize(
					'removeWorktreeConfirm',
					'Remove worktree "{0}"?',
					basename(parsed.worktreePath)
				),
				detail: localize(
					'removeWorktreeDetail',
					'Hucode will run `git worktree remove` without `--force`.'
				),
			});
			if (!result.confirmed) {
				return;
			}

			await projectManagerService.removeWorktree(
				parsed.projectId,
				parsed.worktreePath
			);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: UNLOAD_WORKTREE_COMMAND_ID,
			title: localize2('unloadWorkbench', 'Unload'),
		});
	}

	async run(
		accessor: ServicesAccessor,
		handle: TreeViewItemHandleArg
	): Promise<void> {
		const parsed = parseWorktreeHandle(handle.$treeItemHandle);
		if (!parsed) {
			return;
		}

		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		if (!environmentService.isOmniWindow) {
			return;
		}

		const shellService = accessor.get(IHucodeShellService);
		const notificationService = accessor.get(INotificationService);

		try {
			const state = await shellService.getWindowState(
				dom.getWindowId(mainWindow)
			);
			const instance = state.instances.find(entry =>
				pathsEqual(entry.worktreePath, parsed.worktreePath)
			);
			if (!instance) {
				return;
			}

			await shellService.closeWorkspace(
				dom.getWindowId(mainWindow),
				instance.instanceId
			);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});
