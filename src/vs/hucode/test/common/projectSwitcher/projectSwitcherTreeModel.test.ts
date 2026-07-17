/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import {
	ProjectRecord,
	WorktreeRecord,
} from '../../../../platform/projectManager/common/projectManager.js';
import { IHucodeHostedWorkspaceState } from
	'../../../common/omniWindow.js';
import {
	applyOmniSectionCollapseChange,
	buildProjectSwitcherTreeModel,
	encodeWorktreeHandle,
	isItemInCollapsedOmniSection,
	isOmniSectionItem,
	isProjectItem,
	isRetainedWorkbenchItem,
	isWorktreeItem,
	MAIN_WORKTREE_CONTEXT_VALUE,
	MISSING_WORKTREE_CONTEXT_VALUE,
	ProjectSwitcherTreeElement,
	WORKTREE_CONTEXT_VALUE,
} from '../../../common/projectSwitcher/projectSwitcherTreeModel.js';

suite('ProjectSwitcherTreeModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns Workbenches above Projects in an empty Omni window', () => {
		const model = buildProjectSwitcherTreeModel({
			projects: [],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			hostedWorkspaceState: createHostedState(),
		});

		assert.deepStrictEqual(
			model.roots.map(root => root.element.label),
			['Workbenches', 'Projects']
		);
		assert.ok(model.roots.every(root =>
			isOmniSectionItem(root.element) && root.collapsible
		));
	});

	test('ignores transient section collapse changes during tree sync', () => {
		const collapsedSections = new Set(['section:workbenches']);

		assert.strictEqual(applyOmniSectionCollapseChange(
			collapsedSections,
			'section:workbenches',
			false,
			true
		), false);
		assert.deepStrictEqual([...collapsedSections], [
			'section:workbenches'
		]);
		assert.strictEqual(applyOmniSectionCollapseChange(
			collapsedSections,
			'section:workbenches',
			false,
			false
		), true);
		assert.deepStrictEqual([...collapsedSections], []);
	});

	test('keeps targets hidden by intentionally collapsed Omni sections', () => {
		const model = buildProjectSwitcherTreeModel({
			projects: [createProject({
				id: 'project',
				worktrees: [createWorktree('/repos/project', {
					isMain: true
				})],
			})],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			hostedWorkspaceState: {
				...createHostedState(),
				retainedWorkbenches: [{
					id: 'scratch',
					folderUri: URI.file('/scratch').toJSON(),
					desiredState: 'loaded',
					order: 0,
				}],
			},
		});
		const items = flatten(model.roots).map(element => element.element);
		const workbench = items.find(isRetainedWorkbenchItem);
		const worktree = items.find(isWorktreeItem);
		assert.ok(workbench);
		assert.ok(worktree);

		assert.strictEqual(isItemInCollapsedOmniSection(
			workbench,
			new Set(['section:workbenches'])
		), true);
		assert.strictEqual(isItemInCollapsedOmniSection(
			worktree,
			new Set(['section:projects'])
		), true);
		assert.strictEqual(isItemInCollapsedOmniSection(
			workbench,
			new Set()
		), false);
	});

	test('shows retained workbenches in manual order and hides promotions', () => {
		const promotedPath = '/repos/project';
		const state: IHucodeHostedWorkspaceState = {
			...createHostedState(),
			retainedWorkbenches: [{
				id: 'second',
				folderUri: URI.file('/scratch/second').toJSON(),
				desiredState: 'unloaded',
				order: 1,
			}, {
				id: 'first',
				folderUri: URI.file('/scratch/first').toJSON(),
				desiredState: 'loaded',
				order: 0,
			}, {
				id: 'promoted',
				folderUri: URI.file(promotedPath).toJSON(),
				desiredState: 'loaded',
				order: 2,
			}, {
				id: 'missing',
				folderUri: URI.file('/scratch/missing').toJSON(),
				desiredState: 'unloaded',
				folderStatus: 'missing',
				order: 3,
			}],
		};
		const model = buildProjectSwitcherTreeModel({
			projects: [createProject({
				id: 'project',
				worktrees: [createWorktree(promotedPath, { isMain: true })],
			})],
			collapsedProjectIds: new Set(),
			getPathLabel: path => `label:${path}`,
			isOmniWindow: true,
			hostedWorkspaceState: state,
		});

		const workbenches = model.roots[0].children?.map(child => child.element)
			.filter(isRetainedWorkbenchItem) ?? [];
		assert.deepStrictEqual(workbenches.map(item => ({
			label: item.label,
			description: item.description,
			state: item.hostedWorkbenchState,
		})), [{
			label: 'first',
			description: 'label:/scratch/first',
			state: 'dormant',
		}, {
			label: 'second',
			description: 'label:/scratch/second',
			state: 'unloaded',
		}, {
			label: 'missing',
			description: 'label:/scratch/missing',
			state: 'missing',
		}]);
	});

	test('orders pinned projects and pinned worktrees in visible sections', () => {
		const model = buildProjectSwitcherTreeModel({
			projects: [
				createProject({
					id: 'alpha',
					worktrees: [
						createWorktree('/repos/alpha', { isMain: true }),
						createWorktree('/repos/alpha.worktrees/pinned', {
							branch: 'feature/pinned',
							pinned: true,
						}),
						createWorktree('/repos/alpha.worktrees/other', {
							branch: 'feature/other',
						}),
					],
				}),
				createProject({
					id: 'bravo',
					pinned: true,
					worktrees: [
						createWorktree('/repos/bravo', { isMain: true }),
					],
				}),
			],
			collapsedProjectIds: new Set(),
			getPathLabel: path => `label:${path}`,
			isOmniWindow: true,
			hostedWorkspaceState: createHostedState(),
		});

		assert.deepStrictEqual(
			flatten(model.roots)
				.filter(item => !isOmniSectionItem(item.element))
				.map(item => item.element.label),
			[
				'Pinned',
				'alpha',
				'pinned',
				'bravo',
				'local',
				'Unpinned',
				'alpha',
				'local',
				'other',
			]
		);
	});

	test('marks active, loaded, loading, and unloaded worktree UI state', () => {
		const active = '/repos/hucode.worktrees/active';
		const loading = '/repos/hucode.worktrees/loading';
		const unloaded = '/repos/hucode.worktrees/unloaded';
		const model = buildProjectSwitcherTreeModel({
			projects: [
				createProject({
					id: 'hucode',
					worktrees: [
						createWorktree(active, { branch: 'active' }),
						createWorktree(loading, { branch: 'loading' }),
						createWorktree(unloaded, { branch: 'unloaded' }),
					],
				}),
			],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			activeWorktreePath: active,
			hostedWorkspaceState: createHostedState({
				activeInstanceId: 'active-instance',
				instances: [
					{
						instanceId: 'active-instance',
						worktreePath: active,
						state: 'active',
						visible: true,
						focused: true,
					},
					{
						instanceId: 'loading-instance',
						worktreePath: loading,
						state: 'loading',
						visible: false,
						focused: false,
					},
				],
			}),
		});

		const activeItem = getWorktree(model.roots, active);
		const loadingItem = getWorktree(model.roots, loading);
		const unloadedItem = getWorktree(model.roots, unloaded);

		assert.deepStrictEqual({
			active: {
				isActive: activeItem.isActive,
				hostedWorkbenchState: activeItem.hostedWorkbenchState,
			},
			loading: {
				hostedWorkbenchState: loadingItem.hostedWorkbenchState,
				iconClasses: ThemeIcon.asClassNameArray(loadingItem.themeIcon!),
			},
			unloaded: {
				contextValue: unloadedItem.contextValue,
				label: unloadedItem.label,
				hostedWorkbenchInstanceId:
					unloadedItem.hostedWorkbenchInstanceId,
			},
		}, {
			active: {
				isActive: true,
				hostedWorkbenchState: 'active',
			},
			loading: {
				hostedWorkbenchState: 'loading',
				iconClasses: [
					'codicon',
					'codicon-loading',
					'codicon-modifier-spin',
				],
			},
			unloaded: {
				contextValue: WORKTREE_CONTEXT_VALUE,
				label: 'unloaded',
				hostedWorkbenchInstanceId: undefined,
			},
		});
	});

	test('keeps worktree row identity stable when hosted state changes', () => {
		const worktreePath = '/repos/hucode.worktrees/active';
		const createProjects = () => [
			createProject({
				id: 'hucode',
				worktrees: [
					createWorktree(worktreePath, { branch: 'active' }),
				],
			}),
		];
		const idle = buildProjectSwitcherTreeModel({
			projects: createProjects(),
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			hostedWorkspaceState: createHostedState(),
		});
		const loaded = buildProjectSwitcherTreeModel({
			projects: createProjects(),
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			activeWorktreePath: worktreePath,
			hostedWorkspaceState: createHostedState({
				activeInstanceId: 'active-instance',
				instances: [
					{
						instanceId: 'active-instance',
						worktreePath,
						state: 'active',
						visible: true,
						focused: true,
					},
				],
			}),
		});

		const idleItem = getWorktree(idle.roots, worktreePath);
		const loadedItem = getWorktree(loaded.roots, worktreePath);

		assert.strictEqual(idleItem.id, encodeWorktreeHandle(
			'hucode',
			worktreePath
		));
		assert.strictEqual(loadedItem.id, idleItem.id);
		assert.strictEqual(
			loadedItem.hostedWorkbenchInstanceId,
			'active-instance'
		);
		assert.strictEqual(loadedItem.hostedWorkbenchState, 'active');
	});

	test('preserves custom labels used by rename flows', () => {
		const model = buildProjectSwitcherTreeModel({
			projects: [
				createProject({
					id: 'hucode',
					label: 'Hucode Fork',
					worktrees: [
						createWorktree('/repos/hucode', {
							isMain: true,
							customLabel: 'stable',
						}),
					],
				}),
			],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: false,
			hostedWorkspaceState: createHostedState(),
		});

		const project = flatten(model.roots)
			.map(element => element.element)
			.find(isProjectItem);
		assert.ok(project);
		const worktree = getWorktree(model.roots, '/repos/hucode');

		assert.strictEqual(project.label, 'Hucode Fork');
		assert.strictEqual(project.description, 'hucode');
		assert.strictEqual(worktree.label, 'stable');
		assert.strictEqual(worktree.hasCustomLabel, true);
		assert.strictEqual(worktree.contextValue, MAIN_WORKTREE_CONTEXT_VALUE);
	});

	test('hides branch descriptions identical to worktree names', () => {
		const model = buildProjectSwitcherTreeModel({
			projects: [
				createProject({
					id: 'hucode',
					worktrees: [
						createWorktree('/repos/hucode.worktrees/user-login', {
							branch: 'user-login',
						}),
						createWorktree('/repos/hucode.worktrees/fix-user-login', {
							branch: 'fix/user-login',
						}),
						createWorktree('/repos/hucode.worktrees/user-session', {
							branch: 'fix/user-login',
						}),
					],
				}),
			],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: false,
			hostedWorkspaceState: createHostedState(),
		});

		assert.deepStrictEqual(
			[
				getWorktree(
					model.roots,
					'/repos/hucode.worktrees/user-login'
				).description,
				getWorktree(
					model.roots,
					'/repos/hucode.worktrees/fix-user-login'
				).description,
				getWorktree(
					model.roots,
					'/repos/hucode.worktrees/user-session'
				).description,
			],
			[
				undefined,
				'fix/user-login',
				'fix/user-login',
			]
		);
	});

	test('renders missing hosted instances under matching projects', () => {
		const model = buildProjectSwitcherTreeModel({
			projects: [
				createProject({
					id: 'hucode',
					worktrees: [
						createWorktree('/repos/hucode', { isMain: true }),
					],
				}),
			],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			hostedWorkspaceState: createHostedState({
				instances: [
					{
						instanceId: 'stale-instance',
						projectId: 'hucode',
						worktreePath: '/repos/hucode.worktrees/stale',
						state: 'loaded',
						visible: false,
						focused: false,
					},
				],
			}),
		});

		const staleItem = getWorktree(
			model.roots,
			'/repos/hucode.worktrees/stale'
		);
		assert.strictEqual(
			model.itemsById.has(
				encodeWorktreeHandle('hucode', '/repos/hucode.worktrees/stale')
			),
			true
		);
		assert.deepStrictEqual(
			{
				label: staleItem.label,
				description: staleItem.description,
				contextValue: staleItem.contextValue,
				hostedWorkbenchInstanceId: staleItem.hostedWorkbenchInstanceId,
				missingGitWorktree: staleItem.missingGitWorktree,
				iconClasses: ThemeIcon.asClassNameArray(staleItem.themeIcon!),
			},
			{
				label: 'stale',
				description: 'Missing',
				contextValue: MISSING_WORKTREE_CONTEXT_VALUE,
				hostedWorkbenchInstanceId: 'stale-instance',
				missingGitWorktree: true,
				iconClasses: ['codicon', 'codicon-warning'],
			}
		);
		assert.strictEqual(
			getWorktree(model.roots, '/repos/hucode').contextValue,
			MAIN_WORKTREE_CONTEXT_VALUE
		);
	});

	test('renders projects with only missing hosted worktrees', () => {
		const model = buildProjectSwitcherTreeModel({
			projects: [
				createProject({
					id: 'missing-root',
					worktrees: [],
				}),
			],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			activeWorktreePath: '/repos/missing-root.worktrees/feature',
			hostedWorkspaceState: createHostedState({
				activeInstanceId: 'feature-instance',
				instances: [
					{
						instanceId: 'feature-instance',
						projectId: 'missing-root',
						worktreePath: '/repos/missing-root.worktrees/feature',
						state: 'active',
						visible: true,
						focused: true,
					},
				],
			}),
		});

		const project = flatten(model.roots)
			.map(element => element.element)
			.find(isProjectItem);
		assert.ok(project);
		const worktree = getWorktree(
			model.roots,
			'/repos/missing-root.worktrees/feature'
		);

		assert.deepStrictEqual(
			{
				projectLabel: project.label,
				worktreeLabel: worktree.label,
				isActive: worktree.isActive,
				missingGitWorktree: worktree.missingGitWorktree,
			},
			{
				projectLabel: 'missing-root',
				worktreeLabel: 'feature',
				isActive: true,
				missingGitWorktree: true,
			}
		);
	});

	test('does not render invalid missing hosted worktree rows', () => {
		const model = buildProjectSwitcherTreeModel({
			projects: [
				createProject({
					id: 'hucode',
					worktrees: [
						createWorktree('/repos/hucode', { isMain: true }),
						createWorktree('/repos/hucode.worktrees/loaded', {
							branch: 'loaded',
						}),
					],
				}),
			],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			hostedWorkspaceState: createHostedState({
				instances: [
					{
						instanceId: 'known-instance',
						projectId: 'hucode',
						worktreePath: '/repos/hucode.worktrees/loaded',
						state: 'loaded',
						visible: false,
						focused: false,
					},
					{
						instanceId: 'unknown-project-instance',
						projectId: 'unknown',
						worktreePath: '/repos/hucode.worktrees/unknown',
						state: 'loaded',
						visible: false,
						focused: false,
					},
					{
						instanceId: 'missing-project-instance',
						worktreePath: '/repos/hucode.worktrees/no-project',
						state: 'loaded',
						visible: false,
						focused: false,
					},
					{
						instanceId: 'unloaded-instance',
						projectId: 'hucode',
						worktreePath: '/repos/hucode.worktrees/unloaded',
						state: 'unloaded',
						visible: false,
						focused: false,
					},
					{
						instanceId: 'crashed-instance',
						projectId: 'hucode',
						worktreePath: '/repos/hucode.worktrees/crashed',
						state: 'crashed',
						visible: false,
						focused: false,
					},
				],
			}),
		});

		assert.deepStrictEqual(
			flatten(model.roots)
				.map(element => element.element)
				.filter(isWorktreeItem)
				.map(item => ({
					worktreePath: item.worktreePath,
					missingGitWorktree: item.missingGitWorktree,
				})),
			[
				{
					worktreePath: '/repos/hucode',
					missingGitWorktree: false,
				},
				{
					worktreePath: '/repos/hucode.worktrees/loaded',
					missingGitWorktree: false,
				},
			]
		);
	});
});

