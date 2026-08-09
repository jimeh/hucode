/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { URI } from '../../../../base/common/uri.js';
import { ProjectRecord, WorktreeRecord } from
	'../../../../platform/projectManager/common/projectManager.js';
import {
	canonicalizeProjectSwitcherTarget,
	combineProjectSwitcherTargets,
	compareSwitchWorktreePicks,
	createHucodeHostedNavigationSnapshot,
	createHucodeHostedNavigationSnapshotWithCatalog,
	filterSwitchWorktreePicks,
	getAdjacentProjectWorktreeTarget,
	getDefaultSwitchWorktreeActivePick,
	getLastActiveSwitchWorkbenchPick,
	getLoadedProjectWorktreeTargets,
	getLoadedSwitchWorktreePicks,
	getRetainedWorkbenchQuickPickPresentation,
	getVisualProjectWorktreeTargets,
	reviveHucodeHostedNavigationProjects,
	sortProjectSwitcherNavigationHistory,
	SwitchWorktreeQuickPick,
	withSwitchWorktreeSeparators,
} from '../../../common/projectSwitcher/switchProjectWorktreeModel.js';

suite('SwitchProjectWorktreeModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('projects a sanitized hosted navigation snapshot', () => {
		const snapshot = createHucodeHostedNavigationSnapshot({
			activeInstanceId: 'project-instance',
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			projectSwitcherSectionOrder: ['projects', 'workbenches'],
			instances: [{
				instanceId: 'retained-instance',
				worktreePath: '/arbitrary',
				state: 'loaded',
				visible: false,
				focused: false,
				webContentsId: 123,
				processId: 456,
				lastActiveAt: 10,
			}, {
				instanceId: 'project-instance',
				projectId: 'secret-project-id',
				worktreePath: '/project',
				state: 'active',
				visible: true,
				focused: true,
				lastActiveAt: 20,
			}],
			retainedWorkbenches: [{
				id: 'retained-id',
				folderUri: URI.file('/arbitrary').toJSON(),
				desiredState: 'loaded',
				order: 7,
				label: 'Arbitrary',
			}],
		});

		assert.deepStrictEqual(snapshot, {
			sectionOrder: ['projects', 'workbenches'],
			targets: [{
				folderUri: URI.file('/arbitrary').toJSON(),
				lifecycleState: 'loaded',
				lastActiveAt: 10,
				section: 'workbenches',
				order: 7,
				label: 'Arbitrary',
			}, {
				folderUri: URI.file('/project').toJSON(),
				lifecycleState: 'active',
				lastActiveAt: 20,
				section: 'projects',
				order: 1,
			}],
		});
		const serialized = JSON.stringify(snapshot);
		for (const forbidden of [
			'instanceId', 'projectId', 'retainedWorkbenchId',
			'webContentsId', 'processId', 'connectionGeneration',
		]) {
			assert.strictEqual(serialized.includes(forbidden), false);
		}
	});

	test('round-trips a switcher catalog without authority identities', () => {
		const snapshot = createHucodeHostedNavigationSnapshot({
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
		}, [{
			id: 'secret-project-id',
			label: 'Repository',
			rootUri: URI.file('/repo'),
			pinned: true,
			order: 4,
			lastActiveWorktreePath: '/repo/feature',
			worktreeState: 'stale',
			worktrees: [{
				path: '/repo/feature',
				label: 'feature',
				customLabel: 'Feature',
				branch: 'feature/catalog',
				isMain: false,
				isDetached: false,
				pinned: true,
				lastVisitedAt: 42,
			}],
		}]);
		const revived = reviveHucodeHostedNavigationProjects(snapshot);

		assert.deepStrictEqual({
			serializedContainsSecretId: JSON.stringify(snapshot)
				.includes('secret-project-id'),
			serializedContainsAuthorityFields: [
				'projectId', 'lastActiveWorktreePath', 'worktreeState',
			].some(field => JSON.stringify(snapshot).includes(field)),
			project: snapshot.projects?.[0],
			revived: revived?.map(project => ({
				idIsSynthetic: project.id !== 'secret-project-id',
				rootPath: project.rootUri.fsPath,
				worktreeState: project.worktreeState,
				worktree: project.worktrees[0],
			})),
		}, {
			serializedContainsSecretId: false,
			serializedContainsAuthorityFields: false,
			project: {
				rootUri: URI.file('/repo').toJSON(),
				label: 'Repository',
				pinned: true,
				order: 4,
				worktrees: [{
					folderUri: URI.file('/repo/feature').toJSON(),
					label: 'feature',
					customLabel: 'Feature',
					branch: 'feature/catalog',
					isMain: false,
					isDetached: false,
					pinned: true,
					lastVisitedAt: 42,
				}],
			},
			revived: [{
				idIsSynthetic: true,
				rootPath: '/repo',
				worktreeState: 'current',
				worktree: {
					path: '/repo/feature',
					label: 'feature',
					customLabel: 'Feature',
					branch: 'feature/catalog',
					isMain: false,
					isDetached: false,
					pinned: true,
					lastVisitedAt: 42,
				},
			}],
		});
	});

	test('falls back to current lifecycle state when catalog loading fails',
		async () => {
			const catalog = new DeferredPromise<readonly ProjectRecord[]>();
			let path = '/initial';
			let error: unknown;
			const snapshotPromise =
				createHucodeHostedNavigationSnapshotWithCatalog(
					() => ({
						projectsSidebarVisible: true,
						projectSwitcherCanGoBack: false,
						projectSwitcherCanGoForward: false,
						instances: [{
							instanceId: 'instance',
							worktreePath: path,
							state: 'active',
							visible: true,
							focused: true,
						}],
					}),
					() => catalog.p,
					value => error = value
				);
			path = '/current';
			catalog.error(new Error('catalog unavailable'));

			const snapshot = await snapshotPromise;
			assert.deepStrictEqual({
				path: URI.revive(snapshot.targets[0].folderUri).fsPath,
				projects: snapshot.projects,
				error: String(error),
			}, {
				path: '/current',
				projects: undefined,
				error: 'Error: catalog unavailable',
			});
		}
	);

	test('matches query tokens across project and worktree fields', () => {
		const picks = [
			createPick({
				projectId: 'hucode',
				label: '$(folder) Hucode',
				description: 'mellow-voyage',
				branch: 'main',
			}),
			createPick({
				projectId: 'agentic',
				label: '$(folder) agentic',
				description: 'local',
				branch: 'main',
			}),
		];

		const result = filterSwitchWorktreePicks(picks, 'hucode mellow');

		assert.deepStrictEqual(result.map(pick => pick.projectId), ['hucode']);
		assert.ok(result[0].highlights?.label);
		assert.ok(result[0].highlights?.description);
	});

	test('matches query tokens across project and branch fields', () => {
		const picks = [
			createPick({
				projectId: 'hucode',
				label: '$(folder) Hucode',
				description: 'local',
				branch: 'feature/project-switcher',
			}),
			createPick({
				projectId: 'hucode-main',
				label: '$(folder) Hucode',
				description: 'local',
				branch: 'main',
			}),
		];

		const result = filterSwitchWorktreePicks(picks, 'hucode switcher');

		assert.deepStrictEqual(result.map(pick => pick.projectId), ['hucode']);
		assert.ok(result[0].highlights?.label);
		assert.ok(result[0].highlights?.detail);
	});

	test('does not match the visible worktree path', () => {
		const picks = [
			createPick({
				projectId: 'hucode',
				label: '$(folder) Hucode',
				description: 'local',
				branch: 'main',
				detail: 'main - ~/Projects/hucode',
			}),
		];

		assert.strictEqual(
			filterSwitchWorktreePicks(picks, 'Projects').length,
			0
		);
		assert.strictEqual(
			filterSwitchWorktreePicks(picks, 'hucode Projects').length,
			0
		);
	});

	test('presents retained workbenches with name and path on separate lines', () => {
		assert.deepStrictEqual(
			getRetainedWorkbenchQuickPickPresentation(
				'Scratch',
				'~/Projects/scratch',
				'/home/test/Projects/scratch'
			),
			{
				label: 'Scratch',
				detail: '~/Projects/scratch',
				tooltip: '/home/test/Projects/scratch',
				searchFields: [
					{ target: 'label', text: 'Scratch' },
					{ target: 'detail', text: '~/Projects/scratch' },
					{ text: '/home/test/Projects/scratch' },
				],
			}
		);
	});

	test('searches retained paths with highlights only for visible text', () => {
		const presentation = getRetainedWorkbenchQuickPickPresentation(
			'Scratch',
			'~/Projects/scratch',
			'/home/test/Projects/scratch'
		);
		const pick = {
			...createPick({ projectId: 'scratch' }),
			...presentation,
			projectId: undefined,
			description: undefined,
		};

		const hiddenResult = filterSwitchWorktreePicks([pick], 'home');
		const visibleResult = filterSwitchWorktreePicks([pick], 'Projects');

		assert.deepStrictEqual({
			description: pick.description,
			hiddenLength: hiddenResult.length,
			hiddenHighlights: hiddenResult[0]?.highlights,
			visibleLength: visibleResult.length,
			visibleHasDetailHighlight: Boolean(
				visibleResult[0]?.highlights?.detail?.length
			),
		}, {
			description: undefined,
			hiddenLength: 1,
			hiddenHighlights: {},
			visibleLength: 1,
			visibleHasDetailHighlight: true,
		});
	});

	test('does not duplicate identical retained workbench search paths', () => {
		const presentation = getRetainedWorkbenchQuickPickPresentation(
			'Scratch',
			'/tmp/scratch',
			'/tmp/scratch'
		);

		assert.deepStrictEqual(presentation.searchFields, [
			{ target: 'label', text: 'Scratch' },
			{ target: 'detail', text: '/tmp/scratch' },
		]);
	});

	test('groups current, loaded, dormant, and not loaded picks', () => {
		const current = createPick({
			projectId: 'current',
			isCurrent: true,
		});
		const loaded = createPick({ projectId: 'loaded', isLoaded: true });
		const dormant = createPick({ projectId: 'dormant', isDormant: true });
		const notLoaded = createPick({ projectId: 'not-loaded' });

		const items = withSwitchWorktreeSeparators([
			current,
			loaded,
			dormant,
			notLoaded,
		]);

		assert.deepStrictEqual(
			items.map(item => item.type === 'separator'
				? item.label
				: item.projectId
			),
			[
				'Current',
				'current',
				'Loaded',
				'loaded',
				'Dormant',
				'dormant',
				'Not Loaded',
				'not-loaded',
			]
		);
	});

	test('defaults switcher focus to the next non-current pick', () => {
		const current = createPick({
			projectId: 'current',
			isCurrent: true,
			isLoaded: true,
		});
		const recent = createPick({
			projectId: 'recent',
			isLoaded: true,
		});
		const other = createPick({ projectId: 'other' });

		assert.strictEqual(
			getDefaultSwitchWorktreeActivePick([current, recent, other]),
			recent
		);
		assert.strictEqual(
			getDefaultSwitchWorktreeActivePick([current]),
			current
		);
	});

	test('filters quick switch picks to loaded worktrees', () => {
		const current = createPick({
			projectId: 'current',
			isCurrent: true,
			isLoaded: true,
		});
		const loaded = createPick({ projectId: 'loaded', isLoaded: true });
		const notLoaded = createPick({ projectId: 'not-loaded' });

		assert.deepStrictEqual(
			getLoadedSwitchWorktreePicks([current, loaded, notLoaded]),
			[current, loaded]
		);
	});

	test('orders worktree targets like the Projects list pin sections', () => {
		const projects = [
			createProject({
				id: 'first',
				worktrees: [
					createWorktree('first/local', { isMain: true }),
					createWorktree('first/pinned', { pinned: true }),
					createWorktree('first/other'),
				],
			}),
			createProject({
				id: 'pinned-project',
				pinned: true,
				worktrees: [
					createWorktree('pinned-project/local', { isMain: true }),
					createWorktree('pinned-project/other'),
				],
			}),
			createProject({
				id: 'second',
				worktrees: [
					createWorktree('second/pinned', { pinned: true }),
					createWorktree('second/other'),
				],
			}),
		];

		const targets = getVisualProjectWorktreeTargets(projects);

		assert.deepStrictEqual(
			targets.map(target => target.worktreePath),
			[
				'/tmp/first/pinned',
				'/tmp/pinned-project/local',
				'/tmp/pinned-project/other',
				'/tmp/second/pinned',
				'/tmp/first/local',
				'/tmp/first/other',
				'/tmp/second/other',
			]
		);
	});

	test('filters visual worktree targets to loaded paths', () => {
		const targets = [
			{ projectId: 'one', worktreePath: '/tmp/one' },
			{ projectId: 'two', worktreePath: '/tmp/two' },
			{ projectId: 'three', worktreePath: '/tmp/three' },
		];
		const pathsEqual = (pathA: string, pathB: string) => pathA === pathB;

		assert.deepStrictEqual(
			getLoadedProjectWorktreeTargets(
				targets,
				['/tmp/three', '/tmp/one'],
				pathsEqual
			),
			[
				{ projectId: 'one', worktreePath: '/tmp/one' },
				{ projectId: 'three', worktreePath: '/tmp/three' },
			]
		);
	});

	test('finds adjacent worktree targets with wraparound', () => {
		const targets = [
			{ projectId: 'one', worktreePath: '/tmp/one' },
			{ projectId: 'two', worktreePath: '/tmp/two' },
			{ projectId: 'three', worktreePath: '/tmp/three' },
		];
		const pathsEqual = (pathA: string, pathB: string) => pathA === pathB;

		assert.strictEqual(
			getAdjacentProjectWorktreeTarget(
				targets,
				'/tmp/two',
				1,
				pathsEqual
			)?.worktreePath,
			'/tmp/three'
		);
		assert.strictEqual(
			getAdjacentProjectWorktreeTarget(
				targets,
				'/tmp/one',
				-1,
				pathsEqual
			)?.worktreePath,
			'/tmp/three'
		);
		assert.strictEqual(
			getAdjacentProjectWorktreeTarget(
				targets,
				undefined,
				1,
				pathsEqual
			)?.worktreePath,
			'/tmp/one'
		);
	});

	test('combines workbenches before projects without promoted duplicates', () => {
		const pathsEqual = (pathA: string, pathB: string) => pathA === pathB;

		assert.deepStrictEqual(combineProjectSwitcherTargets([{
			worktreePath: '/tmp/scratch',
		}, {
			worktreePath: '/tmp/promoted',
		}], [{
			projectId: 'project',
			worktreePath: '/tmp/promoted',
		}, {
			projectId: 'other',
			worktreePath: '/tmp/other',
		}], pathsEqual), [{
			worktreePath: '/tmp/scratch',
		}, {
			projectId: 'project',
			worktreePath: '/tmp/promoted',
		}, {
			projectId: 'other',
			worktreePath: '/tmp/other',
		}]);
	});

	test('combines mixed targets in the persisted section order', () => {
		const pathsEqual = (pathA: string, pathB: string) => pathA === pathB;

		assert.deepStrictEqual(combineProjectSwitcherTargets([{
			worktreePath: '/tmp/scratch',
		}], [{
			projectId: 'project',
			worktreePath: '/tmp/project',
		}], pathsEqual, ['projects', 'workbenches']), [{
			projectId: 'project',
			worktreePath: '/tmp/project',
		}, {
			worktreePath: '/tmp/scratch',
		}]);
	});

	test('canonicalizes promoted path-only targets to project ownership', () => {
		const project = createProject({
			id: 'project',
			worktrees: [createWorktree('promoted')],
		});

		assert.deepStrictEqual(canonicalizeProjectSwitcherTarget(
			{ worktreePath: '/tmp/promoted' },
			[project],
			(pathA, pathB) => pathA === pathB
		), {
			projectId: 'project',
			worktreePath: '/tmp/promoted',
		});
	});

	test('globally orders mixed project and arbitrary history', () => {
		assert.deepStrictEqual(sortProjectSwitcherNavigationHistory([{
			projectId: 'project',
			worktreePath: '/tmp/project',
			lastVisitedAt: 30,
		}, {
			worktreePath: '/tmp/scratch-old',
			lastVisitedAt: 10,
		}, {
			projectId: 'other',
			worktreePath: '/tmp/other',
			lastVisitedAt: 20,
		}]), [{
			projectId: undefined,
			worktreePath: '/tmp/scratch-old',
		}, {
			projectId: 'other',
			worktreePath: '/tmp/other',
		}, {
			projectId: 'project',
			worktreePath: '/tmp/project',
		}]);
	});

	test('keeps the most recent history target after project promotion', () => {
		assert.deepStrictEqual(sortProjectSwitcherNavigationHistory([{
			worktreePath: '/tmp/promoted',
			lastVisitedAt: 10,
		}, {
			projectId: 'project',
			worktreePath: '/tmp/other',
			lastVisitedAt: 20,
		}, {
			projectId: 'project',
			worktreePath: '/tmp/promoted',
			lastVisitedAt: 30,
		}], (a, b) => a.worktreePath === b.worktreePath), [{
			projectId: 'project',
			worktreePath: '/tmp/other',
		}, {
			projectId: 'project',
			worktreePath: '/tmp/promoted',
		}]);
	});

	test('uses MRU inside and outside Omni', () => {
		const project = {
			...createPick({ projectId: 'project', isLoaded: true }),
			lastVisitedAt: 30,
		};
		const workbench = {
			...createPick({ projectId: 'scratch', isLoaded: true }),
			projectId: undefined,
			lastVisitedAt: 10,
		};

		assert.deepStrictEqual({
			standalone: [project, workbench]
				.toSorted(compareSwitchWorktreePicks)
				.map(pick => pick.worktreePath),
			workbenchesFirst: [project, workbench]
				.toSorted((a, b) => compareSwitchWorktreePicks(
					a,
					b,
					['workbenches', 'projects']
				))
				.map(pick => pick.worktreePath),
			projectsFirst: [workbench, project]
				.toSorted((a, b) => compareSwitchWorktreePicks(
					a,
					b,
					['projects', 'workbenches']
				))
				.map(pick => pick.worktreePath),
		}, {
			standalone: ['/tmp/project', '/tmp/scratch'],
			workbenchesFirst: ['/tmp/project', '/tmp/scratch'],
			projectsFirst: ['/tmp/project', '/tmp/scratch'],
		});
	});

	test('uses logical section order to break MRU ties', () => {
		const project = {
			...createPick({ projectId: 'project', isLoaded: true }),
			lastVisitedAt: 20,
		};
		const workbench = {
			...createPick({ projectId: 'scratch', isLoaded: true }),
			projectId: undefined,
			lastVisitedAt: 20,
		};

		assert.deepStrictEqual({
			workbenchesFirst: [project, workbench]
				.toSorted((a, b) => compareSwitchWorktreePicks(
					a,
					b,
					['workbenches', 'projects']
				))
				.map(pick => pick.worktreePath),
			projectsFirst: [workbench, project]
				.toSorted((a, b) => compareSwitchWorktreePicks(
					a,
					b,
					['projects', 'workbenches']
				))
				.map(pick => pick.worktreePath),
			partialProjectsFirst: [workbench, project]
				.toSorted((a, b) => compareSwitchWorktreePicks(
					a,
					b,
					['projects']
				))
				.map(pick => pick.worktreePath),
		}, {
			workbenchesFirst: ['/tmp/scratch', '/tmp/project'],
			projectsFirst: ['/tmp/project', '/tmp/scratch'],
			partialProjectsFirst: ['/tmp/project', '/tmp/scratch'],
		});
	});

	test('uses pinned sidebar order after MRU ties', () => {
		const projects = [
			createProject({
				id: 'first',
				worktrees: [
					createWorktree('first/local', { isMain: true }),
					createWorktree('first/pinned', { pinned: true }),
				],
			}),
			createProject({
				id: 'pinned-project',
				pinned: true,
				worktrees: [createWorktree('pinned-project/local')],
			}),
		];
		const targets = getVisualProjectWorktreeTargets(projects);
		const picks = targets.map((target, logicalOrder) => ({
			...createPick({
				projectId: target.projectId ?? 'retained',
				isLoaded: true,
			}),
			worktreePath: target.worktreePath,
			lastVisitedAt: 20,
			logicalOrder,
		})).reverse();

		assert.deepStrictEqual(
			picks.toSorted(compareSwitchWorktreePicks)
				.map(pick => pick.worktreePath),
			targets.map(target => target.worktreePath)
		);
	});

	test('keeps lifecycle groups separate while sorting each by MRU', () => {
		const current = {
			...createPick({ projectId: 'current', isCurrent: true }),
			lastVisitedAt: 10,
		};
		const loadedOld = {
			...createPick({ projectId: 'loaded-old', isLoaded: true }),
			lastVisitedAt: 20,
		};
		const loadedNew = {
			...createPick({ projectId: 'loaded-new', isLoaded: true }),
			lastVisitedAt: 30,
		};
		const dormantOld = {
			...createPick({ projectId: 'dormant-old', isDormant: true }),
			lastVisitedAt: 40,
		};
		const dormantNew = {
			...createPick({ projectId: 'dormant-new', isDormant: true }),
			lastVisitedAt: 50,
		};
		const notLoadedOld = {
			...createPick({ projectId: 'not-loaded-old' }),
			lastVisitedAt: 60,
		};
		const notLoadedNew = {
			...createPick({ projectId: 'not-loaded-new' }),
			lastVisitedAt: 70,
		};

		assert.deepStrictEqual(
			[
				notLoadedOld,
				dormantNew,
				loadedOld,
				notLoadedNew,
				current,
				loadedNew,
				dormantOld,
			]
				.toSorted(compareSwitchWorktreePicks)
				.map(pick => pick.worktreePath),
			[
				'/tmp/current',
				'/tmp/loaded-new',
				'/tmp/loaded-old',
				'/tmp/dormant-new',
				'/tmp/dormant-old',
				'/tmp/not-loaded-new',
				'/tmp/not-loaded-old',
			]
		);
	});

	test('last active excludes current and never-visited workbenches', () => {
		const current = {
			...createPick({ projectId: 'current', isCurrent: true }),
			lastVisitedAt: 30,
		};
		const visited = {
			...createPick({ projectId: 'visited' }),
			lastVisitedAt: 20,
		};
		const neverVisited = createPick({ projectId: 'never' });

		assert.deepStrictEqual({
			selected: getLastActiveSwitchWorkbenchPick([
				current,
				visited,
				neverVisited,
			])?.worktreePath,
			empty: getLastActiveSwitchWorkbenchPick([
				current,
				neverVisited,
			]),
		}, {
			selected: '/tmp/visited',
			empty: undefined,
		});
	});
});

