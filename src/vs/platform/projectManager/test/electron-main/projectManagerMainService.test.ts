/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
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
	WorktreeRecord,
	WorktreeRefQueryOptions,
	WorktreeRefRecord
} from '../../common/projectManager.js';
import {
	GitCommandError,
	GitWorktreeService
} from '../../electron-main/gitWorktreeService.js';
import {
	ProjectManagerMainService,
	type ProjectManagerMainServiceOptions,
} from
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
	readonly commonDirs = new Map<string, string>();
	readonly adminDirs = new Map<string, readonly string[]>();
	readonly resolvedRoots = new Map<string, string>();
	readonly worktrees = new Map<string, readonly WorktreeRecord[]>();
	readonly refs = new Map<string, readonly WorktreeRefRecord[]>();
	readonly validBranchNames = new Set<string>();
	readonly listWorktreesCalls: string[] = [];
	readonly listRefsCalls: {
		projectRoot: string;
		worktrees: readonly WorktreeRecord[];
		options?: WorktreeRefQueryOptions;
	}[] = [];
	readonly createdCalls: {
		projectRoot: string;
		options: CreateWorktreeOptions;
		existingPaths: readonly string[];
	}[] = [];
	readonly removedPaths: string[] = [];

	async resolveProjectRoot(cwd: string): Promise<string> {
		return this.resolvedRoots.get(cwd) ?? cwd;
	}

	async getGitCommonDir(projectRoot: string): Promise<string> {
		return this.commonDirs.get(projectRoot) ?? `${projectRoot}/.git`;
	}

	async listWorktreeAdminDirs(
		commonGitDir: string
	): Promise<readonly string[]> {
		const configured = this.adminDirs.get(commonGitDir);
		if (configured) {
			return configured;
		}

		const projectRoot = commonGitDir.replace(/\/\.git$/, '');
		return (this.worktrees.get(projectRoot) ?? [])
			.filter(worktree => !worktree.isMain)
			.map(worktree => basename(worktree.path));
	}

	async listWorktrees(projectRoot: string): Promise<readonly WorktreeRecord[]> {
		this.listWorktreesCalls.push(projectRoot);
		return this.worktrees.get(projectRoot) ?? [];
	}

	async listRefs(
		projectRoot: string,
		worktrees: readonly WorktreeRecord[],
		options?: WorktreeRefQueryOptions
	): Promise<readonly WorktreeRefRecord[]> {
		this.listRefsCalls.push({ projectRoot, worktrees, options });
		return this.refs.get(projectRoot) ?? [];
	}

	async isValidBranchName(
		_projectRoot: string,
		branchName: string
	): Promise<boolean> {
		return this.validBranchNames.has(branchName);
	}

	async createWorktree(
		projectRoot: string,
		options: CreateWorktreeOptions,
		existingPaths: readonly string[],
	): Promise<string> {
		this.createdCalls.push({ projectRoot, options, existingPaths });

		const worktreePath = options.path ??
			`${projectRoot}.worktrees/` +
			`${GitWorktreeService.sanitizeBranchName(
				options.branchName ?? options.startPoint ?? 'HEAD'
			)}`;
		this.worktrees.set(projectRoot, [
			...(this.worktrees.get(projectRoot) ?? []),
			options.detached
				? createDetachedWorktree(worktreePath)
				: createLinkedWorktree(
					worktreePath,
					options.branchName ?? options.startPoint ?? 'HEAD'
				),
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

class TestProjectMetadataWatcher {
	readonly watchedPaths: string[] = [];
	readonly disposedPaths: string[] = [];
	private readonly listeners = new Map<string, (() => void)[]>();

	watch(path: string, onDidChange: () => void) {
		this.watchedPaths.push(path);
		const listeners = this.listeners.get(path) ?? [];
		listeners.push(onDidChange);
		this.listeners.set(path, listeners);

		return toDisposable(() => {
			this.disposedPaths.push(path);
			const nextListeners = (this.listeners.get(path) ?? [])
				.filter(listener => listener !== onDidChange);
			if (nextListeners.length) {
				this.listeners.set(path, nextListeners);
			} else {
				this.listeners.delete(path);
			}
		});
	}

	fire(path: string): void {
		for (const listener of this.listeners.get(path) ?? []) {
			listener();
		}
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

function createDetachedWorktree(worktreePath: string): WorktreeRecord {
	return {
		path: worktreePath,
		label: basename(worktreePath),
		branch: undefined,
		isMain: false,
		isDetached: true,
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

	test('parseRefList marks local branches checked out in worktrees', () => {
		const refs = GitWorktreeService.parseRefList(
			[
				[
					'refs/remotes/origin/HEAD',
					'1111111',
					'',
					'',
					'',
					'',
					'origin main',
				].join('\0'),
				[
					'refs/remotes/origin/feature/two',
					'2222222',
					'',
					'1 day ago',
					'Jim Myhrberg',
					'',
					'remote feature',
				].join('\0'),
				[
					'refs/tags/v1.0.0',
					'3333333',
					'',
					'2 months ago',
					'Jim Myhrberg',
					'',
					'release',
				].join('\0'),
				[
					'refs/heads/main',
					'4444444',
					'origin/main',
					'1 day ago',
					'Jim Myhrberg',
					'[ahead 1, behind 2]',
					'main branch',
				].join('\0'),
			].join('\n'),
			[createMainWorktree('/repo')]
		);

		assert.deepStrictEqual(refs, [
			{
				name: 'main',
				type: 'head',
				commit: '4444444',
				upstream: 'origin/main',
				tracking: 'ahead 1, behind 2',
				relativeDate: '1 day ago',
				authorName: 'Jim Myhrberg',
				subject: 'main branch',
				checkedOutPath: '/repo',
			},
			{
				name: 'origin/feature/two',
				type: 'remote',
				commit: '2222222',
				upstream: undefined,
				tracking: undefined,
				relativeDate: '1 day ago',
				authorName: 'Jim Myhrberg',
				subject: 'remote feature',
				checkedOutPath: undefined,
			},
			{
				name: 'v1.0.0',
				type: 'tag',
				commit: '3333333',
				upstream: undefined,
				tracking: undefined,
				relativeDate: '2 months ago',
				authorName: 'Jim Myhrberg',
				subject: 'release',
				checkedOutPath: undefined,
			},
		]);
	});

	test('parseRefList preserves git order for committerdate sort', () => {
		const refs = GitWorktreeService.parseRefList(
			[
				[
					'refs/remotes/origin/newer',
					'1111111',
					'',
					'1 hour ago',
					'Jim Myhrberg',
					'',
					'newer remote',
				].join('\0'),
				[
					'refs/heads/main',
					'2222222',
					'origin/main',
					'1 day ago',
					'Jim Myhrberg',
					'',
					'main branch',
				].join('\0'),
				[
					'refs/heads/alpha',
					'3333333',
					'',
					'2 days ago',
					'Jim Myhrberg',
					'',
					'older branch',
				].join('\0'),
			].join('\n'),
			[createMainWorktree('/repo')],
			'committerdate'
		);

		assert.deepStrictEqual(
			refs.map(ref => `${ref.type}:${ref.name}`),
			['remote:origin/newer', 'head:main', 'head:alpha']
		);
	});

	test('listRefs defaults to committerdate sort', async () => {
		const mutableCalls: string[][] = [];
		const format = '--format=%(refname)%00%(objectname:short)%00' +
			'%(upstream:short)%00%(committerdate:relative)%00' +
			'%(authorname)%00%(upstream:track)%00%(subject)';
		const service = new GitWorktreeService(
			new NullLogService(),
			async args => {
				mutableCalls.push([...args]);
				return { stdout: '', stderr: '' };
			},
			async () => false,
			async () => { },
		);

		await service.listRefs('/repo', []);
		await service.listRefs('/repo', [], { sort: 'alphabetically' });

		assert.deepStrictEqual(
			mutableCalls[0].slice(0, 4),
			['for-each-ref', format, '--sort', '-committerdate']
		);
		assert.strictEqual(mutableCalls[1].includes('--sort'), false);
	});

	test('createWorktree can add either a new branch or an existing ref', async () => {
		const calls: { args: readonly string[]; cwd: string }[] = [];
		const service = new GitWorktreeService(
			new NullLogService(),
			async (args, cwd) => {
				calls.push({ args, cwd });
				return { stdout: '', stderr: '' };
			},
			async () => false,
			async () => { },
		);

		await service.createWorktree(
			'/repo',
			{ branchName: 'feature/one' },
			['/repo']
		);
		await service.createWorktree(
			'/repo',
			{ startPoint: 'feature/two' },
			['/repo']
		);
		await service.createWorktree(
			'/repo',
			{
				branchName: 'feature/three',
				startPoint: 'origin/main',
			},
			['/repo']
		);
		await service.createWorktree(
			'/repo',
			{
				detached: true,
				startPoint: 'feature/four',
			},
			['/repo']
		);

		assert.deepStrictEqual(calls, [
			{
				args: [
					'worktree',
					'add',
					'-b',
					'feature/one',
					'/repo.worktrees/feature-one',
					'HEAD',
				],
				cwd: '/repo',
			},
			{
				args: [
					'worktree',
					'add',
					'/repo.worktrees/feature-two',
					'feature/two',
				],
				cwd: '/repo',
			},
			{
				args: [
					'worktree',
					'add',
					'-b',
					'feature/three',
					'/repo.worktrees/feature-three',
					'origin/main',
				],
				cwd: '/repo',
			},
			{
				args: [
					'worktree',
					'add',
					'--detach',
					'/repo.worktrees/feature-four',
					'feature/four',
				],
				cwd: '/repo',
			},
		]);
	});

	test('isValidBranchName delegates to git check-ref-format', async () => {
		const checkedNames: string[] = [];
		const service = new GitWorktreeService(
			new NullLogService(),
			async (args, _cwd) => {
				checkedNames.push(args[2]);
				if (args[2] === 'feature/two') {
					return { stdout: '', stderr: '' };
				}

				throw new Error('invalid branch name');
			},
			async () => false,
			async () => { },
		);

		assert.strictEqual(
			await service.isValidBranchName('/repo', 'feature/two'),
			true
		);
		await assert.rejects(
			service.isValidBranchName('/repo', 'feature two'),
			/invalid branch name/
		);
		assert.deepStrictEqual(checkedNames, ['feature/two', 'feature two']);
	});

	test('isValidBranchName reports git validation failures as false', async () => {
		const service = new GitWorktreeService(
			new NullLogService(),
			async () => {
				throw new GitCommandError('invalid branch name', '');
			},
			async () => false,
			async () => { },
		);

		assert.strictEqual(
			await service.isValidBranchName('/repo', 'feature two'),
			false
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
		gitWorktreeService: TestGitWorktreeService,
		now?: () => number,
		options: Omit<
			ProjectManagerMainServiceOptions,
			'gitWorktreeService' | 'now'
		> = {}
	): ProjectManagerMainService {
		return disposables.add(new ProjectManagerMainService(
			stateService,
			new NullLogService(),
			{
				gitWorktreeService,
				now,
				...options,
			}
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

	test('persists metadata and keeps project order global', async () => {
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
				id: bravo.id,
				label: 'bravo',
				pinned: false,
				lastActiveWorktreePath: undefined,
			},
			{
				id: alpha.id,
				label: 'Alpha Repo',
				pinned: true,
				lastActiveWorktreePath: '/alpha',
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
				id: bravo.id,
				label: 'bravo',
				pinned: false,
				order: 1,
				lastActiveWorktreePath: undefined,
			},
			{
				id: alpha.id,
				label: 'Alpha Repo',
				pinned: true,
				order: 2,
				lastActiveWorktreePath: '/alpha',
			},
		]);
	});

	test('tracks worktree visits for MRU switchers', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		let now = 100;
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
			createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
		]);

		const service = createService(
			stateService,
			gitWorktreeService,
			() => now
		);
		const project = await service.addProject(URI.file('/repo'));

		await service.setLastActiveWorktree(
			project.id,
			'/repo.worktrees/alpha'
		);
		now = 200;
		await service.setLastActiveWorktree(
			project.id,
			'/repo.worktrees/bravo'
		);

		assert.deepStrictEqual(
			(await service.getProjects())[0].worktrees.map(worktree => ({
				path: worktree.path,
				lastVisitedAt: worktree.lastVisitedAt,
			})),
			[
				{ path: '/repo', lastVisitedAt: undefined },
				{ path: '/repo.worktrees/alpha', lastVisitedAt: 100 },
				{ path: '/repo.worktrees/bravo', lastVisitedAt: 200 },
			]
		);

		const savedState = stateService.getItem<StoredProjectManagerState>(
			PROJECT_MANAGER_STORAGE_KEY
		);
		assert.deepStrictEqual(savedState?.projects[0].worktreeVisits, [
			{ path: '/repo.worktrees/alpha', lastVisitedAt: 100 },
			{ path: '/repo.worktrees/bravo', lastVisitedAt: 200 },
		]);

		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
		]);
		await service.refresh(project.id);

		assert.deepStrictEqual(
			stateService.getItem<StoredProjectManagerState>(
				PROJECT_MANAGER_STORAGE_KEY
			)?.projects[0].worktreeVisits,
			[{ path: '/repo.worktrees/bravo', lastVisitedAt: 200 }]
		);
	});

	test('stores canonical worktree paths for MRU visits', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
		]);

		const service = createService(stateService, gitWorktreeService, () => 300);
		const project = await service.addProject(URI.file('/repo'));

		await service.setLastActiveWorktree(
			project.id,
			isLinux ? '/repo.worktrees/alpha' : '/REPO.WORKTREES/ALPHA'
		);

		const savedState = stateService.getItem<StoredProjectManagerState>(
			PROJECT_MANAGER_STORAGE_KEY
		);
		assert.strictEqual(
			savedState?.projects[0].lastActiveWorktreePath,
			'/repo.worktrees/alpha'
		);
		assert.deepStrictEqual(savedState?.projects[0].worktreeVisits, [
			{ path: '/repo.worktrees/alpha', lastVisitedAt: 300 },
		]);

		await assert.rejects(
			service.setLastActiveWorktree(project.id, '/repo.worktrees/missing'),
			/Unknown worktree/
		);
	});

	test('resets custom project labels to root basenames', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [createMainWorktree('/repo')]);

		const service = createService(stateService, gitWorktreeService);
		const project = await service.addProject(URI.file('/repo'));
		await service.renameProject(project.id, 'Client Repo');
		await service.resetProjectLabel(project.id);

		const projects = await service.getProjects();
		assert.strictEqual(projects[0].label, 'repo');

		const savedState = stateService.getItem<StoredProjectManagerState>(
			PROJECT_MANAGER_STORAGE_KEY
		);
		assert.strictEqual(savedState?.projects[0].label, 'repo');
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

	test('auto-refreshes when watched git metadata changes', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const metadataWatcher = new TestProjectMetadataWatcher();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
		]);

		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{
				metadataWatcher,
				autoRefreshDebounceMs: 0,
				autoRefreshQuietMs: 0,
			}
		);
		await service.addProject(URI.file('/repo'));

		assert.deepStrictEqual(metadataWatcher.watchedPaths, [
			'/repo/.git/HEAD',
			'/repo/.git/worktrees',
			'/repo/.git/worktrees/alpha/HEAD',
			'/repo/.git/worktrees/alpha/gitdir',
		]);

		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'feature/alpha'),
		]);
		metadataWatcher.fire('/repo/.git/worktrees/alpha/HEAD');
		await timeout(0);
		await timeout(0);

		assert.deepStrictEqual({
			worktrees: (await service.getProjects())[0].worktrees,
			listWorktreesCalls: gitWorktreeService.listWorktreesCalls,
		}, {
			worktrees: [
				createMainWorktree('/repo'),
				createLinkedWorktree('/repo.worktrees/alpha', 'feature/alpha'),
			],
			listWorktreesCalls: ['/repo', '/repo'],
		});
	});

	test('coalesces auto-refresh events and rebuilds project watchers', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const metadataWatcher = new TestProjectMetadataWatcher();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
		]);

		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{
				metadataWatcher,
				autoRefreshDebounceMs: 0,
				autoRefreshQuietMs: 0,
			}
		);
		const project = await service.addProject(URI.file('/repo'));

		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
			createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
		]);
		metadataWatcher.fire('/repo/.git/worktrees');
		metadataWatcher.fire('/repo/.git/worktrees');
		await timeout(0);
		await timeout(0);

		assert.deepStrictEqual({
			listWorktreesCalls: gitWorktreeService.listWorktreesCalls,
			watchedPaths: metadataWatcher.watchedPaths,
			disposedPaths: metadataWatcher.disposedPaths,
			worktrees: (await service.getProjects())[0].worktrees,
		}, {
			listWorktreesCalls: ['/repo', '/repo'],
			watchedPaths: [
				'/repo/.git/HEAD',
				'/repo/.git/worktrees',
				'/repo/.git/worktrees/alpha/HEAD',
				'/repo/.git/worktrees/alpha/gitdir',
				'/repo/.git/HEAD',
				'/repo/.git/worktrees',
				'/repo/.git/worktrees/alpha/HEAD',
				'/repo/.git/worktrees/alpha/gitdir',
				'/repo/.git/worktrees/bravo/HEAD',
				'/repo/.git/worktrees/bravo/gitdir',
			],
			disposedPaths: [
				'/repo/.git/HEAD',
				'/repo/.git/worktrees',
				'/repo/.git/worktrees/alpha/HEAD',
				'/repo/.git/worktrees/alpha/gitdir',
			],
			worktrees: [
				createMainWorktree('/repo'),
				createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
				createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
			],
		});

		await service.removeProject(project.id);
		assert.deepStrictEqual(
			metadataWatcher.disposedPaths.slice(-6),
			[
				'/repo/.git/HEAD',
				'/repo/.git/worktrees',
				'/repo/.git/worktrees/alpha/HEAD',
				'/repo/.git/worktrees/alpha/gitdir',
				'/repo/.git/worktrees/bravo/HEAD',
				'/repo/.git/worktrees/bravo/gitdir',
			]
		);
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

	test('persists worktree pinning separately from project pinning', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
			createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
		]);

		const service = createService(stateService, gitWorktreeService);
		const project = await service.addProject(URI.file('/repo'));

		await service.setWorktreePinned(
			project.id,
			'/repo.worktrees/alpha',
			true
		);
		await service.setPinned(project.id, true);
		await service.setPinned(project.id, false);

		assert.deepStrictEqual((await service.getProjects())[0].worktrees, [
			createMainWorktree('/repo'),
			{
				...createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
				pinned: true,
			},
			createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
		]);

		const reloadedService = createService(stateService, gitWorktreeService);
		const reloadedProject = (await reloadedService.refresh())[0];

		assert.deepStrictEqual({
			projectPinned: reloadedProject.pinned,
			worktrees: reloadedProject.worktrees,
		}, {
			projectPinned: false,
			worktrees: [
				createMainWorktree('/repo'),
				{
					...createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
					pinned: true,
				},
				createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
			],
		});
	});

	test('applies persisted worktree pins using platform path rules', async () => {
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
				pinnedWorktreePaths: ['/REPO.WORKTREES/BRAVO'],
			}],
		} satisfies StoredProjectManagerState);

		const service = createService(stateService, gitWorktreeService);
		const projects = await service.getProjects();

		assert.deepStrictEqual(
			projects[0].worktrees.map(worktree => ({
				path: worktree.path,
				pinned: worktree.pinned,
			})),
			isLinux
				? [
					{ path: '/repo', pinned: undefined },
					{ path: '/repo.worktrees/alpha', pinned: undefined },
					{ path: '/repo.worktrees/bravo', pinned: undefined },
				]
				: [
					{ path: '/repo', pinned: undefined },
					{ path: '/repo.worktrees/alpha', pinned: undefined },
					{ path: '/repo.worktrees/bravo', pinned: true },
				]
		);
	});

	test('persists custom worktree labels across refreshes', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'feature/alpha'),
		]);

		const service = createService(stateService, gitWorktreeService);
		const project = await service.addProject(URI.file('/repo'));
		await service.renameWorktree(
			project.id,
			'/repo.worktrees/alpha',
			'Client Alpha'
		);

		assert.deepStrictEqual(
			(await service.getProjects())[0].worktrees.map(worktree => ({
				path: worktree.path,
				label: worktree.label,
				customLabel: worktree.customLabel,
				branch: worktree.branch,
			})),
			[
				{
					path: '/repo',
					label: 'main',
					customLabel: undefined,
					branch: 'main',
				},
				{
					path: '/repo.worktrees/alpha',
					label: 'feature/alpha',
					customLabel: 'Client Alpha',
					branch: 'feature/alpha',
				},
			]
		);

		const reloadedService = createService(stateService, gitWorktreeService);
		assert.deepStrictEqual(
			(await reloadedService.refresh())[0].worktrees.map(worktree => ({
				path: worktree.path,
				customLabel: worktree.customLabel,
				branch: worktree.branch,
			})),
			[
				{
					path: '/repo',
					customLabel: undefined,
					branch: 'main',
				},
				{
					path: '/repo.worktrees/alpha',
					customLabel: 'Client Alpha',
					branch: 'feature/alpha',
				},
			]
		);
	});

	test('resets custom worktree labels to default display names', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'feature/alpha'),
		]);

		const service = createService(stateService, gitWorktreeService);
		const project = await service.addProject(URI.file('/repo'));
		await service.renameWorktree(
			project.id,
			'/repo.worktrees/alpha',
			'Client Alpha'
		);
		await service.resetWorktreeLabel(project.id, '/repo.worktrees/alpha');

		const worktree = (await service.getProjects())[0].worktrees[1];
		assert.strictEqual(worktree.path, '/repo.worktrees/alpha');
		assert.strictEqual(worktree.label, 'feature/alpha');
		assert.strictEqual(worktree.customLabel, undefined);
		assert.strictEqual(worktree.branch, 'feature/alpha');

		const savedState = stateService.getItem<StoredProjectManagerState>(
			PROJECT_MANAGER_STORAGE_KEY
		);
		assert.strictEqual(savedState?.projects[0].worktreeLabels, undefined);
	});

	test('prunes custom worktree labels for removed worktrees', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
			createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
		]);

		const service = createService(stateService, gitWorktreeService);
		const project = await service.addProject(URI.file('/repo'));
		await service.renameWorktree(
			project.id,
			'/repo.worktrees/alpha',
			'Alpha Custom'
		);
		await service.renameWorktree(
			project.id,
			'/repo.worktrees/bravo',
			'Bravo Custom'
		);

		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/bravo', 'bravo'),
		]);
		await service.refresh(project.id);

		const savedState = stateService.getItem<StoredProjectManagerState>(
			PROJECT_MANAGER_STORAGE_KEY
		);
		assert.deepStrictEqual(
			savedState?.projects[0].worktreeLabels,
			[{ path: '/repo.worktrees/bravo', label: 'Bravo Custom' }]
		);
	});

	test('reorders projects across pinned states', async () => {
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
			(await service.getProjects()).map(project => ({
				path: project.rootUri.fsPath,
				pinned: project.pinned,
			})),
			[
				{ path: '/three', pinned: false },
				{ path: '/two', pinned: false },
				{ path: '/one', pinned: true },
			]
		);

		await service.moveProject(one.id, three.id);

		assert.deepStrictEqual(
			(await service.getProjects()).map(project => ({
				path: project.rootUri.fsPath,
				pinned: project.pinned,
			})),
			[
				{ path: '/one', pinned: true },
				{ path: '/three', pinned: false },
				{ path: '/two', pinned: false },
			]
		);
	});

	test('reorders worktree-pinned projects with pinned projects', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/one', [createMainWorktree('/one')]);
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
		]);

		const service = createService(stateService, gitWorktreeService);
		const one = await service.addProject(URI.file('/one'));
		const repo = await service.addProject(URI.file('/repo'));

		await service.setPinned(one.id, true);
		await service.setWorktreePinned(
			repo.id,
			'/repo.worktrees/alpha',
			true
		);
		await service.moveProject(repo.id, one.id);

		assert.deepStrictEqual((await service.getProjects()).map(project => ({
			rootPath: project.rootUri.fsPath,
			projectPinned: project.pinned,
			pinnedWorktrees: project.worktrees
				.filter(worktree => worktree.pinned)
				.map(worktree => worktree.path),
		})), [
			{
				rootPath: '/repo',
				projectPinned: false,
				pinnedWorktrees: ['/repo.worktrees/alpha'],
			},
			{
				rootPath: '/one',
				projectPinned: true,
				pinnedWorktrees: [],
			},
		]);
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

	test('refresh prunes stale pinned worktree paths', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/feature-one', 'feature/one'),
		]);

		const service = createService(stateService, gitWorktreeService);
		const project = await service.addProject(URI.file('/repo'));
		await service.setWorktreePinned(
			project.id,
			'/repo.worktrees/feature-one',
			true
		);

		gitWorktreeService.worktrees.set('/repo', [createMainWorktree('/repo')]);
		const refreshed = await service.refresh(project.id);
		const state = stateService.getItem<StoredProjectManagerState>(
			PROJECT_MANAGER_STORAGE_KEY
		);

		assert.deepStrictEqual({
			worktrees: refreshed[0].worktrees,
			pinnedWorktreePaths: state?.projects[0].pinnedWorktreePaths,
		}, {
			worktrees: [createMainWorktree('/repo')],
			pinnedWorktreePaths: undefined,
		});
	});
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
