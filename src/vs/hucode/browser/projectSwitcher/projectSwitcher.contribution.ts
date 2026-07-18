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
	ITreeContextMenuEvent,
	ITreeDragAndDrop,
	ITreeDragOverReaction,
	ITreeNode,
	ITreeRenderer,
} from '../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { basename } from '../../../base/common/path.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { hasKey } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from
	'../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService } from
	'../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from
	'../../../platform/contextview/browser/contextView.js';
import { IFileDialogService, IDialogService } from
	'../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from
	'../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from
	'../../../platform/label/common/label.js';
import { WorkbenchObjectTree } from
	'../../../platform/list/browser/listService.js';
import { INotificationService } from
	'../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from
	'../../../platform/storage/common/storage.js';
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
import { IsOmniWindowContext } from
	'../../../workbench/common/contextkeys.js';
import { IWorkspaceContextService, WorkbenchState } from
	'../../../platform/workspace/common/workspace.js';
import { ICommandService } from
	'../../../platform/commands/common/commands.js';
import { IConfigurationService } from
	'../../../platform/configuration/common/configuration.js';
import {
	IProjectManagerService,
	ProjectRecord,
} from '../../../platform/projectManager/common/projectManager.js';
import {
	OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
	OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID,
} from '../../../platform/window/common/hucodeOmniCommandRouting.js';
import {
	IHucodeHostedWorkbenchInstance,
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../../common/omniWindow.js';
import {
	CREATE_WORKTREE_COMMAND_ID,
	GO_BACK_WORKTREE_COMMAND_ID,
	GO_FORWARD_WORKTREE_COMMAND_ID,
	ADD_PROJECT_COMMAND_ID,
	COLLAPSE_ALL_PROJECTS_COMMAND_ID,
	pathsEqual,
	ProjectSwitcherCanGoBackContext,
	ProjectSwitcherCanGoForwardContext,
	RENAME_PROJECT_COMMAND_ID,
	RENAME_WORKTREE_COMMAND_ID,
	REFRESH_PROJECTS_COMMAND_ID,
} from './projectSwitcherCommon.js';
import {
	openProjectSwitcherTarget,
	setLastActiveWorktreeBestEffort,
	type IProjectSwitcherSelectionTarget,
} from './switchProjectWorktree.contribution.js';
import { openSelectionInStandaloneWindow } from '../omniSelectionOpen.js';
import {
	canonicalizeProjectSwitcherTarget,
	sortProjectSwitcherNavigationHistory,
} from
	'../../common/projectSwitcher/switchProjectWorktreeModel.js';
import {
	applyOmniSectionCollapseChange,
	buildProjectSwitcherTreeModel,
	encodeProjectHandle,
	isHostedWorkbenchInProgress,
	isItemInCollapsedOmniSection,
	isProjectItem,
	isOmniSectionItem,
	isRetainedWorkbenchItem,
	isSeparatorItem,
	isWorktreeItem,
	PINNED_SECTION,
	ProjectSwitcherItem,
	ProjectSwitcherProjectItem,
	ProjectSwitcherTreeElement,
	ProjectSwitcherWorkbenchItem,
	ProjectSwitcherWorktreeItem,
	selectionTargetsEqual,
	UNPINNED_SECTION,
} from '../../common/projectSwitcher/projectSwitcherTreeModel.js';
import {
	HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING,
	HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING,
	HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING,
	HucodeHostedWorkbenchRestorePolicy,
	HucodeOmniItemLayout,
} from '../../common/retainedWorkbench.js';
import {
	DEFAULT_PROJECT_SWITCHER_OMNI_SECTION_ORDER,
	IProjectSwitcherViewState,
	parseProjectSwitcherViewState,
	ProjectSwitcherOmniSection,
	PROJECT_SWITCHER_VIEW_STATE_VERSION,
	reorderProjectSwitcherOmniSections,
} from '../../common/projectSwitcher/projectSwitcherViewState.js';

export const PROJECT_SWITCHER_VIEW_ID = 'workbench.hucode.projectSwitcher.view';

const OPEN_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.openProject';
const OPEN_WORKTREE_COMMAND_ID = 'hucode.projectSwitcher.openWorktree';
const RESET_PROJECT_LABEL_COMMAND_ID =
	'hucode.projectSwitcher.resetProjectLabel';
const RESET_WORKTREE_LABEL_COMMAND_ID =
	'hucode.projectSwitcher.resetWorktreeLabel';
const PIN_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.pinProject';
const UNPIN_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.unpinProject';
const PIN_WORKTREE_COMMAND_ID = 'hucode.projectSwitcher.pinWorktree';
const UNPIN_WORKTREE_COMMAND_ID = 'hucode.projectSwitcher.unpinWorktree';
const REMOVE_PROJECT_COMMAND_ID = 'hucode.projectSwitcher.removeProject';
const REMOVE_WORKTREE_COMMAND_ID = 'hucode.projectSwitcher.removeWorktree';
const UNLOAD_WORKTREE_COMMAND_ID = 'hucode.projectSwitcher.unloadWorktree';
const ADD_WORKBENCH_COMMAND_ID = 'hucode.projectSwitcher.addWorkbench';
const OPEN_WORKBENCH_COMMAND_ID = 'hucode.projectSwitcher.openWorkbench';
const UNLOAD_WORKBENCH_COMMAND_ID = 'hucode.projectSwitcher.unloadWorkbench';
const DISMISS_WORKBENCH_COMMAND_ID = 'hucode.projectSwitcher.dismissWorkbench';

const PROJECT_SWITCHER_STALE_REFRESH_INTERVAL = 60 * 1000;

const PROJECT_SWITCHER_ITEM_HEIGHT = 22;
const PROJECT_SWITCHER_VIEW_STATE_STORAGE_KEY =
	'hucode.projectSwitcher.viewState';
const PROJECT_SWITCHER_HISTORY_LIMIT = 100;

let currentProjectSwitcherWidget: ProjectSwitcherWidget | undefined;

function parseWorkbenchHandle(handle: string | undefined): string | undefined {
	return handle?.startsWith('workbench:')
		? handle.slice('workbench:'.length)
		: undefined;
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

	const [, section, projectId] = handle.split(':', 3);
	if ((section === PINNED_SECTION || section === UNPINNED_SECTION) &&
		projectId
	) {
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
		return localize(
			'projectSwitcherAriaLabel',
			'Workbenches and Projects'
		);
	}

	getAriaLabel(item: ProjectSwitcherItem): string | null {
		if (isOmniSectionItem(item)) {
			return localize('omniSectionAriaLabel', '{0} section', item.label);
		}
		if (isSeparatorItem(item)) {
			return localize(
				'projectGroupAriaLabel',
				'{0} projects',
				item.label
			);
		}
		if (isRetainedWorkbenchItem(item)) {
			const stateLabel = (() => {
				switch (item.hostedWorkbenchState) {
					case 'restore-pending':
					case 'loading':
						return localize('workbenchStateLoading', 'Loading');
					case 'active':
						return localize('workbenchStateActive', 'Active');
					case 'loaded':
						return localize('workbenchStateLoaded', 'Loaded');
					case 'dormant':
						return localize('workbenchStateDormant', 'Dormant');
					case 'crashed':
						return localize('workbenchStateCrashed', 'Crashed');
					case 'missing':
						return localize('workbenchStateMissing', 'Folder missing');
					default:
						return localize('workbenchStateUnloaded', 'Unloaded');
				}
			})();
			return localize(
				'workbenchAriaLabel',
				'{0}, {1}, {2}',
				item.label,
				item.description ?? item.worktreePath,
				stateLabel
			);
		}

		return item.description
			? `${item.label}, ${item.description}`
			: item.label;
	}
}

class ProjectSwitcherDelegate
	implements IListVirtualDelegate<ProjectSwitcherItem> {
	constructor(
		private readonly getItemLayout: (
			item: ProjectSwitcherItem
		) => HucodeOmniItemLayout
	) { }

	getHeight(item: ProjectSwitcherItem): number {
		return this.getItemLayout(item) === 'twoLine'
			? PROJECT_SWITCHER_ITEM_HEIGHT * 2
			: PROJECT_SWITCHER_ITEM_HEIGHT;
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
	readonly actions: HTMLElement;
	readonly leadingAction: ProjectSwitcherActionTemplate;
	readonly trailingAction: ProjectSwitcherActionTemplate;
	readonly disposables: readonly (() => void)[];
}

interface ProjectSwitcherActionTemplate {
	readonly button: HTMLButtonElement;
	currentAction?: () => void;
}

class ProjectSwitcherRenderer
	implements ITreeRenderer<ProjectSwitcherItem, void, ProjectSwitcherTemplate> {

	static readonly ID = 'hucodeProjectSwitcherItem';
	readonly templateId = ProjectSwitcherRenderer.ID;

	constructor(
		private readonly getItemLayout: (
			item: ProjectSwitcherItem
		) => HucodeOmniItemLayout,
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
		const actions = dom.append(
			item,
			dom.$('.hucode-project-switcher-actions')
		);
		const disposables: (() => void)[] = [];
		const createAction = (): ProjectSwitcherActionTemplate => {
			const button = dom.append(
				actions,
				dom.$('button.hucode-project-switcher-action-button')
			) as HTMLButtonElement;
			button.type = 'button';
			const action: ProjectSwitcherActionTemplate = { button };

			const stopPropagation = (event: Event) => {
				event.preventDefault();
				event.stopPropagation();
			};
			const onClick = (event: MouseEvent) => {
				stopPropagation(event);
				action.currentAction?.();
			};
			button.addEventListener('mousedown', stopPropagation);
			button.addEventListener('dblclick', stopPropagation);
			button.addEventListener('click', onClick);
			disposables.push(
				() => button.removeEventListener('mousedown', stopPropagation),
				() => button.removeEventListener('dblclick', stopPropagation),
				() => button.removeEventListener('click', onClick)
			);

			return action;
		};
		const leadingAction = createAction();
		const trailingAction = createAction();

		const template: ProjectSwitcherTemplate = {
			container: item,
			icon,
			text,
			label,
			description,
			actions,
			leadingAction,
			trailingAction,
			disposables,
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
		if (this.getItemLayout(item) === 'twoLine') {
			templateData.container.classList.add(
				'hucode-project-switcher-two-line'
			);
		}
		templateData.label.textContent = item.label;
		templateData.description.textContent = item.description ?? '';
		templateData.description.style.display = item.description ? '' : 'none';
		templateData.container.title = item.tooltip ?? '';
		templateData.actions.className = 'hucode-project-switcher-actions';
		templateData.actions.style.display = 'none';
		this.resetAction(templateData.leadingAction);
		this.resetAction(templateData.trailingAction);
		templateData.icon.style.display = '';
		if (item.themeIcon) {
			templateData.icon.classList.add(
				...ThemeIcon.asClassNameArray(item.themeIcon)
			);
		}

		if (isSeparatorItem(item)) {
			templateData.container.classList.add(
				'hucode-project-switcher-separator'
			);
			templateData.icon.style.display = 'none';
			templateData.description.style.display = 'none';
			return;
		}

		if (isOmniSectionItem(item)) {
			templateData.container.classList.add(
				'hucode-project-switcher-section'
			);
			templateData.icon.style.display = 'none';
			this.setAction(
				templateData,
				templateData.trailingAction,
				item.sectionKind === 'workbenches'
					? localize('addWorkbenchButton', 'Add Workbench')
					: localize('addProjectButton', 'Add Project'),
				Codicon.add,
				() => {
					void this.commandService.executeCommand(
						item.sectionKind === 'workbenches'
							? ADD_WORKBENCH_COMMAND_ID
							: ADD_PROJECT_COMMAND_ID
					);
				}
			);
			templateData.actions.classList.add(
				'hucode-project-switcher-section-actions'
			);
			return;
		}

		if (isRetainedWorkbenchItem(item)) {
			this.renderWorkbenchItem(item, templateData, row);
			return;
		}

		if (isProjectItem(item)) {
			const label = item.pinned
				? localize('unpinProjectButton', 'Unpin Project')
				: localize('pinProjectButton', 'Pin Project');
			const icon = item.pinned ? Codicon.pinned : Codicon.pin;
			const createLabel = localize(
				'createWorktreeButton',
				'Create Worktree'
			);
			templateData.container.classList.add(
				'hucode-project-switcher-project'
			);
			this.setAction(
				templateData,
				templateData.leadingAction,
				label,
				icon,
				() => {
					void this.commandService.executeCommand(
						item.pinned
							? UNPIN_PROJECT_COMMAND_ID
							: PIN_PROJECT_COMMAND_ID,
						toHandleArg(item)
					);
				}
			);
			this.setAction(
				templateData,
				templateData.trailingAction,
				createLabel,
				Codicon.add,
				() => {
					void this.commandService.executeCommand(
						CREATE_WORKTREE_COMMAND_ID,
						toHandleArg(item)
					);
				}
			);
		}

		if (isWorktreeItem(item)) {
			if (item.isActive) {
				row?.classList.add('hucode-project-switcher-active-row');
				row?.setAttribute('aria-current', 'true');
			}

			if (!item.missingGitWorktree) {
				const pinLabel = item.pinned
					? localize('unpinWorktreeButton', 'Unpin Worktree')
					: localize('pinWorktreeButton', 'Pin Worktree');
				const pinIcon = item.pinned ? Codicon.pinned : Codicon.pin;
				this.setAction(
					templateData,
					templateData.leadingAction,
					pinLabel,
					pinIcon,
					() => {
						void this.commandService.executeCommand(
							item.pinned
								? UNPIN_WORKTREE_COMMAND_ID
								: PIN_WORKTREE_COMMAND_ID,
							toHandleArg(item)
						);
					}
				);
			}

			const isLiveHostedWorkbench =
				item.hostedWorkbenchState === 'restore-pending' ||
				item.hostedWorkbenchState === 'loading' ||
				item.hostedWorkbenchState === 'active' ||
				item.hostedWorkbenchState === 'loaded';
			if (item.missingGitWorktree) {
				templateData.container.classList.add(
					'hucode-project-switcher-worktree-missing'
				);
			}
			if (isLiveHostedWorkbench) {
				templateData.container.classList.add(
					isHostedWorkbenchInProgress(item.hostedWorkbenchState)
						? 'hucode-project-switcher-worktree-loading'
						: 'hucode-project-switcher-worktree-loaded'
				);
				const label = localize('unloadWorkbenchButton', 'Unload');
				this.setAction(
					templateData,
					templateData.trailingAction,
					label,
					Codicon.chromeMinimize,
					() => {
						void this.commandService.executeCommand(
							UNLOAD_WORKTREE_COMMAND_ID,
							toHandleArg(item)
						);
					}
				);
			} else {
				templateData.container.classList.add(
					item.hostedWorkbenchState === 'dormant'
						? 'hucode-project-switcher-worktree-dormant'
						: 'hucode-project-switcher-worktree-unloaded'
				);
				if (!item.isMain && !item.missingGitWorktree) {
					const label = localize(
						'removeWorktreeButton',
						'Remove Worktree'
					);
					this.setAction(
						templateData,
						templateData.trailingAction,
						label,
						Codicon.close,
						() => {
							void this.commandService.executeCommand(
								REMOVE_WORKTREE_COMMAND_ID,
								toHandleArg(item)
							);
						}
					);
				}
			}
		} else {
			templateData.container.removeAttribute('aria-current');
		}

	}

	private resetAction(action: ProjectSwitcherActionTemplate): void {
		action.button.className = 'hucode-project-switcher-action-button';
		action.button.style.display = 'none';
		action.button.title = '';
		action.button.setAttribute('aria-label', '');
		action.currentAction = undefined;
	}

	private setAction(
		templateData: ProjectSwitcherTemplate,
		action: ProjectSwitcherActionTemplate,
		label: string,
		icon: ThemeIcon,
		run: () => void
	): void {
		templateData.actions.style.display = '';
		action.button.style.display = '';
		action.button.title = label;
		action.button.setAttribute('aria-label', label);
		action.button.classList.add(...ThemeIcon.asClassNameArray(icon));
		action.currentAction = run;
	}

	disposeTemplate(templateData: ProjectSwitcherTemplate): void {
		for (const dispose of templateData.disposables) {
			dispose();
		}
	}

	private renderWorkbenchItem(
		item: ProjectSwitcherWorkbenchItem,
		templateData: ProjectSwitcherTemplate,
		row: Element | null
	): void {
		templateData.container.classList.add(
			'hucode-project-switcher-workbench'
		);
		if (item.isActive) {
			row?.classList.add('hucode-project-switcher-active-row');
			row?.setAttribute('aria-current', 'true');
		}
		templateData.container.classList.add(
			`hucode-project-switcher-workbench-${item.hostedWorkbenchState}`
		);
		const isLive = item.hostedWorkbenchState === 'restore-pending' ||
			item.hostedWorkbenchState === 'loading' ||
			item.hostedWorkbenchState === 'active' ||
			item.hostedWorkbenchState === 'loaded';
		this.setAction(
			templateData,
			templateData.trailingAction,
			isLive
				? localize('unloadRetainedWorkbenchButton', 'Unload Workbench')
				: localize('dismissWorkbenchButton', 'Dismiss Workbench'),
			isLive ? Codicon.chromeMinimize : Codicon.close,
			() => {
				void this.commandService.executeCommand(
					isLive
						? UNLOAD_WORKBENCH_COMMAND_ID
						: DISMISS_WORKBENCH_COMMAND_ID,
					toHandleArg(item)
				);
			}
		);
	}
}

class ProjectSwitcherDragAndDrop
	implements ITreeDragAndDrop<ProjectSwitcherItem> {

	constructor(
		private readonly reorderOmniSections: (
			source: ProjectSwitcherOmniSection,
			target: ProjectSwitcherOmniSection
		) => void,
		@IProjectManagerService
		private readonly projectManagerService: IProjectManagerService,
		@INotificationService
		private readonly notificationService: INotificationService,
		@IHucodeShellService
		private readonly shellService: IHucodeShellService,
	) {
	}

	getDragURI(item: ProjectSwitcherItem): string | null {
		if (isProjectItem(item)) {
			return item.rootPath;
		}
		if (isWorktreeItem(item)) {
			return item.worktreePath;
		}
		if (isRetainedWorkbenchItem(item)) {
			return item.worktreePath;
		}
		if (isOmniSectionItem(item)) {
			return `hucode-omni-section:///${item.sectionKind}`;
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
		if (isOmniSectionItem(source)) {
			if (!target || !isOmniSectionItem(target) ||
				target.sectionKind === source.sectionKind
			) {
				return false;
			}
			return this.createReaction(
				targetIndex,
				getDropPosition(targetSector)
			);
		}

		if (isProjectItem(source)) {
			return this.getProjectDragReaction(
				source,
				target,
				targetIndex,
				targetSector
			);
		}
		if (isRetainedWorkbenchItem(source)) {
			if (!target || !isRetainedWorkbenchItem(target) ||
				target.retainedWorkbenchId === source.retainedWorkbenchId
			) {
				return false;
			}
			return this.createReaction(
				targetIndex,
				getDropPosition(targetSector)
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
		if (isOmniSectionItem(source)) {
			if (target && isOmniSectionItem(target)) {
				this.reorderOmniSections(
					source.sectionKind,
					target.sectionKind
				);
			}
			return;
		}

		try {
			if (isProjectItem(source)) {
				await this.dropProject(source, target, targetSector);
				return;
			}
			if (isRetainedWorkbenchItem(source)) {
				await this.dropRetainedWorkbench(
					source,
					target,
					targetSector
				);
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

		if (!isProjectItem(target) ||
			target.projectId === source.projectId ||
			target.section !== source.section
		) {
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
			target.section !== source.section ||
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

		if (!isProjectItem(target) || target.section !== source.section) {
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
			target.section !== source.section ||
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

	private async dropRetainedWorkbench(
		source: ProjectSwitcherWorkbenchItem,
		target: ProjectSwitcherItem | undefined,
		targetSector: ListViewTargetSector | undefined
	): Promise<void> {
		if (!target || !isRetainedWorkbenchItem(target) ||
			target.retainedWorkbenchId === source.retainedWorkbenchId
		) {
			return;
		}
		const state = await this.shellService.getWindowState(
			dom.getWindowId(mainWindow)
		);
		const orderedIds = (state.retainedWorkbenches ?? [])
			.toSorted((a, b) => a.order - b.order)
			.map(record => record.id)
			.filter(id => id !== source.retainedWorkbenchId);
		const targetIndex = orderedIds.indexOf(target.retainedWorkbenchId);
		if (targetIndex < 0) {
			return;
		}
		orderedIds.splice(
			targetIndex + (isBeforeDropPosition(targetSector) ? 0 : 1),
			0,
			source.retainedWorkbenchId
		);
		await this.shellService.reorderRetainedWorkbenches(
			dom.getWindowId(mainWindow),
			orderedIds
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
	private lastProjectsRefreshAt = 0;
	private collapsedProjectIds = new Set<string>();
	private collapsedOmniSections = new Set<string>();
	private omniSectionOrder = [
		...DEFAULT_PROJECT_SWITCHER_OMNI_SECTION_ORDER,
	];
	private isSynchronizingTree = false;
	private worktreeNavigationHistory: IProjectSwitcherSelectionTarget[] = [];
	private worktreeNavigationIndex = -1;
	private isNavigatingWorktreeHistory = false;
	private hasSeededNavigationHistory = false;
	private readonly canGoBackContext: IContextKey<boolean>;
	private readonly canGoForwardContext: IContextKey<boolean>;
	private omniHostedWorkspaceState: IHucodeHostedWorkspaceState = {
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: [],
	};

	constructor(
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@IContextMenuService
		private readonly contextMenuService: IContextMenuService,
		@IContextKeyService
		private readonly contextKeyService: IContextKeyService,
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
		@IHostService
		private readonly hostService: IHostService,
		@ILabelService
		private readonly labelService: ILabelService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
	) {
		super();
		currentProjectSwitcherWidget = this;
		this.canGoBackContext =
			ProjectSwitcherCanGoBackContext.bindTo(this.contextKeyService);
		this.canGoForwardContext =
			ProjectSwitcherCanGoForwardContext.bindTo(this.contextKeyService);
		this.loadViewState();
		this._register(toDisposable(() => {
			this.saveState();
			this.canGoBackContext.set(false);
			this.canGoForwardContext.set(false);
			if (this.environmentService.isOmniWindow) {
				void this.shellService.setProjectSwitcherNavigationState(
					this.windowId,
					false,
					false
				);
			}
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
			this._register(this.hostService.onDidChangeFocus(focused => {
				if (focused) {
					void this.refreshProjectsIfStale();
				}
			}));
			this._register(this.shellService.onDidChangeWindowState(change => {
				if (change.windowId !== this.windowId) {
					return;
				}

				this.updateOmniHostedWorkspaceState(change.state);
			}));
			this._register(this.configurationService.onDidChangeConfiguration(
				event => {
					if (event.affectsConfiguration(
						HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING
					) || event.affectsConfiguration(
						HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING
					)) {
						this.renderProjects(this.projects);
					}
				}
			));
		}
	}

	private get windowId(): number {
		return dom.getWindowId(mainWindow);
	}

	private get viewStateStorageScope(): StorageScope {
		return this.environmentService.isOmniWindow
			? StorageScope.WORKSPACE
			: StorageScope.PROFILE;
	}

	private getPathLabel(path: string): string {
		return this.labelService.getUriLabel(URI.file(path));
	}

	private getItemLayout(item: ProjectSwitcherItem): HucodeOmniItemLayout {
		if (!this.environmentService.isOmniWindow) {
			return 'compact';
		}
		if (isRetainedWorkbenchItem(item)) {
			return this.configurationService.getValue<HucodeOmniItemLayout>(
				HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING
			) ?? 'twoLine';
		}
		if (isWorktreeItem(item)) {
			return this.configurationService.getValue<HucodeOmniItemLayout>(
				HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING
			) ?? 'compact';
		}
		return 'compact';
	}

	private reorderOmniSections(
		source: ProjectSwitcherOmniSection,
		target: ProjectSwitcherOmniSection
	): void {
		this.omniSectionOrder = reorderProjectSwitcherOmniSections(
			this.omniSectionOrder,
			source,
			target
		);
		void this.shellService.setProjectSwitcherSectionOrder(
			this.windowId,
			this.omniSectionOrder
		);
		this.saveState();
		this.renderProjects(this.projects);
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
			new ProjectSwitcherDelegate(item => this.getItemLayout(item)),
			[this.instantiationService.createInstance(
				ProjectSwitcherRenderer,
				(item: ProjectSwitcherItem) => this.getItemLayout(item)
			)],
			{
				accessibilityProvider: new ProjectSwitcherAccessibilityProvider(),
				identityProvider: { getId: item => item.id },
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: item => item.label,
				},
				expandOnlyOnTwistieClick: true,
				multipleSelectionSupport: false,
				dnd: this.instantiationService.createInstance(
					ProjectSwitcherDragAndDrop,
					(
						source: ProjectSwitcherOmniSection,
						target: ProjectSwitcherOmniSection
					) => this.reorderOmniSections(source, target)
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
			if (isOmniSectionItem(item)) {
				if (applyOmniSectionCollapseChange(
					this.collapsedOmniSections,
					item.handle,
					event.node.collapsed,
					this.isSynchronizingTree
				)) {
					this.saveState();
				}
				return;
			}
			if (!isProjectItem(item)) {
				return;
			}

			this.setProjectCollapsed(item, event.node.collapsed);
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

		if (isRetainedWorkbenchItem(item)) {
			return { worktreePath: item.worktreePath };
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

	async goBack(): Promise<void> {
		await this.navigateWorktreeHistory(-1);
	}

	async goForward(): Promise<void> {
		await this.navigateWorktreeHistory(1);
	}

	private async navigateWorktreeHistory(delta: -1 | 1): Promise<void> {
		const nextIndex = this.worktreeNavigationIndex + delta;
		const historyTarget = this.worktreeNavigationHistory[nextIndex];
		const target = historyTarget && canonicalizeProjectSwitcherTarget(
			historyTarget,
			this.projects,
			pathsEqual
		);
		if (!target) {
			return;
		}

		this.isNavigatingWorktreeHistory = true;
		try {
			await openProjectSwitcherTarget(
				target,
				this.projectManagerService,
				this.environmentService,
				this.shellService,
				this.hostService
			);
			this.worktreeNavigationIndex = nextIndex;
		} catch (error) {
			this.notificationService.error(String(error));
		} finally {
			this.isNavigatingWorktreeHistory = false;
			this.updateNavigationContexts();
		}
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
		this.lastProjectsRefreshAt = Date.now();
		this.projects = projects;
		if (this.environmentService.isOmniWindow) {
			await this.shellService.reconcileRetainedWorkbenches(
				this.windowId,
				projects.flatMap(project => project.worktrees.map(worktree => ({
					projectId: project.id,
					folderUri: URI.file(worktree.path).toJSON(),
				})))
			);
		}
		if (this.projects !== projects) {
			return;
		}
		this.renderProjects(projects);
		await this.syncCurrentWorkspace(projects);
		await this.updateCurrentWorktreeSelection();
		this.recordActiveWorktree(projects);
	}

	private async refreshProjectsIfStale(): Promise<void> {
		if (Date.now() - this.lastProjectsRefreshAt <
			PROJECT_SWITCHER_STALE_REFRESH_INTERVAL) {
			return;
		}

		try {
			await this.projectManagerService.refresh();
		} catch (error) {
			this.notificationService.error(String(error));
		}
	}

	private async handleWorkspaceContextChange(): Promise<void> {
		this.renderProjects(this.projects);
		await this.syncCurrentWorkspace(this.projects);
		await this.updateCurrentWorktreeSelection();
		this.recordActiveWorktree(this.projects);
	}

	private renderProjects(projects: readonly ProjectRecord[]): void {
		this.captureTreeExpansionState();
		const { roots, itemsById } = this.buildRoots(projects);
		this.hasProjects = roots.length > 0;
		this.itemsById = itemsById;
		this.isSynchronizingTree = true;
		try {
			this.tree?.setChildren(null, roots);
			this.tree?.rerender();
		} finally {
			this.isSynchronizingTree = false;
		}
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
		roots: readonly ProjectSwitcherTreeElement[];
		itemsById: Map<string, ProjectSwitcherItem>;
	} {
		return buildProjectSwitcherTreeModel({
			projects,
			collapsedProjectIds: this.collapsedProjectIds,
			getPathLabel: path => this.getPathLabel(path),
			isOmniWindow: this.environmentService.isOmniWindow,
			activeWorktreePath: this.getActiveWorktreePath(),
			hostedWorkspaceState: this.omniHostedWorkspaceState,
			collapsedOmniSections: this.collapsedOmniSections,
			omniSectionOrder: this.omniSectionOrder,
		});
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
			if (isOmniSectionItem(item)) {
				this.toggleOmniSectionCollapsed(item);
				return;
			}
			if (isProjectItem(item)) {
				this.toggleProjectCollapsed(item);
				return;
			}

			await this.commandService.executeCommand(
				OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID
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
			await this.shellService.setProjectSwitcherSectionOrder(
				this.windowId,
				this.omniSectionOrder
			);
			await this.shellService.setHostedWorkbenchRestorePolicy(
				this.windowId,
				this.configurationService.getValue<
					HucodeHostedWorkbenchRestorePolicy
				>(HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING) ?? 'active'
			);
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
		void this.updateCurrentWorktreeSelection().catch(error => {
			this.notificationService.error(String(error));
		});
		void this.syncOmniActiveWorktree(this.projects).catch(error => {
			this.notificationService.error(String(error));
		});
		this.recordActiveWorktree(this.projects);
	}

	private getHostedWorkbenchInstance(
		worktreePath: string
	): IHucodeHostedWorkbenchInstance | undefined {
		if (!this.environmentService.isOmniWindow) {
			return undefined;
		}

		return this.omniHostedWorkspaceState.instances.find(instance =>
			pathsEqual(instance.worktreePath, worktreePath)
		);
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
			this.setProjectCollapsed(item, false);
			return;
		}

		this.tree.collapse(item);
		this.setProjectCollapsed(item, true);
	}

	private toggleOmniSectionCollapsed(
		item: Extract<ProjectSwitcherItem, { kind: 'section' }>
	): void {
		if (!this.tree) {
			return;
		}
		if (this.tree.isCollapsed(item)) {
			this.tree.expand(item);
		} else {
			this.tree.collapse(item);
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
		if (isRetainedWorkbenchItem(item)) {
			const handle = toHandleArg(item);
			const isLive = item.hostedWorkbenchState === 'restore-pending' ||
				item.hostedWorkbenchState === 'loading' ||
				item.hostedWorkbenchState === 'active' ||
				item.hostedWorkbenchState === 'loaded';
			return [
				toAction({
					id: OPEN_WORKBENCH_COMMAND_ID,
					label: localize(
						'openOrActivateRetainedWorkbench',
						'Open or Activate Workbench'
					),
					run: () => this.commandService.executeCommand(
						OPEN_WORKBENCH_COMMAND_ID,
						handle
					),
				}),
				toAction({
					id: OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
					label: localize(
						'openRetainedWorkbenchNewWindow',
						'Open in New Window'
					),
					run: () => openSelectionInStandaloneWindow(
						{ worktreePath: item.worktreePath },
						this.hostService,
						this.shellService,
						this.projectManagerService,
						this.notificationService,
						localize(
							'openRetainedWorkbenchSelectionMissing',
							'Select a workbench first.'
						),
						{
							windowId: this.windowId,
							id: item.retainedWorkbenchId,
						}
					),
				}),
				...(isLive || item.hostedWorkbenchState === 'dormant' ? [toAction({
					id: UNLOAD_WORKBENCH_COMMAND_ID,
					label: localize(
						'unloadRetainedWorkbench',
						'Unload Workbench'
					),
					run: () => this.commandService.executeCommand(
						UNLOAD_WORKBENCH_COMMAND_ID,
						handle
					),
				})] : []),
				new Separator(),
				toAction({
					id: DISMISS_WORKBENCH_COMMAND_ID,
					label: localize(
						'dismissRetainedWorkbench',
						'Dismiss Workbench'
					),
					run: () => this.commandService.executeCommand(
						DISMISS_WORKBENCH_COMMAND_ID,
						handle
					),
				}),
			];
		}

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
				...(item.hasCustomLabel
					? [toAction({
						id: RESET_PROJECT_LABEL_COMMAND_ID,
						label: localize(
							'resetProjectLabel',
							'Reset Project Name'
						),
						run: () => this.commandService.executeCommand(
							RESET_PROJECT_LABEL_COMMAND_ID,
							projectHandle
						),
					})]
					: []),
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
				this.getHostedWorkbenchInstance(item.worktreePath)?.instanceId;
			if (item.missingGitWorktree) {
				return hostedWorkbenchInstanceId
					? [toAction({
						id: UNLOAD_WORKTREE_COMMAND_ID,
						label: localize('unloadWorkbench', 'Unload'),
						run: () => this.commandService.executeCommand(
							UNLOAD_WORKTREE_COMMAND_ID,
							worktreeHandle
						),
					})]
					: [];
			}

			const actions: IAction[] = [
				toAction({
					id: RENAME_WORKTREE_COMMAND_ID,
					label: localize('renameWorktree', 'Rename Worktree'),
					run: () => this.commandService.executeCommand(
						RENAME_WORKTREE_COMMAND_ID,
						worktreeHandle
					),
				}),
				...(item.hasCustomLabel
					? [toAction({
						id: RESET_WORKTREE_LABEL_COMMAND_ID,
						label: localize(
							'resetWorktreeLabel',
							'Reset Worktree Name'
						),
						run: () => this.commandService.executeCommand(
							RESET_WORKTREE_LABEL_COMMAND_ID,
							worktreeHandle
						),
					})]
					: []),
				toAction({
					id: item.pinned
						? UNPIN_WORKTREE_COMMAND_ID
						: PIN_WORKTREE_COMMAND_ID,
					label: item.pinned
						? localize('unpinWorktree', 'Unpin Worktree')
						: localize('pinWorktree', 'Pin Worktree'),
					run: () => this.commandService.executeCommand(
						item.pinned
							? UNPIN_WORKTREE_COMMAND_ID
							: PIN_WORKTREE_COMMAND_ID,
						worktreeHandle
					),
				}),
				toAction({
					id: REFRESH_PROJECTS_COMMAND_ID,
					label: localize('refreshProject', 'Refresh Project'),
					run: () => this.commandService.executeCommand(
						REFRESH_PROJECTS_COMMAND_ID,
						worktreeHandle
					),
				}),
				new Separator(),
				toAction({
					id: OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
					label: hostedWorkbenchInstanceId
						? localize(
							'reopenWorktreeInNewWindow',
							'Re-open in New Window'
						)
						: localize(
							'openWorktreeInNewWindow',
							'Open in New Window'
						),
					run: () => this.commandService.executeCommand(
						OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID
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
			if (
				worktree &&
				(project.lastActiveWorktreePath === undefined ||
					!pathsEqual(project.lastActiveWorktreePath, worktree.path))
			) {
				await this.projectManagerService.setLastActiveWorktree(
					project.id,
					worktree.path
				);
			}
		}
	}

	private async syncOmniActiveWorktree(
		projects: readonly ProjectRecord[]
	): Promise<void> {
		if (!this.environmentService.isOmniWindow) {
			return;
		}

		const activeWorktreePath = this.getActiveWorktreePath();
		if (!activeWorktreePath) {
			return;
		}

		for (const project of projects) {
			const worktree = project.worktrees.find(entry =>
				pathsEqual(entry.path, activeWorktreePath)
			);
			if (
				worktree &&
				(project.lastActiveWorktreePath === undefined ||
					!pathsEqual(project.lastActiveWorktreePath, worktree.path))
			) {
				await this.projectManagerService.setLastActiveWorktree(
					project.id,
					worktree.path
				);
				return;
			}
		}
	}

	private async updateCurrentWorktreeSelection(): Promise<void> {
		const tree = this.tree;
		if (!tree) {
			return;
		}

		// Shell state changes can rebuild the tree while a previous selection
		// update is still in flight, replacing every item instance. Only apply
		// selection when this update still owns the rendered items, and only
		// with instances the tree currently knows.
		const renderedItems = this.itemsById;
		const currentWorktree = this.getCurrentWorktreeItem();
		if (!currentWorktree) {
			tree.setSelection([]);
			tree.setFocus([]);
			return;
		}

		const isHiddenByCollapsedOmniSection =
			this.environmentService.isOmniWindow &&
			isItemInCollapsedOmniSection(
				currentWorktree,
				this.collapsedOmniSections
			);

		if (isWorktreeItem(currentWorktree) &&
			!isHiddenByCollapsedOmniSection
		) {
			const projectItem = this.itemsById.get(
				encodeProjectHandle(
					currentWorktree.projectId,
					currentWorktree.section
				)
			);
			if (isProjectItem(projectItem) && tree.hasElement(projectItem)) {
				tree.expand(projectItem);
				this.setProjectCollapsed(projectItem, false);
			}
		}

		if (!tree.hasElement(currentWorktree)) {
			return;
		}

		if (!isHiddenByCollapsedOmniSection) {
			await tree.reveal(currentWorktree);
		}
		if (
			this.itemsById !== renderedItems ||
			!tree.hasElement(currentWorktree)
		) {
			return;
		}

		tree.setSelection([currentWorktree]);
		tree.setFocus([currentWorktree]);
		this.viewItemContext?.set(currentWorktree.contextValue);
	}

	private getCurrentWorktreeItem():
		| ProjectSwitcherWorktreeItem
		| ProjectSwitcherWorkbenchItem
		| undefined {
		const activeWorktreePath = this.getActiveWorktreePath();
		if (!activeWorktreePath) {
			return undefined;
		}

		for (const item of this.itemsById.values()) {
			if (
				(isWorktreeItem(item) || isRetainedWorkbenchItem(item)) &&
				pathsEqual(item.worktreePath, activeWorktreePath)
			) {
				return item;
			}
		}

		return undefined;
	}

	private recordActiveWorktree(projects: readonly ProjectRecord[]): void {
		if (this.isNavigatingWorktreeHistory) {
			return;
		}

		const activeTarget = this.getActiveSelectionTarget();
		if (!activeTarget) {
			this.updateNavigationContexts();
			return;
		}

		if (!this.hasSeededNavigationHistory) {
			this.seedNavigationHistory(projects, activeTarget);
			return;
		}
		this.worktreeNavigationHistory = this.worktreeNavigationHistory.map(
			target => canonicalizeProjectSwitcherTarget(
				target,
				projects,
				pathsEqual
			)
		);

		const currentTarget =
			this.worktreeNavigationHistory[this.worktreeNavigationIndex];
		if (selectionTargetsEqual(currentTarget, activeTarget)) {
			this.updateNavigationContexts();
			return;
		}

		this.worktreeNavigationHistory = [
			...this.worktreeNavigationHistory.slice(
				0,
				this.worktreeNavigationIndex + 1
			),
			activeTarget,
		].slice(-PROJECT_SWITCHER_HISTORY_LIMIT);
		this.worktreeNavigationIndex =
			this.worktreeNavigationHistory.length - 1;
		this.updateNavigationContexts();
	}

	private seedNavigationHistory(
		projects: readonly ProjectRecord[],
		activeTarget: IProjectSwitcherSelectionTarget
	): void {
		this.hasSeededNavigationHistory = true;
		const visitedTargets = projects
			.flatMap(project => project.worktrees
				.filter(worktree => worktree.lastVisitedAt !== undefined)
				.map(worktree => ({
					projectId: project.id,
					worktreePath: worktree.path,
					lastVisitedAt: worktree.lastVisitedAt ?? 0,
				}))
			)
			.filter(target => !selectionTargetsEqual(target, activeTarget));
		const retainedTargets = (this.omniHostedWorkspaceState
			.retainedWorkbenches ?? [])
			.filter(record => record.lastActiveAt !== undefined)
			.map(record => ({
				worktreePath: URI.revive(record.folderUri).fsPath,
				lastVisitedAt: record.lastActiveAt ?? 0,
			}))
			.map(target => ({
				...canonicalizeProjectSwitcherTarget(
					target,
					projects,
					pathsEqual
				),
				lastVisitedAt: target.lastVisitedAt,
			}))
			.filter(target => !selectionTargetsEqual(target, activeTarget));

		this.worktreeNavigationHistory = [
			...sortProjectSwitcherNavigationHistory([
				...visitedTargets,
				...retainedTargets,
			], selectionTargetsEqual),
			activeTarget,
		].slice(-PROJECT_SWITCHER_HISTORY_LIMIT);
		this.worktreeNavigationIndex =
			this.worktreeNavigationHistory.length - 1;
		this.updateNavigationContexts();
	}

	private getActiveSelectionTarget(): IProjectSwitcherSelectionTarget | undefined {
		const activeWorktreePath = this.getActiveWorktreePath();
		if (!activeWorktreePath) {
			return undefined;
		}

		for (const item of this.itemsById.values()) {
			if (
				isWorktreeItem(item) &&
				pathsEqual(item.worktreePath, activeWorktreePath)
			) {
				return {
					projectId: item.projectId,
					worktreePath: activeWorktreePath,
				};
			}
			if (isRetainedWorkbenchItem(item) &&
				pathsEqual(item.worktreePath, activeWorktreePath)
			) {
				return { worktreePath: activeWorktreePath };
			}
		}

		return undefined;
	}

	private updateNavigationContexts(): void {
		const canGoBack = this.worktreeNavigationIndex > 0;
		const canGoForward =
			this.worktreeNavigationIndex >= 0 &&
			this.worktreeNavigationIndex <
			this.worktreeNavigationHistory.length - 1;

		this.canGoBackContext.set(canGoBack);
		this.canGoForwardContext.set(canGoForward);
		if (this.environmentService.isOmniWindow) {
			void this.shellService.setProjectSwitcherNavigationState(
				this.windowId,
				canGoBack,
				canGoForward
			);
		}
	}

	saveState(): void {
		this.captureTreeExpansionState();
		const state: IProjectSwitcherViewState = {
			version: PROJECT_SWITCHER_VIEW_STATE_VERSION,
			collapsedProjectIds: [...this.collapsedProjectIds].sort(),
			collapsedOmniSections: [...this.collapsedOmniSections].sort(),
			omniSectionOrder: [...this.omniSectionOrder],
		};
		this.storageService.store(
			PROJECT_SWITCHER_VIEW_STATE_STORAGE_KEY,
			JSON.stringify(state),
			this.viewStateStorageScope,
			StorageTarget.MACHINE
		);
	}

	private loadViewState(): void {
		let rawState = this.storageService.get(
			PROJECT_SWITCHER_VIEW_STATE_STORAGE_KEY,
			this.viewStateStorageScope
		);
		let migratedScope = false;
		if (!rawState && this.environmentService.isOmniWindow) {
			rawState = this.storageService.get(
				PROJECT_SWITCHER_VIEW_STATE_STORAGE_KEY,
				StorageScope.PROFILE
			);
			migratedScope = !!rawState;
		}
		const parsed = parseProjectSwitcherViewState(rawState);
		if (!parsed) {
			this.collapsedProjectIds.clear();
			this.collapsedOmniSections.clear();
			this.omniSectionOrder = [
				...DEFAULT_PROJECT_SWITCHER_OMNI_SECTION_ORDER,
			];
			return;
		}
		this.collapsedProjectIds = new Set(parsed.state.collapsedProjectIds);
		this.collapsedOmniSections = new Set(
			parsed.state.collapsedOmniSections
		);
		this.omniSectionOrder = [...parsed.state.omniSectionOrder];
		if (migratedScope || parsed.migrated) {
			this.saveState();
		}
	}

	private captureTreeExpansionState(): void {
		if (!this.tree) {
			return;
		}

		for (const item of this.itemsById.values()) {
			if (isOmniSectionItem(item)) {
				continue;
			}
			if (!isProjectItem(item)) {
				continue;
			}

			this.setProjectCollapsed(item, this.tree.isCollapsed(item));
		}
	}

	private setProjectCollapsed(
		item: ProjectSwitcherProjectItem,
		collapsed: boolean
	): void {
		if (collapsed) {
			this.collapsedProjectIds.delete(item.projectId);
			this.collapsedProjectIds.add(item.id);
			return;
		}

		this.collapsedProjectIds.delete(item.id);
		this.collapsedProjectIds.delete(item.projectId);
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
				when: IsOmniWindowContext.toNegated(),
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const projectManagerService = accessor.get(IProjectManagerService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const shellService = accessor.get(IHucodeShellService);
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

			const project = await projectManagerService.addProject(folder[0]);
			if (environmentService.isOmniWindow) {
				await shellService.reconcileRetainedWorkbenches(
					dom.getWindowId(mainWindow),
					project.worktrees.map(worktree => ({
						projectId: project.id,
						folderUri: URI.file(worktree.path).toJSON(),
					}))
				);
			}
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ADD_WORKBENCH_COMMAND_ID,
			title: localize2('addWorkbench', 'Add Workbench'),
			icon: Codicon.add,
			precondition: IsOmniWindowContext,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const shellService = accessor.get(IHucodeShellService);
		const projectManagerService = accessor.get(IProjectManagerService);
		const notificationService = accessor.get(INotificationService);
		try {
			const folder = await fileDialogService.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: localize('addWorkbenchOpenLabel', 'Add Workbench'),
				title: localize('addWorkbenchTitle', 'Open Folder as Workbench'),
			});
			if (!folder?.length) {
				return;
			}
			const uri = folder[0];
			const target = canonicalizeProjectSwitcherTarget(
				{ worktreePath: uri.fsPath },
				await projectManagerService.getProjects(),
				pathsEqual
			);
			await setLastActiveWorktreeBestEffort(
				projectManagerService,
				target.projectId,
				target.worktreePath
			);
			if (await shellService.focusHostedWorkspaceByPath(
				target.worktreePath,
				target.projectId
			) || await shellService.focusNormalWindowByPath(target.worktreePath)
			) {
				return;
			}
			const windowId = dom.getWindowId(mainWindow);
			if (target.projectId) {
				await shellService.openWorkspace(
					windowId,
					target.worktreePath,
					target.projectId
				);
			} else {
				await shellService.retainAndOpenWorkbench(windowId, uri.toJSON());
			}
			await shellService.focusWorkspace(windowId);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_WORKBENCH_COMMAND_ID,
			title: localize2('openRetainedWorkbench', 'Open Workbench'),
		});
	}

	async run(
		accessor: ServicesAccessor,
		handle: TreeViewItemHandleArg
	): Promise<void> {
		const workbenchId = parseWorkbenchHandle(handle.$treeItemHandle);
		if (!workbenchId) {
			return;
		}
		const shellService = accessor.get(IHucodeShellService);
		const projectManagerService = accessor.get(IProjectManagerService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const hostService = accessor.get(IHostService);
		const state = await shellService.getWindowState(
			dom.getWindowId(mainWindow)
		);
		const record = state.retainedWorkbenches?.find(candidate =>
			candidate.id === workbenchId
		);
		if (record) {
			await openProjectSwitcherTarget(
				{ worktreePath: URI.revive(record.folderUri).fsPath },
				projectManagerService,
				environmentService,
				shellService,
				hostService
			);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: UNLOAD_WORKBENCH_COMMAND_ID,
			title: localize2('unloadRetainedWorkbench', 'Unload Workbench'),
		});
	}

	run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<unknown> {
		const id = parseWorkbenchHandle(handle.$treeItemHandle);
		return id
			? accessor.get(IHucodeShellService).unloadRetainedWorkbench(
				dom.getWindowId(mainWindow),
				id
			)
			: Promise.resolve();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DISMISS_WORKBENCH_COMMAND_ID,
			title: localize2('dismissRetainedWorkbench', 'Dismiss Workbench'),
		});
	}

	run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<unknown> {
		const id = parseWorkbenchHandle(handle.$treeItemHandle);
		return id
			? accessor.get(IHucodeShellService).dismissRetainedWorkbench(
				dom.getWindowId(mainWindow),
				id
			)
			: Promise.resolve();
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
			id: GO_BACK_WORKTREE_COMMAND_ID,
			title: localize2('goBackWorktree', 'Go Back Workbench'),
			icon: Codicon.arrowLeft,
			precondition: ProjectSwitcherCanGoBackContext,
			menu: {
				id: Menus.SidebarTitleNavigation,
				group: 'navigation',
				order: 1,
			},
			f1: true,
		});
	}

	async run(): Promise<void> {
		await currentProjectSwitcherWidget?.goBack();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: GO_FORWARD_WORKTREE_COMMAND_ID,
			title: localize2('goForwardWorktree', 'Go Forward Workbench'),
			icon: Codicon.arrowRight,
			precondition: ProjectSwitcherCanGoForwardContext,
			menu: {
				id: Menus.SidebarTitleNavigation,
				group: 'navigation',
				order: 2,
			},
			f1: true,
		});
	}

	async run(): Promise<void> {
		await currentProjectSwitcherWidget?.goForward();
	}
});

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
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const shellService = accessor.get(IHucodeShellService);
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

			await openProjectSwitcherTarget(
				{ projectId: project.id, worktreePath: worktree.path },
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
			id: OPEN_WORKTREE_COMMAND_ID,
			title: localize2('openWorktree', 'Open Worktree'),
		});
	}

	async run(
		accessor: ServicesAccessor,
		worktreePath: string | TreeViewItemHandleArg
	): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const shellService = accessor.get(IHucodeShellService);
		const hostService = accessor.get(IHostService);
		const notificationService = accessor.get(INotificationService);

		try {
			const resolvedWorktreePath = typeof worktreePath === 'string'
				? worktreePath
				: parseWorktreeHandle(worktreePath.$treeItemHandle)?.worktreePath;
			if (!resolvedWorktreePath) {
				return;
			}

			const projects = await projectManagerService.getProjects();
			const project = projects.find(project =>
				project.worktrees.some(worktree =>
					pathsEqual(worktree.path, resolvedWorktreePath)
				)
			);
			const worktree = project?.worktrees.find(worktree =>
				pathsEqual(worktree.path, resolvedWorktreePath)
			);
			if (!project || !worktree) {
				await hostService.openWindow(
					[{ folderUri: URI.file(resolvedWorktreePath) }],
					{ forceNewWindow: true }
				);
				return;
			}

			await openProjectSwitcherTarget(
				{ projectId: project.id, worktreePath: worktree.path },
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
			id: RESET_PROJECT_LABEL_COMMAND_ID,
			title: localize2('resetProjectLabel', 'Reset Project Name'),
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const notificationService = accessor.get(INotificationService);

		try {
			const projectId = parseProjectHandle(handle.$treeItemHandle);
			if (!projectId) {
				return;
			}

			await projectManagerService.resetProjectLabel(projectId);
		} catch (error) {
			notificationService.error(String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: RESET_WORKTREE_LABEL_COMMAND_ID,
			title: localize2('resetWorktreeLabel', 'Reset Worktree Name'),
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const projectManagerService = accessor.get(IProjectManagerService);
		const notificationService = accessor.get(INotificationService);

		try {
			const parsed = parseWorktreeHandle(handle.$treeItemHandle);
			if (!parsed) {
				return;
			}

			await projectManagerService.resetWorktreeLabel(
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
			id: PIN_WORKTREE_COMMAND_ID,
			title: localize2('pinWorktree', 'Pin Worktree'),
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const parsed = parseWorktreeHandle(handle.$treeItemHandle);
		if (!parsed) {
			return;
		}

		await accessor.get(IProjectManagerService).setWorktreePinned(
			parsed.projectId,
			parsed.worktreePath,
			true
		);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: UNPIN_WORKTREE_COMMAND_ID,
			title: localize2('unpinWorktree', 'Unpin Worktree'),
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const parsed = parseWorktreeHandle(handle.$treeItemHandle);
		if (!parsed) {
			return;
		}

		await accessor.get(IProjectManagerService).setWorktreePinned(
			parsed.projectId,
			parsed.worktreePath,
			false
		);
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
