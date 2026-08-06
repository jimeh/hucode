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
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { ICommandService } from
	'../../../../platform/commands/common/commands.js';
import { IConfigurationChangeEvent, IConfigurationService } from
	'../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from
	'../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from
	'../../../../platform/notification/common/notification.js';
import { WorkbenchObjectTree } from
	'../../../../platform/list/browser/listService.js';
import {
	GitWorktreeTargetChange,
	IProjectManagerService,
	ProjectRecord,
	WorktreeRecord,
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
} from '../../../common/omniWindow.js';
import { IHucodeShellControllerService } from
	'../../../../platform/window/common/hucodeShellControllerService.js';
import { IHucodeRetainedWorkbench } from
	'../../../common/retainedWorkbench.js';
import {
	PROJECTS_SECTION_HANDLE,
	ProjectSwitcherItem,
	ProjectSwitcherProjectItem,
	ProjectSwitcherSectionItem,
	ProjectSwitcherWorkbenchItem,
	ProjectSwitcherWorktreeItem,
} from '../../../common/projectSwitcher/projectSwitcherTreeModel.js';
import {
	ProjectSwitcherAccessibilityProvider,
	ProjectSwitcherDragAndDrop,
	getProjectSwitcherItemHeight,
	ProjectSwitcherRenderer,
	ProjectSwitcherWidget,
} from
	'../../../browser/projectSwitcher/projectSwitcher.contribution.js';
import {
	getActiveWorkbenchWorktreePath,
	getOmniHostedWorkspaceState,
} from
	'../../../browser/projectSwitcher/switchProjectWorktree.contribution.js';