function flatten(
	roots: readonly ProjectSwitcherTreeElement[]
): ProjectSwitcherTreeElement[] {
	const result: ProjectSwitcherTreeElement[] = [];
	for (const root of roots) {
		result.push(root);
		result.push(...flatten(root.children ?? []));
	}

	return result;
}

function getWorktree(
	roots: readonly ProjectSwitcherTreeElement[],
	worktreePath: string
) {
	const item = flatten(roots).map(element => element.element).find(item =>
		isWorktreeItem(item) && item.worktreePath === worktreePath
	);
	assert.ok(isWorktreeItem(item));
	return item;
}

function createProject(options: {
	readonly id: string;
	readonly label?: string;
	readonly pinned?: boolean;
	readonly worktrees: readonly WorktreeRecord[];
}): ProjectRecord {
	return {
		id: options.id,
		label: options.label ?? options.id,
		rootUri: URI.file(`/repos/${options.id}`),
		pinned: options.pinned ?? false,
		order: 0,
		worktrees: options.worktrees,
	};
}

function createWorktree(
	path: string,
	options: {
		readonly branch?: string;
		readonly customLabel?: string;
		readonly isMain?: boolean;
		readonly pinned?: boolean;
	} = {}
): WorktreeRecord {
	return {
		path,
		label: options.customLabel ?? (options.isMain ? 'local' : ''),
		customLabel: options.customLabel,
		branch: options.branch,
		isMain: options.isMain ?? false,
		isDetached: false,
		pinned: options.pinned,
	};
}

function createHostedState(options: Partial<{
	readonly activeInstanceId: string;
	readonly instances: readonly {
		readonly instanceId: string;
		readonly projectId?: string;
		readonly worktreePath: string;
		readonly state: 'restore-pending' | 'loading' | 'active' | 'loaded' |
		'dormant' | 'unloaded' | 'crashed';
		readonly visible: boolean;
		readonly focused: boolean;
	}[];
}> = {}): IHucodeHostedWorkspaceState {
	return {
		activeInstanceId: options.activeInstanceId,
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: options.instances ?? [],
	};
}
