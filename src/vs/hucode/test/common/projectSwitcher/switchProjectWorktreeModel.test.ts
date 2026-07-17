/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { URI } from '../../../../base/common/uri.js';
import { ProjectRecord, WorktreeRecord } from
	'../../../../platform/projectManager/common/projectManager.js';
import {
	filterSwitchWorktreePicks,
	getAdjacentProjectWorktreeTarget,
	getDefaultSwitchWorktreeActivePick,
	getLoadedProjectWorktreeTargets,
	getLoadedSwitchWorktreePicks,
	getVisualProjectWorktreeTargets,
	sortProjectSwitcherNavigationHistory,
	SwitchWorktreeQuickPick,
	withSwitchWorktreeSeparators,
} from '../../../common/projectSwitcher/switchProjectWorktreeModel.js';

suite('SwitchProjectWorktreeModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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

	test('groups current, loaded, dormant, and not loaded picks', () => {
		const current = createPick({
			projectId: 'current',
			isCurrent: true,
			isLoaded: true,
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