suite('ProjectSwitcherContribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('uses Modern UI pane-header height only for Omni sections', () => {
		const section: ProjectSwitcherSectionItem = {
			id: PROJECTS_SECTION_HANDLE,
			handle: PROJECTS_SECTION_HANDLE,
			kind: 'section',
			sectionKind: 'projects',
			label: 'Projects',
			contextValue: 'hucode-omni-section',
		};
		const workbench = retainedWorkbenchItem();

		assert.deepStrictEqual({
			classicSection: getProjectSwitcherItemHeight(
				section,
				'compact',
				false
			),
			modernSection: getProjectSwitcherItemHeight(
				section,
				'compact',
				true
			),
			modernCompactItem: getProjectSwitcherItemHeight(
				workbench,
				'compact',
				true
			),
			modernTwoLineItem: getProjectSwitcherItemHeight(
				workbench,
				'twoLine',
				true
			),
		}, {
			classicSection: 22,
			modernSection: 28,
			modernCompactItem: 22,
			modernTwoLineItem: 44,
		});
	});

	test('keeps complete project catalog reconciliation in the shell',
		async () => {
			const calls: string[] = [];
			const reconciled = hostedState('reconciled');
			const shellService = {
				async reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
				) {
					calls.push('reconcile');
					return reconciled;
				},
			} as unknown as IHucodeShellControllerService;

			const fromHosted = await getOmniHostedWorkspaceState(
				{
					isOmniWindow: true,
					isHostedOmniWorkspace: true,
					isOmniShellWindow: true,
				} as IWorkbenchEnvironmentService,
				shellService,
				[projectRecord()]
			);
			const fromShell = await getOmniHostedWorkspaceState(
				{
					isOmniWindow: true,
					isHostedOmniWorkspace: false,
					isOmniShellWindow: true,
				} as IWorkbenchEnvironmentService,
				shellService,
				[projectRecord()]
			);
			const fromUntrustedWindow = await getOmniHostedWorkspaceState(
				{
					isOmniWindow: true,
					isHostedOmniWorkspace: false,
					isOmniShellWindow: false,
				} as IWorkbenchEnvironmentService,
				shellService,
				[projectRecord()]
			);

			assert.deepStrictEqual({
				calls,
				fromHosted: fromHosted?.activeInstanceId,
				fromShell: fromShell?.activeInstanceId,
				fromUntrustedWindow,
			}, {
				calls: ['reconcile'],
				fromHosted: undefined,
				fromShell: 'reconciled',
				fromUntrustedWindow: undefined,
			});
		});

	test('resolves the active hosted web workbench from workspace context',
		async () => {
			const activePath = await getActiveWorkbenchWorktreePath(
				{
					isOmniWindow: true,
					isHostedOmniWorkspace: true,
					isOmniShellWindow: false,
				} as IWorkbenchEnvironmentService,
				{
					getWorkbenchState: () => WorkbenchState.FOLDER,
					getWorkspace: () => ({
						id: 'hosted',
						folders: [{
							uri: URI.parse('vscode-remote://host/repo'),
						}],
					}),
				} as unknown as IWorkspaceContextService,
				{
					async getState() {
						return {
							activeInstanceId: 'active',
							instances: [{
								instanceId: 'active',
								worktreePath: '/shell-repo',
								state: 'active',
							}],
						};
					},
				} as unknown as IHucodeShellControllerService
			);

			assert.strictEqual(activePath, '/repo');
		});

	test('ignores an untrusted Omni flag in a standalone web workbench',
		async () => {
			const activePath = await getActiveWorkbenchWorktreePath(
				{
					isOmniWindow: true,
					isHostedOmniWorkspace: false,
					isOmniShellWindow: false,
				} as IWorkbenchEnvironmentService,
				{
					getWorkbenchState: () => WorkbenchState.FOLDER,
					getWorkspace: () => ({
						id: 'standalone',
						folders: [{ uri: URI.file('/standalone') }],
					}),
				} as unknown as IWorkspaceContextService,
				undefined
			);

			assert.strictEqual(activePath, '/standalone');
		});

	test('recycled rows clear active ARIA and actions before rendering a section', () => {
		const commands: Array<{ id: string; args: readonly unknown[] }> = [];
		const renderer = new ProjectSwitcherRenderer(
			() => 'compact',
			() => true,
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

	test('renders independent name branch and path fields in source order', () => {
		let layout: 'compact' | 'twoLine' = 'compact';
		const renderer = new ProjectSwitcherRenderer(
			() => layout,
			() => true,
			{ executeCommand: async () => undefined } as unknown as ICommandService
		);
		const container = mainWindow.document.createElement('div');
		const template = renderer.renderTemplate(container);
		const item = worktreeItem({
			name: 'Feature',
			branch: 'feature/topic',
			path: '/repo.worktrees/feature',
		});

		renderer.renderElement(treeNode(item), 0, template);
		const compact = Array.from(template.text.children).map(element => ({
			className: element.className,
			text: element.textContent,
			display: (element as HTMLElement).style.display,
		}));
		layout = 'twoLine';
		renderer.renderElement(treeNode(item), 0, template);
		const twoLine = {
			branch: template.description.textContent,
			branchDisplay: template.description.style.display,
			path: template.path.textContent,
			pathDisplay: template.path.style.display,
		};

		assert.deepStrictEqual({
			compact,
			twoLine,
			twoLineClass: template.container.classList.contains(
				'hucode-project-switcher-two-line'
			),
			hasBranch: template.container.classList.contains(
				'hucode-project-switcher-has-branch'
			),
			hasPath: template.container.classList.contains(
				'hucode-project-switcher-has-path'
			),
		}, {
			compact: [{
				className: 'hucode-project-switcher-label',
				text: 'Feature',
				display: '',
			}, {
				className: 'hucode-project-switcher-description',
				text: 'feature/topic',
				display: '',
			}, {
				className: 'hucode-project-switcher-path',
				text: '',
				display: 'none',
			}],
			twoLine: {
				branch: 'feature/topic',
				branchDisplay: '',
				path: '/repo.worktrees/feature',
				pathDisplay: '',
			},
			twoLineClass: true,
			hasBranch: true,
			hasPath: true,
		});
		renderer.disposeTemplate(template);
	});

	test('toggles inline metadata icons without decorating project paths', () => {
		let showInlineIcons = true;
		const renderer = new ProjectSwitcherRenderer(
			() => 'twoLine',
			() => showInlineIcons,
			{ executeCommand: async () => undefined } as unknown as ICommandService
		);
		const container = mainWindow.document.createElement('div');
		const template = renderer.renderTemplate(container);

		renderer.renderElement(treeNode(worktreeItem({
			name: 'Feature',
			branch: 'feature/topic',
			path: '/repo.worktrees/feature',
		})), 0, template);
		const worktree = {
			branch: template.description.textContent,
			path: template.path.textContent,
			branchIcon: !!template.description.querySelector(
				'.codicon-git-branch-compact'
			),
			pathIcon: !!template.path.querySelector('.codicon-folder-compact'),
		};

		renderer.renderElement(treeNode(retainedWorkbenchItem({
			name: 'Scratch',
			branch: 'topic',
			path: '/scratch/repo',
		})), 0, template);
		const workbench = {
			name: template.label.textContent,
			branch: template.description.textContent,
			path: template.path.textContent,
			branchIcon: !!template.description.querySelector(
				'.codicon-git-branch-compact'
			),
			pathIcon: !!template.path.querySelector('.codicon-folder-compact'),
			workbenchClass: template.container.classList.contains(
				'hucode-project-switcher-workbench'
			),
		};

		showInlineIcons = false;
		renderer.renderElement(treeNode(worktreeItem({
			name: 'Feature',
			branch: 'feature/topic',
			path: '/repo.worktrees/feature',
		})), 0, template);
		const hiddenIcons = {
			branch: template.descriptionIcon.style.display,
			path: template.pathIcon.style.display,
		};

		renderer.renderElement(treeNode(projectItem({
			description: '/projects',
		})), 0, template);

		assert.deepStrictEqual({
			worktree,
			workbench,
			hiddenIcons,
			projectDescription: template.description.textContent,
			projectDescriptionIcon: !!template.description.querySelector(
				'.codicon-folder'
			),
		}, {
			worktree: {
				branch: 'feature/topic',
				path: '/repo.worktrees/feature',
				branchIcon: true,
				pathIcon: true,
			},
			workbench: {
				name: 'Scratch',
				branch: 'topic',
				path: '/scratch/repo',
				branchIcon: true,
				pathIcon: true,
				workbenchClass: true,
			},
			hiddenIcons: {
				branch: 'none',
				path: 'none',
			},
			projectDescription: '/projects',
			projectDescriptionIcon: false,
		});
		renderer.disposeTemplate(template);
	});

	test('renders retained lifecycle states in accessible labels', () => {
		const provider = new ProjectSwitcherAccessibilityProvider();
		const labels = ([
			'restore-pending',
			'loading',
			'active',
			'loaded',
			'dormant',
			'crashed',
			'missing',
			'unloaded',
		] as const).map(state => provider.getAriaLabel(
			retainedWorkbenchItem({ hostedWorkbenchState: state })
		));

		assert.deepStrictEqual(labels, [
			'Scratch, /scratch, Loading',
			'Scratch, /scratch, Loading',
			'Scratch, /scratch, Active',
			'Scratch, /scratch, Loaded',
			'Scratch, /scratch, Dormant',
			'Scratch, /scratch, Crashed',
			'Scratch, /scratch, Folder missing',
			'Scratch, /scratch, Unloaded',
		]);
	});

	test('omits redundant branches from accessible row labels', () => {
		const provider = new ProjectSwitcherAccessibilityProvider();

		assert.deepStrictEqual({
			workbench: provider.getAriaLabel(retainedWorkbenchItem({
				name: 'topic',
				branch: 'topic',
				path: '/workbenches/topic',
			})),
			worktree: provider.getAriaLabel(worktreeItem({
				name: 'topic',
				branch: 'topic',
				path: '/repo.worktrees/topic',
			})),
			distinctBranch: provider.getAriaLabel(worktreeItem({
				name: 'Topic label',
				branch: 'topic',
				path: '/repo.worktrees/topic',
			})),
		}, {
			workbench: 'topic, /workbenches/topic, Unloaded',
			worktree: 'topic, /repo.worktrees/topic',
			distinctBranch: 'Topic label, topic, /repo.worktrees/topic',
		});
	});

	test('keeps configured worktree paths out of non-Omni rows', () => {
		const linkedPath = '/repo.worktrees/feature';
		const host = prototypeHost(ProjectSwitcherWidget.prototype, {
			collapsedProjectIds: new Set<string>(),
			collapsedOmniSections: new Set<string>(),
			omniSectionOrder: ['workbenches', 'projects'],
			gitWorktreeObservations: [],
			environmentService: { isOmniWindow: false },
			omniHostedWorkspaceState: hostedState(),
			configurationService: { getValue: () => true },
			getPathLabel: (path: string) => path,
			getActiveWorktreePath: () => undefined,
		});
		const buildRoots = Reflect.get(
			ProjectSwitcherWidget.prototype,
			'buildRoots'
		) as (this: object, projects: readonly ProjectRecord[]) => {
			readonly itemsById: Map<string, ProjectSwitcherItem>;
		};
		const model = buildRoots.call(host, [{
			id: 'project-1',
			label: 'repo',
			rootUri: URI.file('/repo'),
			pinned: false,
			order: 1,
			worktreeState: 'current',
			worktrees: [{
				path: linkedPath,
				label: 'feature',
				branch: 'feature',
				isMain: false,
				isDetached: false,
			}],
		}] as readonly ProjectRecord[]);
		const worktree = [...model.itemsById.values()].find(item =>
			item.kind === 'worktree'
		) as ProjectSwitcherWorktreeItem;

		assert.strictEqual(worktree.path, undefined);
	});

	test('logs decorative Git monitor failures without a user toast',
		async () => {
			const warnings: unknown[] = [];
			const errors: unknown[] = [];
			const host = prototypeHost(ProjectSwitcherWidget.prototype, {
				gitMonitorGeneration: 0,
				gitMonitorConsumerId: 'project-switcher:window:1',
				projectManagerService: {
					setGitWorktreeTargets: async () => {
						throw new Error('monitor unavailable');
					},
				},
				logService: { warn: (error: unknown) => warnings.push(error) },
				notificationService: {
					error: (error: unknown) => errors.push(error),
				},
				gitWorktreeObservations: [],
				projects: [],
				renderProjects: () => undefined,
			});
			const updateTargets = Reflect.get(
				ProjectSwitcherWidget.prototype,
				'updateGitWorktreeTargets'
			) as (this: object, state: IHucodeHostedWorkspaceState) => Promise<void>;

			await updateTargets.call(host, {
				...hostedState(),
				retainedWorkbenches: [retainedRecord('scratch', '/scratch', 0)],
			});

			assert.strictEqual(errors.length, 0);
			assert.strictEqual(warnings.length, 1);
			assert.match(String(warnings[0]), /monitor unavailable/);
		});

	test('bounds decorative Git monitoring without dropping the request',
		async () => {
			const warnings: unknown[] = [];
			let targetPaths: readonly string[] = [];
			const host = prototypeHost(ProjectSwitcherWidget.prototype, {
				gitMonitorGeneration: 0,
				gitMonitorConsumerId: 'project-switcher:window:1',
				projectManagerService: {
					setGitWorktreeTargets: async (
						_consumerId: string,
						paths: readonly string[]
					) => {
						targetPaths = paths;
						return [];
					},
				},
				logService: { warn: (warning: unknown) => warnings.push(warning) },
				gitWorktreeObservations: [],
				projects: [],
				renderProjects: () => undefined,
			});
			const updateTargets = Reflect.get(
				ProjectSwitcherWidget.prototype,
				'updateGitWorktreeTargets'
			) as (
				this: object,
				state: IHucodeHostedWorkspaceState
			) => Promise<void>;

			await updateTargets.call(host, {
				...hostedState(),
				retainedWorkbenches: Array.from(
					{ length: 129 },
					(_, index) => retainedRecord(
						`workbench-${index}`,
						`/workbench-${index}`,
						index
					)
				),
			});

			assert.strictEqual(targetPaths.length, 128);
			assert.deepStrictEqual(warnings, [
				'[ProjectSwitcher] Monitoring the first 128 of 129 arbitrary ' +
				'workbenches for Git metadata.',
			]);
		});

	test('render wires the live tree services and initial empty state', async () => {
		const projectChanges = disposables.add(
			new Emitter<readonly ProjectRecord[]>()
		);
		const gitChanges = disposables.add(new Emitter<{
			readonly consumerId: string;
			readonly observations: readonly [];
		}>());
		const workspaceFolderChanges = disposables.add(new Emitter<void>());
		const workspaceStateChanges = disposables.add(new Emitter<void>());
		const hostFocusChanges = disposables.add(new Emitter<boolean>());
		const shellStateChanges = disposables.add(
			new Emitter<IHucodeHostedWorkspaceState>()
		);
		const configurationChanges = disposables.add(
			new Emitter<IConfigurationChangeEvent>()
		);
		const commands: string[] = [];
		const clearedGitConsumers: string[] = [];
		const clearError = new Error('clear failed');
		const warnings: unknown[] = [];
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (event: PromiseRejectionEvent) => {
			unhandledRejections.push(event.reason);
			event.preventDefault();
		};
		mainWindow.addEventListener('unhandledrejection', onUnhandledRejection);
		disposables.add(toDisposable(() => mainWindow.removeEventListener(
			'unhandledrejection',
			onUnhandledRejection
		)));
		const subscriptions: string[] = [];
		const treeLayouts: Array<{ height: number; width: number }> = [];
		let treeOptions: {
			readonly accessibilityProvider: {
				getWidgetAriaLabel(): string;
			};
			readonly dnd: ProjectSwitcherDragAndDrop;
		} | undefined;
		let treeDelegate: {
			getHeight(item: ProjectSwitcherItem): number;
		} | undefined;
		let showInlineIcons: (() => boolean) | undefined;
		let renderers: readonly ProjectSwitcherRenderer[] = [];
		const tree = {
			contextKeyService: {
				createKey: () => ({ set: () => undefined }),
			},
			onDidChangeSelection: Event.None,
			onDidChangeFocus: Event.None,
			onDidChangeCollapseState: Event.None,
			onContextMenu: Event.None,
			onDidOpen: Event.None,
			setChildren: () => undefined,
			rerender: () => undefined,
			layout: (height: number, width: number) =>
				treeLayouts.push({ height, width }),
			getFocus: () => [],
			getSelection: () => [],
			dispose: () => undefined,
		};
		const commandService = {
			executeCommand: async (id: string) => {
				commands.push(id);
			},
		} as unknown as ICommandService;
		const instantiationService = {
			createInstance: (ctor: unknown, ...args: unknown[]) => {
				if (ctor === ProjectSwitcherRenderer) {
					showInlineIcons = args[1] as () => boolean;
					return new ProjectSwitcherRenderer(
						args[0] as (item: ProjectSwitcherItem) => 'compact',
						args[1] as () => boolean,
						commandService
					);
				}
				if (ctor === ProjectSwitcherDragAndDrop) {
					return new ProjectSwitcherDragAndDrop(
						args[0] as (
							source: 'workbenches' | 'projects',
							target: 'workbenches' | 'projects'
						) => void,
						args[1] as (
							target: ProjectSwitcherSectionItem,
							index: number
						) => number,
						{
							onDidChangeProjects: Event.None,
						} as unknown as IProjectManagerService,
						{} as unknown as INotificationService,
						{} as unknown as IHucodeShellControllerService
					);
				}
				if (ctor === WorkbenchObjectTree) {
					treeDelegate = args[2] as typeof treeDelegate;
					renderers = args[3] as readonly ProjectSwitcherRenderer[];
					treeOptions = args[4] as typeof treeOptions;
					return tree;
				}
				throw new Error('Unexpected render service');
			},
		};
		const container = mainWindow.document.createElement('div');
		const widget = disposables.add(new ProjectSwitcherWidget(
			instantiationService as never,
			{} as never,
			{
				createKey: () => ({ set: () => undefined }),
			} as unknown as IContextKeyService,
			{
				onDidChangeProjects: (
					listener: (projects: readonly ProjectRecord[]) => void
				) => {
					subscriptions.push('projects');
					return projectChanges.event(listener);
				},
				getProjects: () => new Promise<readonly ProjectRecord[]>(
					() => undefined
				),
				onDidChangeGitWorktreeTargets: (
					listener: (change: GitWorktreeTargetChange) => void
				) => {
					subscriptions.push('git-monitor');
					return gitChanges.event(listener);
				},
				setGitWorktreeTargets: async () => [],
				clearGitWorktreeTargets: async (consumerId: string) => {
					clearedGitConsumers.push(consumerId);
					throw clearError;
				},
			} as unknown as IProjectManagerService,
			{
				onDidChangeWorkspaceFolders: (listener: () => void) => {
					subscriptions.push('folders');
					return workspaceFolderChanges.event(listener);
				},
				onDidChangeWorkbenchState: (listener: () => void) => {
					subscriptions.push('workspace-state');
					return workspaceStateChanges.event(listener);
				},
				getWorkbenchState: () => WorkbenchState.EMPTY,
			} as unknown as IWorkspaceContextService,
			{} as unknown as INotificationService,
			commandService,
			{
				get: () => undefined,
				store: () => undefined,
			} as unknown as IStorageService,
			{ isOmniWindow: true } as IWorkbenchEnvironmentService,
			{
				onDidChangeState: (
					listener: (state: IHucodeHostedWorkspaceState) => void
				) => {
					subscriptions.push('shell-state');
					return shellStateChanges.event(listener);
				},
				setProjectSwitcherNavigationState: async () => undefined,
				setProjectSwitcherSectionOrder: async () => undefined,
				setHostedWorkbenchRestorePolicy: async () => undefined,
				getState: () =>
					new Promise<IHucodeHostedWorkspaceState>(() => undefined),
			} as unknown as IHucodeShellControllerService,
			{
				onDidChangeFocus: (listener: (focused: boolean) => void) => {
					subscriptions.push('focus');
					return hostFocusChanges.event(listener);
				},
			} as unknown as IHostService,
			{ getUriLabel: () => '' } as never,
			{
				onDidChangeConfiguration: (
					listener: (event: IConfigurationChangeEvent) => void
				) => {
					subscriptions.push('configuration');
					return configurationChanges.event(listener);
				},
				getValue: () => undefined,
			} as unknown as IConfigurationService,
			{ warn: (value: unknown) => warnings.push(value) } as never,
		));

		widget.render(container);
		widget.layout(420, 260);
		(container.querySelector(
			'.hucode-project-switcher-empty-button'
		) as HTMLButtonElement).click();

		assert.deepStrictEqual({
			containerClass: container.className,
			emptyMessage: container.querySelector(
				'.hucode-project-switcher-empty-message'
			)?.textContent,
			treeHidden: container.querySelector(
				'.hucode-project-switcher-tree'
			)?.classList.contains('hidden'),
			emptyHidden: container.querySelector(
				'.hucode-project-switcher-empty'
			)?.classList.contains('hidden'),
			treeRenderer: renderers[0] instanceof ProjectSwitcherRenderer,
			defaultWorkbenchHeight: treeDelegate?.getHeight(
				retainedWorkbenchItem()
			),
			defaultWorktreeHeight: treeDelegate?.getHeight(worktreeItem()),
			showInlineIcons: showInlineIcons?.(),
			treeDnd: treeOptions?.dnd instanceof ProjectSwitcherDragAndDrop,
			ariaLabel: treeOptions?.accessibilityProvider
				.getWidgetAriaLabel(),
			treeLayouts,
			commands,
		}, {
			containerClass: 'hucode-project-switcher-view',
			emptyMessage: 'No projects have been added yet.',
			treeHidden: true,
			emptyHidden: false,
			treeRenderer: true,
			defaultWorkbenchHeight: 44,
			defaultWorktreeHeight: 44,
			showInlineIcons: true,
			treeDnd: true,
			ariaLabel: 'Workbenches and Projects',
			treeLayouts: [{ height: 260, width: 420 }],
			commands: ['hucode.projectSwitcher.addProject'],
		});
		assert.deepStrictEqual(subscriptions.toSorted(), [
			'configuration',
			'configuration',
			'focus',
			'folders',
			'git-monitor',
			'projects',
			'shell-state',
			'workspace-state',
		]);
		const gitConsumerId = Reflect.get(widget, 'gitMonitorConsumerId');
		assert.strictEqual(
			gitConsumerId,
			`project-switcher:window:${getWindowId(mainWindow)}`
		);
		widget.dispose();
		await timeout(0);
		assert.deepStrictEqual(clearedGitConsumers, [gitConsumerId]);
		assert.deepStrictEqual(unhandledRejections, []);
		assert.strictEqual(warnings.length, 1);
		assert.match(String(warnings[0]), /clear failed/);
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

	test('moves a worktree before its drop target', async () => {
		const moves: Array<{
			projectId: string;
			source: string;
			before: string | undefined;
		}> = [];
		const source = worktreeItem();
		const target = worktreeItem({
			id: 'worktree:project-1:%2Frepo%2Fsibling',
			handle: 'worktree:project-1:%2Frepo%2Fsibling',
			worktreePath: '/repo/sibling',
			label: 'sibling',
		});
		const dragAndDrop = createDragAndDrop({
			projects: [projectRecord({
				worktrees: [
					worktreeRecord('/repo', 'repo', true),
					worktreeRecord(source.worktreePath, source.label),
					worktreeRecord(target.worktreePath, target.label),
				],
			})],
			moveWorktree: async (projectId, sourcePath, beforePath) => {
				moves.push({
					projectId,
					source: sourcePath,
					before: beforePath,
				});
			},
		});

		await dragAndDrop.drop(
			new ElementsDragAndDropData([source]),
			target,
			undefined,
			ListViewTargetSector.TOP,
			new DragEvent('drop')
		);

		assert.deepStrictEqual(moves, [{
			projectId: 'project-1',
			source: '/repo/feature',
			before: '/repo/sibling',
		}]);
	});

	test('moves a worktree after a middle drop target', async () => {
		const moves: Array<{
			projectId: string;
			source: string;
			before: string | undefined;
		}> = [];
		const source = worktreeItem();
		const target = worktreeItem({
			id: 'worktree:project-1:%2Frepo%2Fmiddle',
			handle: 'worktree:project-1:%2Frepo%2Fmiddle',
			worktreePath: '/repo/middle',
			label: 'middle',
		});
		const dragAndDrop = createDragAndDrop({
			projects: [projectRecord({
				worktrees: [
					worktreeRecord('/repo', 'repo', true),
					worktreeRecord(source.worktreePath, source.label),
					worktreeRecord(target.worktreePath, target.label),
					worktreeRecord('/repo/next', 'next'),
					worktreeRecord('/repo/last', 'last'),
				],
			})],
			moveWorktree: async (projectId, sourcePath, beforePath) => {
				moves.push({
					projectId,
					source: sourcePath,
					before: beforePath,
				});
			},
		});

		await dragAndDrop.drop(
			new ElementsDragAndDropData([source]),
			target,
			undefined,
			ListViewTargetSector.BOTTOM,
			new DragEvent('drop')
		);

		assert.deepStrictEqual(moves, [{
			projectId: 'project-1',
			source: '/repo/feature',
			before: '/repo/next',
		}]);
	});

	test('moves a worktree after the final drop target', async () => {
		const moves: Array<{
			projectId: string;
			source: string;
			before: string | undefined;
		}> = [];
		const source = worktreeItem();
		const target = worktreeItem({
			id: 'worktree:project-1:%2Frepo%2Flast',
			handle: 'worktree:project-1:%2Frepo%2Flast',
			worktreePath: '/repo/last',
			label: 'last',
		});
		const dragAndDrop = createDragAndDrop({
			projects: [projectRecord({
				worktrees: [
					worktreeRecord('/repo', 'repo', true),
					worktreeRecord(source.worktreePath, source.label),
					worktreeRecord('/repo/middle', 'middle'),
					worktreeRecord('/repo/next', 'next'),
					worktreeRecord(target.worktreePath, target.label),
				],
			})],
			moveWorktree: async (projectId, sourcePath, beforePath) => {
				moves.push({
					projectId,
					source: sourcePath,
					before: beforePath,
				});
			},
		});

		await dragAndDrop.drop(
			new ElementsDragAndDropData([source]),
			target,
			undefined,
			ListViewTargetSector.BOTTOM,
			new DragEvent('drop')
		);

		assert.deepStrictEqual(moves, [{
			projectId: 'project-1',
			source: '/repo/feature',
			before: undefined,
		}]);
	});

	test('splices a retained workbench around its target ordering', async () => {
		const reorderings: string[][] = [];
		const source = retainedWorkbenchItem({
			id: 'workbench:c',
			handle: 'workbench:c',
			retainedWorkbenchId: 'c',
			worktreePath: '/c',
			label: 'C',
			order: 2,
		});
		const target = retainedWorkbenchItem({
			id: 'workbench:a',
			handle: 'workbench:a',
			retainedWorkbenchId: 'a',
			worktreePath: '/a',
			label: 'A',
		});
		const dragAndDrop = createDragAndDrop({
			windowState: {
				...hostedState(),
				retainedWorkbenches: [
					retainedRecord('a', '/a', 0),
					retainedRecord('b', '/b', 1),
					retainedRecord('c', '/c', 2),
				],
			},
			reorderRetainedWorkbenches: async ids => {
				reorderings.push([...ids]);
			},
		});

		await dragAndDrop.drop(
			new ElementsDragAndDropData([source]),
			target,
			undefined,
			ListViewTargetSector.TOP,
			new DragEvent('drop')
		);

		await dragAndDrop.drop(
			new ElementsDragAndDropData([source]),
			target,
			undefined,
			ListViewTargetSector.BOTTOM,
			new DragEvent('drop')
		);

		assert.deepStrictEqual(reorderings, [
			['c', 'a', 'b'],
			['a', 'c', 'b'],
		]);
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

	test('persists user project collapse changes outside tree synchronization', () => {
		const collapsedProjectIds = new Set<string>();
		const savedStates: string[][] = [];
		const host = prototypeHost(ProjectSwitcherWidget.prototype, {
			collapsedProjectIds,
			isSynchronizingTree: true,
			saveState: () => savedStates.push([...collapsedProjectIds]),
		}) as unknown as {
			isSynchronizingTree: boolean;
			handleProjectCollapseChange(
				item: ProjectSwitcherProjectItem,
				collapsed: boolean
			): void;
		};
		const project = projectItem();

		host.handleProjectCollapseChange(project, true);
		host.isSynchronizingTree = false;
		host.handleProjectCollapseChange(project, true);
		host.handleProjectCollapseChange(project, true);
		host.handleProjectCollapseChange(project, false);

		assert.deepStrictEqual(savedStates, [
			[project.id],
			[],
		]);
	});

	test('keeps the active worktree hidden under a collapsed project', async () => {
		const selected: ProjectSwitcherItem[][] = [];
		const focused: ProjectSwitcherItem[][] = [];
		let reveals = 0;
		const project = projectItem();
		const current = worktreeItem({ isActive: true });
		const itemsById = new Map<string, ProjectSwitcherItem>([
			[project.id, project],
			[current.id, current],
		]);
		const host = prototypeHost(ProjectSwitcherWidget.prototype, {
			itemsById,
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
				isCollapsed: (item: ProjectSwitcherItem) => item === project,
				reveal: async () => { reveals++; },
				setSelection: (items: ProjectSwitcherItem[]) =>
					selected.push(items),
				setFocus: (items: ProjectSwitcherItem[]) => focused.push(items),
			},
			viewItemContext: { set: () => undefined },
		}) as unknown as {
			updateCurrentWorktreeSelection(): Promise<void>;
		};

		await host.updateCurrentWorktreeSelection();

		assert.deepStrictEqual({ reveals, selected, focused }, {
			reveals: 0,
			selected: [[current]],
			focused: [[current]],
		});
	});

	test('reveals the active worktree outside the Omni shell', async () => {
		const expanded: ProjectSwitcherItem[] = [];
		const revealed: ProjectSwitcherItem[] = [];
		const project = projectItem();
		const current = worktreeItem({ isActive: true });
		const collapsedProjectIds = new Set([project.id]);
		const host = prototypeHost(ProjectSwitcherWidget.prototype, {
			itemsById: new Map<string, ProjectSwitcherItem>([
				[project.id, project],
				[current.id, current],
			]),
			collapsedProjectIds,
			collapsedOmniSections: new Set<string>(),
			environmentService: { isOmniWindow: false },
			getActiveWorktreePath: () => current.worktreePath,
			tree: {
				hasElement: () => true,
				expand: (item: ProjectSwitcherItem) => expanded.push(item),
				reveal: async (item: ProjectSwitcherItem) => {
					revealed.push(item);
				},
				setSelection: () => undefined,
				setFocus: () => undefined,
			},
			viewItemContext: { set: () => undefined },
		}) as unknown as {
			updateCurrentWorktreeSelection(): Promise<void>;
		};

		await host.updateCurrentWorktreeSelection();

		assert.deepStrictEqual({
			expanded,
			revealed,
			collapsedProjectIds: [...collapsedProjectIds],
		}, {
			expanded: [project],
			revealed: [current],
			collapsedProjectIds: [],
		});
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
		const contexts: Array<{
			readonly key: 'back' | 'forward';
			readonly value: boolean;
		}> = [];
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
					contexts.push({ key: 'back', value: back });
				},
			},
			canGoForwardContext: {
				set: (forward: boolean) => {
					contexts.push({ key: 'forward', value: forward });
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
			contexts: [
				{ key: 'back', value: true },
				{ key: 'forward', value: false },
			],
		});
	});

	test('advances history after a successful navigation', async () => {
		const opens: string[] = [];
		const contexts: Array<{
			readonly key: 'back' | 'forward';
			readonly value: boolean;
		}> = [];
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
				openWindow: async (
					openables: readonly { folderUri?: URI }[]
				) => {
					opens.push(openables[0].folderUri?.fsPath ?? '');
				},
			},
			notificationService: {
				error: () => {
					throw new Error('unexpected navigation error');
				},
			},
			canGoBackContext: {
				set: (back: boolean) => {
					contexts.push({ key: 'back', value: back });
				},
			},
			canGoForwardContext: {
				set: (forward: boolean) => {
					contexts.push({ key: 'forward', value: forward });
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
			opens,
			contexts,
		}, {
			index: 0,
			navigating: false,
			opens: ['/repo/previous'],
			contexts: [
				{ key: 'back', value: false },
				{ key: 'forward', value: true },
			],
		});
	});

	test('seeds deduplicated history by recency before the active target', () => {
		const project = projectRecord({
			worktrees: [
				worktreeRecord('/repo/previous', 'previous', false, 10),
				worktreeRecord('/repo/current', 'current', true, 20),
			],
		});
		const host = prototypeHost(ProjectSwitcherWidget.prototype, {
			hasSeededNavigationHistory: false,
			worktreeNavigationHistory: [],
			worktreeNavigationIndex: -1,
			omniHostedWorkspaceState: {
				...hostedState(),
				retainedWorkbenches: [
					retainedRecord('scratch', '/scratch', 0, 12),
					retainedRecord('duplicate', '/repo/previous', 1, 15),
				],
			},
			canGoBackContext: { set: () => undefined },
			canGoForwardContext: { set: () => undefined },
			environmentService: { isOmniWindow: false },
		});
		const seedHistory = Reflect.get(
			ProjectSwitcherWidget.prototype,
			'seedNavigationHistory'
		) as (
			this: object,
			projects: readonly ProjectRecord[],
			activeTarget: { projectId?: string; worktreePath: string }
		) => void;

		seedHistory.call(host, [project], {
			projectId: 'project-1',
			worktreePath: '/repo/current',
		});

		assert.deepStrictEqual({
			seeded: Reflect.get(host, 'hasSeededNavigationHistory'),
			history: Reflect.get(host, 'worktreeNavigationHistory'),
			index: Reflect.get(host, 'worktreeNavigationIndex'),
		}, {
			seeded: true,
			history: [
				{ projectId: undefined, worktreePath: '/scratch' },
				{
					projectId: 'project-1',
					worktreePath: '/repo/previous',
				},
				{
					projectId: 'project-1',
					worktreePath: '/repo/current',
				},
			],
			index: 2,
		});
	});

	test('deduplicates active history entries while enforcing its limit', () => {
		const history = Array.from({ length: 100 }, (_value, index) => ({
			worktreePath: `/old-${index}`,
		}));
		const host = prototypeHost(ProjectSwitcherWidget.prototype, {
			isNavigatingWorktreeHistory: false,
			hasSeededNavigationHistory: true,
			worktreeNavigationHistory: history,
			worktreeNavigationIndex: history.length - 1,
			getActiveSelectionTarget: () => ({ worktreePath: '/new' }),
			canGoBackContext: { set: () => undefined },
			canGoForwardContext: { set: () => undefined },
			environmentService: { isOmniWindow: false },
		});
		const recordHistory = Reflect.get(
			ProjectSwitcherWidget.prototype,
			'recordActiveWorktree'
		) as (this: object, projects: readonly ProjectRecord[]) => void;

		recordHistory.call(host, []);
		recordHistory.call(host, []);
		const recorded = Reflect.get(
			host,
			'worktreeNavigationHistory'
		) as Array<{ worktreePath: string }>;

		assert.deepStrictEqual({
			length: recorded.length,
			first: recorded[0],
			last: recorded.at(-1),
			index: Reflect.get(host, 'worktreeNavigationIndex'),
			newCount: recorded.filter(entry =>
				entry.worktreePath === '/new'
			).length,
		}, {
			length: 100,
			first: { worktreePath: '/old-1' },
			last: { worktreePath: '/new' },
			index: 99,
			newCount: 1,
		});
	});

	test('applies state notifications from the bound shell controller', () => {
		let fireState:
			| ((state: IHucodeHostedWorkspaceState) => void)
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
				onDidChangeGitWorktreeTargets: Event.None,
				setGitWorktreeTargets: async () => [],
				clearGitWorktreeTargets: async () => undefined,
			} as unknown as IProjectManagerService,
			{
				onDidChangeWorkspaceFolders: Event.None,
				onDidChangeWorkbenchState: Event.None,
				getWorkbenchState: () => WorkbenchState.EMPTY,
			} as unknown as IWorkspaceContextService,
			{ error: () => undefined } as unknown as INotificationService,
			{} as unknown as ICommandService,
			{
				get: () => undefined,
				store: () => undefined,
			} as unknown as IStorageService,
			{ isOmniWindow: true } as IWorkbenchEnvironmentService,
			{
				onDidChangeState: (
					listener: (state: IHucodeHostedWorkspaceState) => void
				) => {
					fireState = listener;
					return { dispose: () => undefined };
				},
				setProjectSwitcherNavigationState: async () => undefined,
			} as unknown as IHucodeShellControllerService,
			{ onDidChangeFocus: Event.None } as unknown as IHostService,
			{} as never,
			{
				onDidChangeConfiguration: Event.None,
				getValue: () => undefined,
			} as unknown as IConfigurationService,
			{ warn: () => undefined } as never,
		));
		Reflect.set(widget, 'omniHostedWorkspaceState', initialState);

		fireState?.(hostedState('same'));

		assert.deepStrictEqual({
			afterSameWindow: (Reflect.get(
				widget,
				'omniHostedWorkspaceState'
			) as IHucodeHostedWorkspaceState).activeInstanceId,
		}, {
			afterSameWindow: 'same',
		});
	});

	test('keeps live shell state over a late initial snapshot', async () => {
		const snapshotReady = new DeferredPromise<IHucodeHostedWorkspaceState>();
		const liveState = hostedState('live');
		const appliedStates: IHucodeHostedWorkspaceState[] = [];
		const host = prototypeHost(ProjectSwitcherWidget.prototype, {
			omniSectionOrder: [],
			didReceiveOmniHostedWorkspaceStateChange: false,
			shellService: {
				setProjectSwitcherSectionOrder: async () => undefined,
				setHostedWorkbenchRestorePolicy: async () => undefined,
				getState: () => snapshotReady.p,
			},
			configurationService: { getValue: () => 'active' },
			updateOmniHostedWorkspaceState: (
				state: IHucodeHostedWorkspaceState
			) => appliedStates.push(state),
			notificationService: {
				error: (error: unknown) => assert.fail(String(error)),
			},
		});
		const initialize = Reflect.get(
			ProjectSwitcherWidget.prototype,
			'initializeOmniHostedWorkspaceState'
		) as (this: object) => Promise<void>;

		const initialization = initialize.call(host);
		await Promise.resolve();
		Reflect.set(host, 'didReceiveOmniHostedWorkspaceStateChange', true);
		appliedStates.push(liveState);
		snapshotReady.complete(hostedState('snapshot'));
		await initialization;

		assert.deepStrictEqual(appliedStates, [liveState]);
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
		name: 'feature',
		path: '/repo/feature',
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
		name: 'Scratch',
		path: '/scratch',
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
	readonly moveWorktree?: (
		projectId: string,
		sourcePath: string,
		beforePath: string | undefined
	) => Promise<void>;
	readonly error?: (value: unknown) => void;
	readonly projects?: readonly ProjectRecord[];
	readonly windowState?: IHucodeHostedWorkspaceState;
	readonly reorderRetainedWorkbenches?: (
		ids: readonly string[]
	) => Promise<void>;
} = {}): ProjectSwitcherDragAndDrop {
	return new ProjectSwitcherDragAndDrop(
		() => undefined,
		(_target, targetIndex) => targetIndex,
		{
			moveProject: options.moveProject ?? (async () => undefined),
			moveWorktree: options.moveWorktree ?? (async () => undefined),
			getProjects: async () =>
				options.projects ?? [projectRecord()],
		} as unknown as IProjectManagerService,
		{
			error: options.error ?? (() => undefined),
		} as unknown as INotificationService,
		{
			getState: async () =>
				options.windowState ?? hostedState(),
			reorderRetainedWorkbenches:
				options.reorderRetainedWorkbenches ??
				(async () => undefined),
		} as unknown as IHucodeShellControllerService
	);
}

function projectRecord(
	overrides: Partial<ProjectRecord> = {}
): ProjectRecord {
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
		...overrides,
	};
}

function worktreeRecord(
	path: string,
	label: string,
	isMain = false,
	lastVisitedAt?: number
): WorktreeRecord {
	return {
		path,
		label,
		isMain,
		isDetached: false,
		lastVisitedAt,
	};
}

function retainedRecord(
	id: string,
	path: string,
	order: number,
	lastActiveAt?: number
): IHucodeRetainedWorkbench {
	return {
		id,
		folderUri: URI.file(path).toJSON(),
		desiredState: 'loaded',
		order,
		lastActiveAt,
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