function createPick(options: {
	readonly projectId: string;
	readonly label?: string;
	readonly description?: string;
	readonly branch?: string;
	readonly detail?: string;
	readonly isCurrent?: boolean;
	readonly isLoaded?: boolean;
	readonly isDormant?: boolean;
	readonly logicalOrder?: number;
}): SwitchWorktreeQuickPick {
	const label = options.label ?? `$(folder) ${options.projectId}`;
	const description = options.description ?? 'local';
	const branch = options.branch ?? 'main';
	return {
		projectId: options.projectId,
		worktreePath: `/tmp/${options.projectId}`,
		label,
		description,
		detail: options.detail ?? `${branch} - /tmp/${options.projectId}`,
		isCurrent: options.isCurrent ?? false,
		isLoaded: options.isLoaded ?? false,
		isDormant: options.isDormant,
		logicalOrder: options.logicalOrder ?? 0,
		projectOrder: 0,
		worktreeOrder: 0,
		searchFields: [
			{ target: 'label', text: label },
			{ target: 'description', text: description },
			{ target: 'detail', text: branch },
		],
	};
}

function createProject(options: {
	readonly id: string;
	readonly pinned?: boolean;
	readonly worktrees: readonly WorktreeRecord[];
}): ProjectRecord {
	return {
		id: options.id,
		label: options.id,
		rootUri: URI.file(`/tmp/${options.id}`),
		pinned: options.pinned ?? false,
		order: 0,
		worktreeState: 'current',
		worktrees: options.worktrees,
	};
}

function createWorktree(
	path: string,
	options: {
		readonly isMain?: boolean;
		readonly pinned?: boolean;
	} = {}
): WorktreeRecord {
	return {
		path: `/tmp/${path}`,
		label: path,
		isMain: options.isMain ?? false,
		isDetached: false,
		pinned: options.pinned,
	};
}
