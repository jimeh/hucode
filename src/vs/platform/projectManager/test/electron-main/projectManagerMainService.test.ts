/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { basename } from '../../../../base/common/path.js';
import { isLinux } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { URI } from '../../../../base/common/uri.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { IStateService } from '../../../../platform/state/node/state.js';
import {
	CreateWorktreeOptions,
	PROJECT_MANAGER_STORAGE_KEY,
	PROJECT_MANAGER_STORAGE_VERSION,
	StoredProjectManagerState,
	WorktreeRecord
} from '../../common/projectManager.js';
import { GitWorktreeService } from '../../electron-main/gitWorktreeService.js';
import { ProjectManagerMainService } from
	'../../electron-main/projectManagerMainService.js';

class TestStateService implements IStateService {
	declare readonly _serviceBrand: undefined;

	private readonly items = new Map<string, unknown>();

	getItem<T>(key: string, defaultValue: T): T;
	getItem<T>(key: string, defaultValue?: T): T | undefined;
	getItem<T>(key: string, defaultValue?: T): T | undefined {
		return this.items.has(key)
			? this.items.get(key) as T
			: defaultValue;
	}

	setItem(
		key: string,
		data?: object | string | number | boolean | undefined | null
	): void {
		if (data === undefined) {
			this.items.delete(key);
			return;
		}

		this.items.set(key, data);
	}

	setItems(
		items: readonly {
			key: string;
			data?: object | string | number | boolean | undefined | null;
		}[]
	): void {
		for (const item of items) {
			this.setItem(item.key, item.data);
		}
	}

	removeItem(key: string): void {
		this.items.delete(key);
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

class TestGitWorktreeService {
	readonly resolvedRoots = new Map<string, string>();
	readonly worktrees = new Map<string, readonly WorktreeRecord[]>();
	readonly createdCalls: {
		projectRoot: string;
		options: CreateWorktreeOptions;
		existingPaths: readonly string[];
	}[] = [];
	readonly removedPaths: string[] = [];

	async resolveProjectRoot(cwd: string): Promise<string> {
		return this.resolvedRoots.get(cwd) ?? cwd;
	}

	async listWorktrees(projectRoot: string): Promise<readonly WorktreeRecord[]> {
		return this.worktrees.get(projectRoot) ?? [];
	}

	async createWorktree(
		projectRoot: string,
		options: CreateWorktreeOptions,
		existingPaths: readonly string[],
	): Promise<string> {
		this.createdCalls.push({ projectRoot, options, existingPaths });

		const worktreePath = options.path ??
			`${projectRoot}.worktrees/` +
			`${GitWorktreeService.sanitizeBranchName(options.branchName)}`;
		this.worktrees.set(projectRoot, [
			...(this.worktrees.get(projectRoot) ?? []),
			createLinkedWorktree(worktreePath, options.branchName),
		]);
		return worktreePath;
	}

	async removeWorktree(
		projectRoot: string,
		worktreePath: string
	): Promise<void> {
		this.removedPaths.push(worktreePath);
		this.worktrees.set(
			projectRoot,
			(this.worktrees.get(projectRoot) ?? []).filter(worktree =>
				worktree.path !== worktreePath
			)
		);
	}
}

function createMainWorktree(
	projectRoot: string,
	branch: string = 'main'
): WorktreeRecord {
	return {
		path: projectRoot,
		label: branch,
		branch,
		isMain: true,
		isDetached: false,
	};
}

function createLinkedWorktree(
	worktreePath: string,
	branch: string
): WorktreeRecord {
	return {
		path: worktreePath,
		label: branch,
		branch,
		isMain: false,
		isDetached: false,
	};
}

suite('GitWorktreeService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseWorktreeList sorts main first and extracts branches', () => {
		const worktrees = GitWorktreeService.parseWorktreeList(
			'/repo',
			[
				'worktree /repo',
				'HEAD 1111111',
				'branch refs/heads/main',
				'',
				'worktree /repo.worktrees/feature-one',
				'HEAD 2222222',
				'branch refs/heads/feature/one',
				'',
				'worktree /repo.worktrees/detached',
				'HEAD 3333333',
				'detached',
			].join('\n')
		);

		assert.deepStrictEqual(worktrees, [
			createMainWorktree('/repo'),
			{
				path: '/repo.worktrees/detached',
				label: 'detached',
				branch: undefined,
				isMain: false,
				isDetached: true,
			},
			createLinkedWorktree('/repo.worktrees/feature-one', 'feature/one'),
		]);
	});

	test('sanitizeBranchName normalizes separators and punctuation', () => {
		assert.strictEqual(
			GitWorktreeService.sanitizeBranchName('feature/hello world'),
			'feature-hello-world'
		);
	});

	test('parseWorktreeList matches the main worktree with platform casing rules', () => {
		const worktrees = GitWorktreeService.parseWorktreeList(
			'/Repo',
			[
				'worktree /repo',
				'HEAD 1111111',
				'branch refs/heads/main',
				'',
				'worktree /Repo.worktrees/feature-one',
				'HEAD 2222222',
				'branch refs/heads/feature/one',
			].join('\n')
		);

		assert.strictEqual(
			worktrees[0].path,
			isLinux ? '/Repo.worktrees/feature-one' : '/repo'
		);
		assert.strictEqual(worktrees[0].isMain, !isLinux);
		assert.strictEqual(
			worktrees.some(worktree => worktree.isMain),
			!isLinux
		);
	});
});

