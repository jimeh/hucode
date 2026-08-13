/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
	getLastVisibleDescendantIndex,
	getProjectSwitcherItemDescription,
	getProjectSwitcherPresentationFields,
	isItemInCollapsedOmniSection,
	isOmniSectionItem,
	isProjectItem,
	isRetainedWorkbenchItem,
	isWorktreeItem,
	MAIN_WORKTREE_CONTEXT_VALUE,
	MISSING_WORKTREE_CONTEXT_VALUE,
	PINNED_PROJECT_CONTEXT_VALUE,
	PROJECT_CONTEXT_VALUE,
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

	test('applies persisted Omni section order', () => {
		const model = buildProjectSwitcherTreeModel({
			projects: [],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			hostedWorkspaceState: createHostedState(),
			omniSectionOrder: ['projects', 'workbenches'],
		});

		assert.deepStrictEqual(
			model.roots.map(root => root.element.label),
			['Projects', 'Workbenches']
		);
	});

	test('ignores transient section collapse changes during tree sync', () => {
		const collapsedSections = new Set(['section:workbenches']);

		const transientChanged = applyOmniSectionCollapseChange(
			collapsedSections,
			'section:workbenches',
			false,
			true
		);
		const afterTransient = [...collapsedSections];
		const userChanged = applyOmniSectionCollapseChange(
			collapsedSections,
			'section:workbenches',
			false,
			false
		);
		assert.deepStrictEqual({
			transientChanged,
			afterTransient,
			userChanged,
			afterUserChange: [...collapsedSections],
		}, {
			transientChanged: false,
			afterTransient: ['section:workbenches'],
			userChanged: true,
			afterUserChange: [],
		});
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

		assert.deepStrictEqual({
			workbenchCollapsed: isItemInCollapsedOmniSection(
				workbench,
				new Set(['section:workbenches'])
			),
			worktreeCollapsed: isItemInCollapsedOmniSection(
				worktree,
				new Set(['section:projects'])
			),
			workbenchExpanded: isItemInCollapsedOmniSection(
				workbench,
				new Set()
			),
		}, {
			workbenchCollapsed: true,
			worktreeCollapsed: true,
			workbenchExpanded: false,
		});
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
				label: 'Scratch One',
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
			hasCustomLabel: item.hasCustomLabel,
			state: item.hostedWorkbenchState,
			isActive: item.isActive,
		})), [{
			label: 'Scratch One',
			description: 'label:/scratch/first',
			hasCustomLabel: true,
			state: 'dormant',
			isActive: false,
		}, {
			label: 'second',
			description: 'label:/scratch/second',
			hasCustomLabel: false,
			state: 'unloaded',
			isActive: false,
		}, {
			label: 'missing',
			description: 'label:/scratch/missing',
			hasCustomLabel: false,
			state: 'missing',
			isActive: false,
		}]);
	});

	test('shows an adopted orphan when its former project is absent', () => {
		const orphanPath = '/repos/orphan';
		const model = buildProjectSwitcherTreeModel({
			projects: [],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			hostedWorkspaceState: {
				...createHostedState({
					activeInstanceId: 'orphan-instance',
					instances: [{
						instanceId: 'orphan-instance',
						worktreePath: orphanPath,
						state: 'active',
						visible: true,
						focused: true,
					}],
				}),
				retainedWorkbenches: [{
					id: 'orphan-retained',
					folderUri: URI.file(orphanPath).toJSON(),
					desiredState: 'loaded',
					order: 0,
				}],
			},
		});

		const workbenches = model.roots[0].children?.map(child => child.element)
			.filter(isRetainedWorkbenchItem) ?? [];
		assert.deepStrictEqual(workbenches.map(item => ({
			path: item.worktreePath,
			state: item.hostedWorkbenchState,
			isActive: item.isActive,
		})), [{
			path: orphanPath,
			state: 'active',
			isActive: true,
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

	test('keeps stale worktrees visible with an explicit warning', () => {
		const worktreePath = '/repos/stale';
		const model = buildProjectSwitcherTreeModel({
			projects: [createProject({
				id: 'stale',
				worktreeState: 'stale',
				worktrees: [createWorktree(worktreePath, { isMain: true })],
			})],
			collapsedProjectIds: new Set(),
			getPathLabel: path => `path:${path}`,
			isOmniWindow: false,
			hostedWorkspaceState: createHostedState(),
		});

		const project = model.roots[0];
		assert.strictEqual(project.collapsible, true);
		assert.strictEqual(project.children?.length, 1);
		assert.strictEqual(project.element.contextValue, PROJECT_CONTEXT_VALUE);
		assert.strictEqual(
			project.element.description,
			'Worktrees out of date · path:/repos'
		);
		assert.strictEqual(
			project.element.tooltip,
			'Worktrees out of date · path:/repos'
		);
		assert.deepStrictEqual(
			ThemeIcon.asClassNameArray(project.element.themeIcon!),
			['codicon', 'codicon-warning']
		);
	});

	test('shows unavailable projects without collapsible children', () => {
		const model = buildProjectSwitcherTreeModel({
			projects: [
				createProject({
					id: 'pinned',
					pinned: true,
					worktreeState: 'unavailable',
					worktrees: [],
				}),
				createProject({
					id: 'regular',
					worktreeState: 'unavailable',
					worktrees: [],
				}),
			],
			collapsedProjectIds: new Set(),
			getPathLabel: path => `path:${path}`,
			isOmniWindow: false,
			hostedWorkspaceState: createHostedState(),
		});

		assert.deepStrictEqual(
			model.roots.map(root => root.element.label),
			['Pinned', 'pinned', 'Unpinned', 'regular']
		);
		for (const project of model.roots.filter(root =>
			isProjectItem(root.element)
		)) {
			assert.strictEqual(project.collapsible, false);
			assert.deepStrictEqual(project.children, []);
			assert.strictEqual(
				project.element.description,
				'Worktrees unavailable · path:/repos'
			);
			assert.strictEqual(
				project.element.tooltip,
				'Worktrees unavailable · path:/repos'
			);
			assert.deepStrictEqual(
				ThemeIcon.asClassNameArray(project.element.themeIcon!),
				['codicon', 'codicon-warning']
			);
			assert.strictEqual(
				project.element.contextValue,
				project.element.label === 'pinned'
					? PINNED_PROJECT_CONTEXT_VALUE
					: PROJECT_CONTEXT_VALUE
			);
		}
	});

	test('keeps hosted workbenches under unavailable Omni projects', () => {
		const hostedPath = '/repos/unavailable.worktrees/hosted';
		const model = buildProjectSwitcherTreeModel({
			projects: [createProject({
				id: 'unavailable',
				worktreeState: 'unavailable',
				worktrees: [],
			})],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			hostedWorkspaceState: createHostedState({
				instances: [{
					instanceId: 'hosted-instance',
					projectId: 'unavailable',
					worktreePath: hostedPath,
					state: 'loaded',
					visible: false,
					focused: false,
				}],
			}),
		});

		const project = flatten(model.roots).find(root =>
			isProjectItem(root.element)
		);
		assert.ok(project);
		assert.strictEqual(project.collapsible, true);
		assert.strictEqual(project.children?.length, 1);
		const hosted = getWorktree(model.roots, hostedPath);
		assert.strictEqual(hosted.hostedWorkbenchInstanceId, 'hosted-instance');
		assert.strictEqual(hosted.missingGitWorktree, true);
		assert.strictEqual(hosted.contextValue, MISSING_WORKTREE_CONTEXT_VALUE);
	});

	test('marks active, loaded, loading, and unloaded worktree UI state', () => {
		const active = '/repos/hucode.worktrees/active';
		const loading = '/repos/hucode.worktrees/loading';
		const unloaded = '/repos/hucode.worktrees/unloaded';
		const absent = '/repos/hucode.worktrees/absent';
		const dormant = '/repos/hucode.worktrees/dormant';
		const model = buildProjectSwitcherTreeModel({
			projects: [
				createProject({
					id: 'hucode',
					worktrees: [
						createWorktree(active, { branch: 'active' }),
						createWorktree(loading, { branch: 'loading' }),
						createWorktree(unloaded, { branch: 'unloaded' }),
						createWorktree(absent, { branch: 'absent' }),
						createWorktree(dormant, { branch: 'dormant' }),
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
						instanceId: 'unloaded-instance',
						worktreePath: unloaded,
						state: 'unloaded',
						visible: false,
						focused: false,
					},
					{
						instanceId: 'dormant-instance',
						worktreePath: dormant,
						state: 'dormant',
						visible: false,
						focused: false,
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
		const absentItem = getWorktree(model.roots, absent);
		const dormantItem = getWorktree(model.roots, dormant);

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
				hostedWorkbenchState: unloadedItem.hostedWorkbenchState,
				hostedWorkbenchInstanceId:
					unloadedItem.hostedWorkbenchInstanceId,
				iconClasses: ThemeIcon.asClassNameArray(unloadedItem.themeIcon!),
			},
			absent: {
				hostedWorkbenchInstanceId: absentItem.hostedWorkbenchInstanceId,
				iconClasses: ThemeIcon.asClassNameArray(absentItem.themeIcon!),
			},
			dormant: {
				hostedWorkbenchState: dormantItem.hostedWorkbenchState,
				iconClasses: ThemeIcon.asClassNameArray(dormantItem.themeIcon!),
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
				hostedWorkbenchState: 'unloaded',
				hostedWorkbenchInstanceId: 'unloaded-instance',
				iconClasses: ['codicon', 'codicon-circle-outline'],
			},
			absent: {
				hostedWorkbenchInstanceId: undefined,
				iconClasses: ['codicon', 'codicon-circle-outline'],
			},
			dormant: {
				hostedWorkbenchState: 'dormant',
				iconClasses: ['codicon', 'codicon-debug-pause'],
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
		assert.strictEqual(project.description, '/repos');
		assert.strictEqual(worktree.label, 'stable');
		assert.strictEqual(worktree.hasCustomLabel, true);
		assert.strictEqual(worktree.contextValue, MAIN_WORKTREE_CONTEXT_VALUE);
	});

	test('labels the exact home parent with a trailing slash', () => {
		const homePath = '/home/tester';
		const model = buildProjectSwitcherTreeModel({
			projects: [
				{
					...createProject({
						id: 'dotfiles',
						worktrees: [createWorktree(`${homePath}/.dotfiles`)],
					}),
					rootUri: URI.file(`${homePath}/.dotfiles`),
				},
				{
					...createProject({
						id: 'hucode',
						worktrees: [
							createWorktree(`${homePath}/Projects/hucode`),
						],
					}),
					rootUri: URI.file(`${homePath}/Projects/hucode`),
				},
			],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path === homePath
				? path
				: path.replace(homePath, '~'),
			isOmniWindow: false,
			hostedWorkspaceState: createHostedState(),
		});

		assert.deepStrictEqual(
			model.roots.filter(root => isProjectItem(root.element))
				.map(root => root.element.description),
			['~/', '~/Projects']
		);
	});

	test('shows duplicate worktree descriptions only in two-line layout', () => {
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

		const matching = getWorktree(
			model.roots,
			'/repos/hucode.worktrees/user-login'
		);
		assert.deepStrictEqual(
			[
				matching.description,
				getProjectSwitcherItemDescription(matching, 'compact'),
				getProjectSwitcherItemDescription(matching, 'twoLine'),
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
				'user-login',
				undefined,
				'user-login',
				'fix/user-login',
				'fix/user-login',
			]
		);
	});

	test('builds explicit project and workbench fields for both row layouts', () => {
		const linkedPath = '/repos/hucode.worktrees/feature';
		const gitWorkbenchPath = '/scratch/repo/subdirectory';
		const detachedWorkbenchPath = '/scratch/detached';
		const plainWorkbenchPath = '/scratch/plain';
		const model = buildProjectSwitcherTreeModel({
			projects: [createProject({
				id: 'hucode',
				worktrees: [
					createWorktree('/repos/hucode', {
						isMain: true,
						branch: 'main',
					}),
					createWorktree(linkedPath, { branch: 'feature' }),
				],
			})],
			collapsedProjectIds: new Set(),
			getPathLabel: path => `label:${path}`,
			isOmniWindow: true,
			showWorktreePaths: true,
			hostedWorkspaceState: {
				...createHostedState(),
				retainedWorkbenches: [
					retained('git', gitWorkbenchPath, 0),
					retained('detached', detachedWorkbenchPath, 1),
					retained('plain', plainWorkbenchPath, 2),
				],
			},
			gitWorktreeObservations: [{
				targetPath: gitWorkbenchPath,
				state: 'current',
				repositoryRoot: '/scratch/repo',
				worktree: createWorktree('/scratch/repo', {
					isMain: true,
					branch: 'topic',
				}),
			}, {
				targetPath: detachedWorkbenchPath,
				state: 'current',
				repositoryRoot: detachedWorkbenchPath,
				worktree: createWorktree(detachedWorkbenchPath, {
					isMain: true,
					branch: undefined,
					isDetached: true,
				}),
			}, {
				targetPath: plainWorkbenchPath,
				state: 'notRepository',
			}],
		});
		const items = flatten(model.roots).map(element => element.element);
		const project = items.find(isProjectItem);
		assert.ok(project);
		const main = getWorktree(model.roots, '/repos/hucode');
		const linked = getWorktree(model.roots, linkedPath);
		const workbenches = items.filter(isRetainedWorkbenchItem);

		assert.deepStrictEqual({
			projectDescription: project.description,
			main: getProjectSwitcherPresentationFields(main, 'compact'),
			mainTwoLine: getProjectSwitcherPresentationFields(main, 'twoLine'),
			linkedCompact: getProjectSwitcherPresentationFields(linked, 'compact'),
			linkedTwoLine: getProjectSwitcherPresentationFields(linked, 'twoLine'),
			gitCompact: getProjectSwitcherPresentationFields(workbenches[0], 'compact'),
			gitTwoLine: getProjectSwitcherPresentationFields(workbenches[0], 'twoLine'),
			detachedCompact: getProjectSwitcherPresentationFields(
				workbenches[1],
				'compact'
			),
			detachedTwoLine: getProjectSwitcherPresentationFields(
				workbenches[1],
				'twoLine'
			),
			plainCompact: getProjectSwitcherPresentationFields(workbenches[2], 'compact'),
			plainTwoLine: getProjectSwitcherPresentationFields(workbenches[2], 'twoLine'),
		}, {
			projectDescription: 'label:/repos',
			main: {
				name: 'local',
				branch: 'main',
				path: undefined,
			},
			mainTwoLine: {
				name: 'local',
				branch: 'main',
				path: 'label:/repos/hucode',
			},
			linkedCompact: {
				name: 'feature',
				branch: undefined,
				path: undefined,
			},
			linkedTwoLine: {
				name: 'feature',
				branch: 'feature',
				path: `label:${linkedPath}`,
			},
			gitCompact: {
				name: 'subdirectory',
				branch: undefined,
				path: `label:${gitWorkbenchPath}`,
			},
			gitTwoLine: {
				name: 'subdirectory',
				branch: 'topic',
				path: `label:${gitWorkbenchPath}`,
			},
			detachedCompact: {
				name: 'detached',
				branch: undefined,
				path: `label:${detachedWorkbenchPath}`,
			},
			detachedTwoLine: {
				name: 'detached',
				branch: 'Detached',
				path: `label:${detachedWorkbenchPath}`,
			},
			plainCompact: {
				name: 'plain',
				branch: undefined,
				path: `label:${plainWorkbenchPath}`,
			},
			plainTwoLine: {
				name: 'plain',
				branch: undefined,
				path: `label:${plainWorkbenchPath}`,
			},
		});
	});

	test('hides only linked project paths when the path setting is off', () => {
		const linkedPath = '/repos/hucode.worktrees/feature';
		const model = buildProjectSwitcherTreeModel({
			projects: [createProject({
				id: 'hucode',
				worktrees: [
					createWorktree('/repos/hucode', { isMain: true }),
					createWorktree(linkedPath, { branch: 'feature' }),
				],
			})],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			showWorktreePaths: false,
			hostedWorkspaceState: {
				...createHostedState(),
				retainedWorkbenches: [retained('scratch', '/scratch', 0)],
			},
		});

		const workbench = flatten(model.roots)
			.map(element => element.element)
			.find(isRetainedWorkbenchItem);
		assert.ok(workbench);
		assert.deepStrictEqual({
			mainPath: getWorktree(model.roots, '/repos/hucode').path,
			linkedPath: getWorktree(model.roots, linkedPath).path,
			workbenchPath: workbench.path,
		}, {
			mainPath: undefined,
			linkedPath: undefined,
			workbenchPath: '/scratch',
		});
	});

	test('does not apply the Omni worktree-path setting outside Omni', () => {
		const linkedPath = '/repos/hucode.worktrees/feature';
		const model = buildProjectSwitcherTreeModel({
			projects: [createProject({
				id: 'hucode',
				worktrees: [createWorktree(linkedPath, { branch: 'feature' })],
			})],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: false,
			showWorktreePaths: true,
			hostedWorkspaceState: createHostedState(),
		});

		const linkedWorktree = getWorktree(model.roots, linkedPath);
		assert.deepStrictEqual({
			path: linkedWorktree.path,
			iconClasses: ThemeIcon.asClassNameArray(linkedWorktree.themeIcon!),
		}, {
			path: undefined,
			iconClasses: ['codicon', 'codicon-worktree'],
		});
	});

	test('suppresses stale Git branches for missing retained folders', () => {
		const missingPath = '/scratch/missing';
		const model = buildProjectSwitcherTreeModel({
			projects: [],
			collapsedProjectIds: new Set(),
			getPathLabel: path => path,
			isOmniWindow: true,
			hostedWorkspaceState: {
				...createHostedState(),
				retainedWorkbenches: [{
					...retained('missing', missingPath, 0),
					folderStatus: 'missing',
				}],
			},
			gitWorktreeObservations: [{
				targetPath: missingPath,
				state: 'stale',
				repositoryRoot: missingPath,
				worktree: createWorktree(missingPath, { branch: 'stale-branch' }),
			}],
		});
		const item = flatten(model.roots)
			.map(element => element.element)
			.find(isRetainedWorkbenchItem);
		assert.ok(item);

		assert.deepStrictEqual({
			state: item.hostedWorkbenchState,
			branch: item.branch,
			description: item.description,
		}, {
			state: 'missing',
			branch: undefined,
			description: missingPath,
		});
	});

	test('places after-section feedback after visible nested descendants', () => {
		const nested = {
			visible: true,
			collapsed: false,
			children: [{
				visible: true,
				collapsed: false,
				children: [{
					visible: true,
					collapsed: true,
					children: [],
				}],
			}, {
				visible: false,
				collapsed: false,
				children: [{
					visible: true,
					collapsed: true,
					children: [],
				}],
			}],
		};

		assert.deepStrictEqual({
			expanded: getLastVisibleDescendantIndex(4, nested),
			collapsed: getLastVisibleDescendantIndex(4, {
				...nested,
				collapsed: true,
			}),
			empty: getLastVisibleDescendantIndex(4, {
				visible: true,
				collapsed: false,
				children: [],
			}),
		}, {
			expanded: 6,
			collapsed: 4,
			empty: 4,
		});
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
	readonly worktreeState?: ProjectRecord['worktreeState'];
	readonly worktrees: readonly WorktreeRecord[];
}): ProjectRecord {
	return {
		id: options.id,
		label: options.label ?? options.id,
		rootUri: URI.file(`/repos/${options.id}`),
		pinned: options.pinned ?? false,
		order: 0,
		worktreeState: options.worktreeState ?? 'current',
		worktrees: options.worktrees,
	};
}

function createWorktree(
	path: string,
	options: {
		readonly branch?: string;
		readonly customLabel?: string;
		readonly isMain?: boolean;
		readonly isDetached?: boolean;
		readonly pinned?: boolean;
	} = {}
): WorktreeRecord {
	return {
		path,
		label: options.customLabel ?? (options.isMain ? 'local' : ''),
		customLabel: options.customLabel,
		branch: options.branch,
		isMain: options.isMain ?? false,
		isDetached: options.isDetached ?? false,
		pinned: options.pinned,
	};
}

function retained(id: string, path: string, order: number) {
	return {
		id,
		folderUri: URI.file(path).toJSON(),
		desiredState: 'unloaded' as const,
		order,
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
