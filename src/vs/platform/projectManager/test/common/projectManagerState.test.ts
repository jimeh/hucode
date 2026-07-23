/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	PROJECT_MANAGER_STORAGE_VERSION,
	StoredProjectManagerState,
	StoredProjectRecord,
	WorktreeRecord,
} from '../../common/projectManager.js';
import {
	applyStoredWorktreeLabels,
	applyStoredWorktreeOrder,
	applyStoredWorktreePins,
	applyStoredWorktreeVisits,
	createStoredProjectManagerState,
	filterStoredWorktreePath,
	getProjectManagerPathComparisonKey,
	loadStoredProjectManagerState,
	projectManagerPathsEqual,
	pruneStoredPinnedWorktreePaths,
	pruneStoredWorktreeLabels,
	pruneStoredWorktreeOrder,
	pruneStoredWorktreeVisits,
	setStoredWorktreeVisited,
} from '../../common/projectManagerState.js';

suite('ProjectManagerState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const project = (overrides: Partial<StoredProjectRecord> = {}) => ({
		id: 'project',
		label: 'Repo',
		rootPath: '/repo',
		pinned: false,
		order: 1,
		...overrides,
	} satisfies StoredProjectRecord);

	const worktree = (
		path: string,
		label: string,
		overrides: Partial<WorktreeRecord> = {}
	) => ({
		path,
		label,
		isMain: false,
		isDetached: false,
		...overrides,
	} satisfies WorktreeRecord);

	test('loads compatible stored state as cloned records', () => {
		const sourceProject = project({
			pinnedWorktreePaths: ['/repo/feature'],
			worktreeOrder: ['/repo/feature'],
			worktreeLabels: [
				{ path: '/repo/feature', label: 'Feature' },
			],
			worktreeVisits: [
				{ path: '/repo/feature', lastVisitedAt: 10 },
			],
		});
		const state: StoredProjectManagerState = {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: [sourceProject],
		};

		const projects = loadStoredProjectManagerState(state);
		assert.deepStrictEqual(projects, [sourceProject]);
		assert.notStrictEqual(projects[0], sourceProject);
		assert.notStrictEqual(
			projects[0].pinnedWorktreePaths,
			sourceProject.pinnedWorktreePaths
		);
		assert.notStrictEqual(
			projects[0].worktreeOrder,
			sourceProject.worktreeOrder
		);
		assert.notStrictEqual(
			projects[0].worktreeLabels,
			sourceProject.worktreeLabels
		);
		assert.notStrictEqual(
			projects[0].worktreeLabels?.[0],
			sourceProject.worktreeLabels?.[0]
		);
		assert.notStrictEqual(
			projects[0].worktreeVisits,
			sourceProject.worktreeVisits
		);
		assert.notStrictEqual(
			projects[0].worktreeVisits?.[0],
			sourceProject.worktreeVisits?.[0]
		);
		assert.deepStrictEqual(
			createStoredProjectManagerState(projects),
			state
		);
	});

	test('ignores missing or incompatible stored state', () => {
		assert.deepStrictEqual(loadStoredProjectManagerState(undefined), []);
		assert.deepStrictEqual(loadStoredProjectManagerState({
			version: PROJECT_MANAGER_STORAGE_VERSION + 1,
			projects: [project()],
		}), []);
	});

	test('compares paths using platform sensitivity', () => {
		assert.strictEqual(
			projectManagerPathsEqual('/Repo', '/repo', true),
			false
		);
		assert.strictEqual(
			projectManagerPathsEqual('/Repo', '/repo', false),
			true
		);
		assert.deepStrictEqual(
			filterStoredWorktreePath(['/Repo', '/other'], '/repo', false),
			['/other']
		);
		assert.strictEqual(
			getProjectManagerPathComparisonKey('/Repo', true),
			'/Repo'
		);
		assert.strictEqual(
			getProjectManagerPathComparisonKey('/Repo', false),
			'/repo'
		);
	});

	test('applies labels, order, visits, and pins', () => {
		const stored = project({
			worktreeLabels: [{ path: '/repo/feature', label: 'Feature' }],
			worktreeOrder: ['/repo/feature'],
			worktreeVisits: [{
				path: '/repo/main',
				lastVisitedAt: 10,
			}],
			pinnedWorktreePaths: ['/repo/feature'],
		});
		const worktrees = [
			worktree('/repo/main', 'main', { isMain: true }),
			worktree('/repo/zeta', 'zeta'),
			worktree('/repo/feature', 'feature'),
		];

		const labeled = applyStoredWorktreeLabels(stored, worktrees, true);
		const ordered = applyStoredWorktreeOrder(stored, labeled, true);
		const visited = applyStoredWorktreeVisits(stored, ordered, true);
		const pinned = applyStoredWorktreePins(stored, visited, true);

		assert.deepStrictEqual(
			pinned.map(entry => ({
				path: entry.path,
				customLabel: entry.customLabel,
				pinned: entry.pinned,
				lastVisitedAt: entry.lastVisitedAt,
			})),
			[
				{
					path: '/repo/main',
					customLabel: undefined,
					pinned: undefined,
					lastVisitedAt: 10
				},
				{
					path: '/repo/feature',
					customLabel: 'Feature',
					pinned: true,
					lastVisitedAt: undefined
				},
				{
					path: '/repo/zeta',
					customLabel: undefined,
					pinned: undefined,
					lastVisitedAt: undefined
				},
			]
		);
	});

	test('sets visits and prunes stale worktree metadata', () => {
		const stored = project({
			worktreeOrder: ['/repo/feature', '/repo/missing'],
			worktreeLabels: [
				{ path: '/repo/feature', label: 'Feature' },
				{ path: '/repo/missing', label: 'Missing' },
			],
			worktreeVisits: [
				{ path: '/repo/feature', lastVisitedAt: 10 },
				{ path: '/repo/missing', lastVisitedAt: 5 },
			],
			pinnedWorktreePaths: ['/repo/feature', '/repo/missing'],
		});
		const worktrees = [worktree('/repo/feature', 'feature')];

		setStoredWorktreeVisited(stored, '/repo/feature', 20, true);
		pruneStoredWorktreeOrder(stored, worktrees, true);
		pruneStoredWorktreeLabels(stored, worktrees, true);
		pruneStoredWorktreeVisits(stored, worktrees, true);
		pruneStoredPinnedWorktreePaths(stored, worktrees, true);

		assert.deepStrictEqual(stored.worktreeOrder, ['/repo/feature']);
		assert.deepStrictEqual(stored.worktreeLabels, [
			{ path: '/repo/feature', label: 'Feature' },
		]);
		assert.deepStrictEqual(stored.worktreeVisits, [
			{ path: '/repo/feature', lastVisitedAt: 20 },
		]);
		assert.deepStrictEqual(stored.pinnedWorktreePaths, ['/repo/feature']);
	});
});