suite('ProjectManagerMainService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(
		stateService: TestStateService,
		gitWorktreeService: TestGitWorktreeService
	): ProjectManagerMainService {
		return disposables.add(new ProjectManagerMainService(
			stateService,
			new NullLogService(),
			gitWorktreeService
		));
	}

	test('addProject canonicalizes roots and de-duplicates projects', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.resolvedRoots.set('/repo/packages/app', '/repo');
		gitWorktreeService.resolvedRoots.set('/repo', '/repo');
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree(
				'/repo.worktrees/feature-one',
				'feature/one'
			),
		]);

		const service = createService(stateService, gitWorktreeService);
		const first = await service.addProject(URI.file('/repo/packages/app'));
		const duplicate = await service.addProject(URI.file('/repo'));
		const projects = await service.getProjects();

		assert.strictEqual(first.id, duplicate.id);
		assert.deepStrictEqual(projects.map(project => ({
			id: project.id,
			label: project.label,
			rootPath: project.rootUri.fsPath,
			worktrees: project.worktrees.map(worktree => worktree.path),
		})), [{
			id: first.id,
			label: basename('/repo'),
			rootPath: '/repo',
			worktrees: ['/repo', '/repo.worktrees/feature-one'],
		}]);
	});

	test('persists metadata and keeps pinned projects first', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/bravo', [createMainWorktree('/bravo')]);
		gitWorktreeService.worktrees.set('/alpha', [createMainWorktree('/alpha')]);

		const service = createService(stateService, gitWorktreeService);
		const bravo = await service.addProject(URI.file('/bravo'));
		const alpha = await service.addProject(URI.file('/alpha'));

		await service.renameProject(alpha.id, 'Alpha Repo');
		await service.setPinned(alpha.id, true);
		await service.setLastActiveWorktree(alpha.id, '/alpha');

		assert.deepStrictEqual((await service.getProjects()).map(project => ({
			id: project.id,
			label: project.label,
			pinned: project.pinned,
			lastActiveWorktreePath: project.lastActiveWorktreePath,
		})), [
			{
				id: alpha.id,
				label: 'Alpha Repo',
				pinned: true,
				lastActiveWorktreePath: '/alpha',
			},
			{
				id: bravo.id,
				label: 'bravo',
				pinned: false,
				lastActiveWorktreePath: undefined,
			},
		]);

		const reloadedService = createService(stateService, gitWorktreeService);
		const reloadedProjects = await reloadedService.refresh();

		assert.deepStrictEqual(reloadedProjects.map(project => ({
			id: project.id,
			label: project.label,
			pinned: project.pinned,
			order: project.order,
			lastActiveWorktreePath: project.lastActiveWorktreePath,
		})), [
			{
				id: alpha.id,
				label: 'Alpha Repo',
				pinned: true,
				order: 1,
				lastActiveWorktreePath: '/alpha',
			},
			{
				id: bravo.id,
				label: 'bravo',
				pinned: false,
				order: 1,
				lastActiveWorktreePath: undefined,
			},
		]);
	});

	test('loads persisted state lazily after service construction', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [createMainWorktree('/repo')]);

		const service = createService(stateService, gitWorktreeService);
		stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: [{
				id: 'project-1',
				label: 'Repo',
				rootPath: '/repo',
				pinned: true,
				order: 1,
				lastActiveWorktreePath: '/repo',
			}],
		} satisfies StoredProjectManagerState);

		const projects = await service.getProjects();
		assert.deepStrictEqual(projects.map(project => ({
			id: project.id,
			label: project.label,
			pinned: project.pinned,
			rootPath: project.rootUri.fsPath,
			lastActiveWorktreePath: project.lastActiveWorktreePath,
			worktrees: project.worktrees,
		})), [{
			id: 'project-1',
			label: 'Repo',
			pinned: true,
			rootPath: '/repo',
			lastActiveWorktreePath: '/repo',
			worktrees: [createMainWorktree('/repo')],
		}]);
	});

	test('applies persisted worktree order using platform path comparison rules', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
			createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
		]);
		stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: [{
				id: 'project-1',
				label: 'Repo',
				rootPath: '/repo',
				pinned: false,
				order: 1,
				worktreeOrder: ['/REPO.WORKTREES/BRAVO'],
			}],
		} satisfies StoredProjectManagerState);

		const service = createService(stateService, gitWorktreeService);
		const projects = await service.getProjects();

		assert.deepStrictEqual(
			projects[0].worktrees.map(worktree => worktree.path),
			isLinux
				? ['/repo', '/repo.worktrees/alpha', '/repo.worktrees/bravo']
				: ['/repo', '/repo.worktrees/bravo', '/repo.worktrees/alpha']
		);
	});

	test('reorders projects only within their pinned group', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/one', [createMainWorktree('/one')]);
		gitWorktreeService.worktrees.set('/two', [createMainWorktree('/two')]);
		gitWorktreeService.worktrees.set('/three', [createMainWorktree('/three')]);

		const service = createService(stateService, gitWorktreeService);
		const one = await service.addProject(URI.file('/one'));
		const two = await service.addProject(URI.file('/two'));
		const three = await service.addProject(URI.file('/three'));

		await service.setPinned(one.id, true);
		await service.moveProject(three.id, two.id);

		assert.deepStrictEqual(
			(await service.getProjects()).map(project => project.rootUri.fsPath),
			['/one', '/three', '/two']
		);

		await assert.rejects(
			service.moveProject(two.id, one.id),
			/Pinned and unpinned projects are reordered separately\./
		);
	});

	test('reorders linked worktrees and keeps the main worktree first', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
			createLinkedWorktree('/repo.worktrees/charlie', 'charlie'),
		]);

		const service = createService(stateService, gitWorktreeService);
		const project = await service.addProject(URI.file('/repo'));

		await service.moveWorktree(
			project.id,
			'/repo.worktrees/charlie',
			'/repo.worktrees/bravo'
		);
		await service.moveWorktree(
			project.id,
			'/repo.worktrees/alpha',
			'/repo'
		);

		assert.deepStrictEqual(
			(await service.getProjects())[0].worktrees.map(worktree => worktree.path),
			[
				'/repo',
				'/repo.worktrees/alpha',
				'/repo.worktrees/charlie',
				'/repo.worktrees/bravo',
			]
		);

		await assert.rejects(
			service.moveWorktree(project.id, '/repo', '/repo.worktrees/bravo'),
			/The main worktree cannot be reordered\./
		);
	});

	test('persists project and worktree ordering across reloads', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/one', [createMainWorktree('/one')]);
		gitWorktreeService.worktrees.set('/two', [createMainWorktree('/two')]);
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
			createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
		]);

		const service = createService(stateService, gitWorktreeService);
		const one = await service.addProject(URI.file('/one'));
		const two = await service.addProject(URI.file('/two'));
		const repo = await service.addProject(URI.file('/repo'));

		await service.moveProject(two.id, one.id);
		await service.moveWorktree(
			repo.id,
			'/repo.worktrees/bravo',
			'/repo.worktrees/alpha'
		);

		const reloadedService = createService(stateService, gitWorktreeService);
		const reloadedProjects = await reloadedService.refresh();

		assert.deepStrictEqual(
			reloadedProjects.map(project => project.rootUri.fsPath),
			['/two', '/one', '/repo']
		);
		assert.deepStrictEqual(
			reloadedProjects[2].worktrees.map(worktree => worktree.path),
			['/repo', '/repo.worktrees/bravo', '/repo.worktrees/alpha']
		);
	});

	test(
		'refresh clears stale last active worktrees and enforces remove guards',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
				createLinkedWorktree('/repo.worktrees/feature-one', 'feature/one'),
			]);

			const service = createService(stateService, gitWorktreeService);
			const project = await service.addProject(URI.file('/repo'));
			await service.setLastActiveWorktree(
				project.id,
				'/repo.worktrees/feature-one'
			);

			gitWorktreeService.worktrees.set('/repo', [createMainWorktree('/repo')]);
			const refreshed = await service.refresh(project.id);

			assert.strictEqual(refreshed[0].lastActiveWorktreePath, undefined);
			await assert.rejects(
				service.removeWorktree(project.id, '/repo'),
				/The main worktree cannot be removed\./
			);

			const created = await service.createWorktree(project.id, {
				branchName: 'feature/two',
				path: '/repo.worktrees/feature-two',
			});
			await service.removeWorktree(project.id, created.path);

			assert.deepStrictEqual({
				created,
				createdCalls: gitWorktreeService.createdCalls,
				removedPaths: gitWorktreeService.removedPaths,
				worktrees: (await service.getProjects())[0].worktrees,
			}, {
				created: createLinkedWorktree(
					'/repo.worktrees/feature-two',
					'feature/two'
				),
				createdCalls: [{
					projectRoot: '/repo',
					options: {
						branchName: 'feature/two',
						path: '/repo.worktrees/feature-two',
					},
					existingPaths: ['/repo'],
				}],
				removedPaths: ['/repo.worktrees/feature-two'],
				worktrees: [createMainWorktree('/repo')],
			});
		}
	);
});

suite('ProjectManagerMainService state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('storage schema constant is stable', () => {
		const state: StoredProjectManagerState = {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: [{
				id: 'project-1',
				label: 'Repo',
				rootPath: '/repo',
				pinned: false,
				order: 1,
			}],
		};

		assert.strictEqual(
			PROJECT_MANAGER_STORAGE_KEY,
			'hucode.projectManager.projects'
		);
		assert.strictEqual(state.projects[0].rootPath, '/repo');
		assert.deepStrictEqual(
			URI.file(state.projects[0].rootPath).fsPath,
			'/repo'
		);
	});
});
