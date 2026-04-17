/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/projectSwitcher.css';
import * as dom from '../../../../base/browser/dom.js';
import { $, append } from '../../../../base/browser/dom.js';
import { getZoomFactor } from '../../../../base/browser/browser.js';
import { IMouseEvent } from '../../../../base/browser/mouseEvent.js';
import {
	IContextMenuItem,
	IPopupOptions,
} from '../../../../base/parts/contextmenu/common/contextmenu.js';
import { popup } from
	'../../../../base/parts/contextmenu/electron-browser/contextmenu.js';
import { IAction, Separator, SubmenuAction, toAction } from
	'../../../../base/common/actions.js';
import {
	IListVirtualDelegate,
	ListDragOverEffectPosition,
	ListDragOverEffectType,
} from '../../../../base/browser/ui/list/list.js';
import {
	ElementsDragAndDropData,
	ListViewTargetSector,
} from '../../../../base/browser/ui/list/listView.js';
import { IListAccessibilityProvider } from
	'../../../../base/browser/ui/list/listWidget.js';
import {
	IObjectTreeElement,
	ITreeContextMenuEvent,
	ITreeDragAndDrop,
	ITreeDragOverReaction,
	ITreeNode,
	ITreeRenderer,
} from '../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isEqual } from '../../../../base/common/extpath.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { isLinux } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from
	'../../../../platform/actions/common/actions.js';
import { IConfigurationService } from
	'../../../../platform/configuration/common/configuration.js';
import { IContextKey, ContextKeyExpr, IContextKeyService } from
	'../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from
	'../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService, IDialogService } from
	'../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from
	'../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from
	'../../../../platform/instantiation/common/descriptors.js';
import { IKeybindingService } from
	'../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from
	'../../../../platform/list/browser/listService.js';
import { INotificationService } from
	'../../../../platform/notification/common/notification.js';
import { IOpenerService } from
	'../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from
	'../../../../platform/storage/common/storage.js';
import { IQuickInputService } from
	'../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from
	'../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from
	'../../../../platform/theme/common/themeService.js';
import { ViewPane, ViewPaneShowActions } from
	'../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from
	'../../../browser/parts/views/viewPaneContainer.js';
import { IViewletViewOptions } from
	'../../../browser/parts/views/viewsViewlet.js';
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from '../../../common/contributions.js';
import {
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewDescriptor,
	IViewDescriptorService,
	IViewsRegistry,
	TreeViewItemHandleArg,
	TreeViewPaneHandleArg,
	ViewContainer,
	ViewContainerLocation,
} from '../../../common/views.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { INativeWorkbenchEnvironmentService } from
	'../../../services/environment/electron-browser/environmentService.js';
import { IWorkspaceContextService, WorkbenchState } from
	'../../../../platform/workspace/common/workspace.js';
import { ICommandService } from
	'../../../../platform/commands/common/commands.js';
import {
	CreateWorktreeOptions,
	IProjectManagerService,
	ProjectRecord,
	WorktreeRecord,
} from '../../../../platform/projectManager/common/projectManager.js';

export const PROJECT_SWITCHER_CONTAINER_ID = 'workbench.hucode.projectSwitcher';
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

let currentProjectSwitcherViewPane: ProjectSwitcherViewPane | undefined;

const projectSwitcherIcon = registerIcon(
	'hucode-project-switcher-view-icon',
	Codicon.repo,
	localize(
		'projectSwitcherViewIcon',
		'View icon of the Hucode project switcher.'
	)
);

const VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(
	ViewExtensions.ViewContainersRegistry
).registerViewContainer({
	id: PROJECT_SWITCHER_CONTAINER_ID,
	title: localize2('hucodeProjectSwitcher', 'Projects'),
	icon: projectSwitcherIcon,
	order: 1,
	ctorDescriptor: new SyncDescriptor(
		ViewPaneContainer,
		[
			PROJECT_SWITCHER_CONTAINER_ID,
			{ mergeViewWithContainerWhenSingleView: true },
		]
	),
	storageId: PROJECT_SWITCHER_CONTAINER_ID,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

function encodeWorktreeHandle(projectId: string, worktreePath: string): string {
	return `worktree:${projectId}:${encodeURIComponent(worktreePath)}`;
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
	currentProject?: ProjectSwitcherProjectItem;
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
		const item = append(container, $('.hucode-project-switcher-item'));
		const icon = append(item, $('.hucode-project-switcher-icon'));
		const text = append(item, $('.hucode-project-switcher-text'));
		const label = append(
			text,
			$('span.hucode-project-switcher-label')
		) as HTMLSpanElement;
		const description = append(
			text,
			$('span.hucode-project-switcher-description')
		) as HTMLSpanElement;
		const action = append(
			item,
			$('button.hucode-project-switcher-action-button')
		) as HTMLButtonElement;
		action.type = 'button';

		const stopPropagation = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
		};
		const onClick = (event: MouseEvent) => {
			stopPropagation(event);

			const project = template.currentProject;
			if (!project) {
				return;
			}

			void this.commandService.executeCommand(
				project.pinned ? UNPIN_PROJECT_COMMAND_ID : PIN_PROJECT_COMMAND_ID,
				toHandleArg(project)
			);
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
		templateData.currentProject = undefined;

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
			templateData.currentProject = item;
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

class ProjectSwitcherViewPane extends ViewPane {
	private tree: WorkbenchObjectTree<ProjectSwitcherItem, void> | undefined;
	private viewItemContext:
		| IContextKey<string>
		| undefined;
	private itemsById = new Map<string, ProjectSwitcherItem>();
	private projects: readonly ProjectRecord[] = [];
	private hasProjects = false;
	private bodyHeight = 0;
	private bodyWidth = 0;
	private collapsedProjectIds = new Set<string>();

	constructor(
		options: IViewletViewOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
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
		@INativeWorkbenchEnvironmentService
		private readonly environmentService: INativeWorkbenchEnvironmentService,
	) {
		super(
			{
				...options,
				titleMenuId: MenuId.ViewTitle,
				showActions: ViewPaneShowActions.Always,
			},
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService,
		);
		currentProjectSwitcherViewPane = this;
		this.loadViewState();
		this._register(toDisposable(() => {
			if (currentProjectSwitcherViewPane === this) {
				currentProjectSwitcherViewPane = undefined;
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
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				void this.refreshProjects();
			}
		}));
		this._register(this.onDidChangeViewWelcomeState(() => {
			if (this.tree) {
				this.layoutBody(this.bodyHeight, this.bodyWidth);
			}
		}));
	}

	override shouldShowWelcome(): boolean {
		return !this.hasProjects;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('hucode-project-switcher-view');
		const treeContainer = append(
			container,
			$('.hucode-project-switcher-tree.file-icon-themable-tree')
		);

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<ProjectSwitcherItem, void>,
			PROJECT_SWITCHER_VIEW_ID,
			treeContainer,
			new ProjectSwitcherDelegate(),
			[this.instantiationService.createInstance(ProjectSwitcherRenderer)],
			{
				accessibilityProvider: new ProjectSwitcherAccessibilityProvider(),
				identityProvider: { getId: item => item.id },
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: item => item.label,
				},
				multipleSelectionSupport: false,
				dnd: this.instantiationService.createInstance(
					ProjectSwitcherDragAndDrop
				),
				overrideStyles: this.getLocationBasedColors().listOverrideStyles,
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

		void this.loadCachedProjects();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.bodyHeight = height;
		this.bodyWidth = width;
		this.tree?.layout(height, width);
	}

	override focus(): void {
		super.focus();
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
			return this.getProjectSelectionTarget(item.projectId);
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

	private async refreshProjects(): Promise<void> {
		try {
			await this.projectManagerService.refresh();
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
		await this.syncCurrentWorkspace(this.projects);
		await this.updateCurrentWorktreeSelection(this.projects);
	}

	private renderProjects(projects: readonly ProjectRecord[]): void {
		this.captureTreeExpansionState();
		const previousHasProjects = this.hasProjects;
		const { roots, itemsById } = this.buildRoots(projects);
		this.hasProjects = projects.length > 0;
		this.itemsById = itemsById;
		this.tree?.setChildren(null, roots);

		if (previousHasProjects !== this.hasProjects) {
			this._onDidChangeViewWelcomeState.fire();
		}
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
			itemsById.set(separator.id, separator);
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
			itemsById.set(separator.id, separator);
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
			themeIcon: Codicon.repo,
		};
		itemsById.set(item.id, item);

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
		const item: ProjectSwitcherWorktreeItem = {
			id: encodeWorktreeHandle(project.id, worktree.path),
			handle: encodeWorktreeHandle(project.id, worktree.path),
			kind: 'worktree',
			projectId: project.id,
			worktreePath: worktree.path,
			isMain: worktree.isMain,
			label: worktree.label,
			description: worktree.isMain
				? localize('mainWorktree', 'Main')
				: basename(worktree.path),
			tooltip: worktree.path,
			contextValue: worktree.isMain
				? MAIN_WORKTREE_CONTEXT_VALUE
				: WORKTREE_CONTEXT_VALUE,
			themeIcon: worktree.isMain ? Codicon.repo : Codicon.gitBranch,
		};
		itemsById.set(item.id, item);
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

		if (this.environmentService.isOmniWindow) {
			this.showNativeContextMenu(event, actions);
			return;
		}

		this.contextMenuService.showContextMenu({
			getAnchor: () => event.anchor,
			getActions: () => actions,
			onHide: (wasCancelled?: boolean) => {
				if (wasCancelled) {
					this.tree?.domFocus();
				}
			},
		});
	}

	private showNativeContextMenu(
		event: ITreeContextMenuEvent<ProjectSwitcherItem | null>,
		actions: readonly IAction[]
	): void {
		const items = this.toNativeContextMenuItems(actions);
		if (!items.length) {
			return;
		}

		popup(
			items,
			this.getNativeContextMenuPopupOptions(event.anchor),
			() => dom.ModifierKeyEmitter.getInstance().resetKeyStatus()
		);
	}

	private toNativeContextMenuItems(
		actions: readonly IAction[]
	): IContextMenuItem[] {
		const items: IContextMenuItem[] = [];

		for (const action of actions) {
			if (action instanceof Separator) {
				items.push({ type: 'separator' });
				continue;
			}

			if (action instanceof SubmenuAction) {
				items.push({
					label: action.label,
					submenu: this.toNativeContextMenuItems(action.actions),
				});
				continue;
			}

			items.push({
				label: action.label,
				enabled: action.enabled,
				checked: action.checked,
				type: action.checked ? 'checkbox' : undefined,
				click: () => void action.run(),
			});
		}

		return items;
	}

	private getNativeContextMenuPopupOptions(
		anchor: HTMLElement | IMouseEvent
	): IPopupOptions | undefined {
		if (dom.isHTMLElement(anchor)) {
			const targetWindow = dom.getWindow(anchor);
			const clientRect = anchor.getBoundingClientRect();
			const zoom = getZoomFactor(targetWindow) *
				dom.getDomNodeZoomLevel(anchor);

			return {
				x: Math.floor(clientRect.left * zoom),
				y: Math.floor(clientRect.bottom * zoom),
			};
		}

		const zoom = getZoomFactor(dom.getActiveWindow());
		return {
			x: Math.floor(anchor.posx * zoom),
			y: Math.floor(anchor.posy * zoom),
		};
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

	override saveState(): void {
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
		super.saveState();
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

const PROJECT_SWITCHER_VIEW_DESCRIPTOR: IViewDescriptor = {
	id: PROJECT_SWITCHER_VIEW_ID,
	name: localize2('hucodeProjectSwitcher', 'Projects'),
	ctorDescriptor: new SyncDescriptor(ProjectSwitcherViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	collapsed: false,
};

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[PROJECT_SWITCHER_VIEW_DESCRIPTOR],
	VIEW_CONTAINER
);

class HostedOmniProjectSwitcherVisibilityContribution
	implements IWorkbenchContribution {
	static readonly ID =
		'workbench.contrib.hucode.hostedOmniProjectSwitcherVisibility';

	constructor(
		@INativeWorkbenchEnvironmentService
		environmentService: INativeWorkbenchEnvironmentService,
	) {
		if (!environmentService.isHostedOmniWorkspace) {
			return;
		}

		const viewsRegistry = Registry.as<IViewsRegistry>(
			ViewExtensions.ViewsRegistry
		);
		const viewContainersRegistry = Registry.as<IViewContainersRegistry>(
			ViewExtensions.ViewContainersRegistry
		);

		viewsRegistry.deregisterViews(
			[PROJECT_SWITCHER_VIEW_DESCRIPTOR],
			VIEW_CONTAINER
		);
		viewContainersRegistry.deregisterViewContainer(VIEW_CONTAINER);
	}
}

registerWorkbenchContribution2(
	HostedOmniProjectSwitcherVisibilityContribution.ID,
	HostedOmniProjectSwitcherVisibilityContribution,
	WorkbenchPhase.BlockStartup
);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
	PROJECT_SWITCHER_VIEW_ID,
	{
		content: localize(
			'projectSwitcherEmpty',
			'No projects have been added yet.\n[{0}](command:{1})',
			localize('addProjectLink', 'Add Project'),
			ADD_PROJECT_COMMAND_ID
		),
		when: ContextKeyExpr.equals('view', PROJECT_SWITCHER_VIEW_ID),
		order: 1,
	}
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ADD_PROJECT_COMMAND_ID,
			title: localize2('addProject', 'Add Project'),
			icon: Codicon.add,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', PROJECT_SWITCHER_VIEW_ID),
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
	return currentProjectSwitcherViewPane?.getSelectionTarget();
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: REFRESH_PROJECTS_COMMAND_ID,
			title: localize2('refreshProjects', 'Refresh Projects'),
			icon: Codicon.refresh,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', PROJECT_SWITCHER_VIEW_ID),
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
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', PROJECT_SWITCHER_VIEW_ID),
				group: 'navigation',
				order: 20,
			},
			f1: true,
		});
	}

	async run(): Promise<void> {
		currentProjectSwitcherViewPane?.collapseAll();
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
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', PROJECT_SWITCHER_VIEW_ID),
					ContextKeyExpr.regex('viewItem', /^hucode-project/)
				),
				group: '0_manage',
			},
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
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', PROJECT_SWITCHER_VIEW_ID),
					ContextKeyExpr.equals('viewItem', PROJECT_CONTEXT_VALUE)
				),
				group: '0_manage',
			},
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
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', PROJECT_SWITCHER_VIEW_ID),
					ContextKeyExpr.equals('viewItem', PINNED_PROJECT_CONTEXT_VALUE)
				),
				group: '0_manage',
			},
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
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', PROJECT_SWITCHER_VIEW_ID),
					ContextKeyExpr.regex('viewItem', /^hucode-project/)
				),
				group: '9_remove',
			},
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
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', PROJECT_SWITCHER_VIEW_ID),
					ContextKeyExpr.regex('viewItem', /^hucode-project/)
				),
				group: '1_create',
			},
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
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', PROJECT_SWITCHER_VIEW_ID),
					ContextKeyExpr.equals('viewItem', WORKTREE_CONTEXT_VALUE)
				),
				group: '9_remove',
			},
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
