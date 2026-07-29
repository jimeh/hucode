/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as cp from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
	DeferredPromise,
	timeout,
} from '../../../../base/common/async.js';
import {
	CancellationToken,
	CancellationTokenSource,
} from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
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
	ProjectRecord,
	StoredProjectManagerState,
	WorktreeRecord,
	WorktreeRefQueryOptions,
	WorktreeRefRecord
} from '../../common/projectManager.js';
import {
	GitCommandError,
	GitCommandPolicy,
	GitWorktreeService
} from '../../node/gitWorktreeService.js';
import {
	ProjectManagerMainService,
	type ProjectManagerMainServiceOptions,
} from
	'../../node/projectManagerMainService.js';

class TestStateService implements IStateService {
	declare readonly _serviceBrand: undefined;

	private readonly items = new Map<string, unknown>();
	setItemError: Error | undefined;
	setItemCalls = 0;

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
		this.setItemCalls++;
		if (this.setItemError) {
			throw this.setItemError;
		}
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

class TestLogService extends NullLogService {
	readonly warnings: (string | Error)[] = [];

	override warn(message: string | Error, ..._args: unknown[]): void {
		this.warnings.push(message);
	}
}

class TestGitWorktreeService {
	readonly commonDirs = new Map<string, string>();
	readonly commonDirErrors = new Set<string>();
	readonly adminDirs = new Map<string, readonly string[]>();
	readonly resolvedRoots = new Map<string, string>();
	readonly worktrees = new Map<string, readonly WorktreeRecord[]>();
	readonly refs = new Map<string, readonly WorktreeRefRecord[]>();
	readonly validBranchNames = new Set<string>();
	readonly listWorktreesCalls: string[] = [];
	readonly listWorktreesTokens: CancellationToken[] = [];
	readonly commonDirTokens: CancellationToken[] = [];
	listWorktreesHandler?: (
		projectRoot: string,
		token: CancellationToken
	) => Promise<readonly WorktreeRecord[]>;
	readonly listRefsCalls: {
		projectRoot: string;
		worktrees: readonly WorktreeRecord[];
		options?: WorktreeRefQueryOptions;
	}[] = [];
	readonly listRefsTokens: CancellationToken[] = [];
	readonly branchNameTokens: CancellationToken[] = [];
	readonly createdCalls: {
		projectRoot: string;
		options: CreateWorktreeOptions;
		existingPaths: readonly string[];
	}[] = [];
	readonly removedPaths: string[] = [];

	async resolveProjectRoot(cwd: string): Promise<string> {
		return this.resolvedRoots.get(cwd) ?? cwd;
	}

	async getGitCommonDir(
		projectRoot: string,
		token: CancellationToken = CancellationToken.None
	): Promise<string> {
		this.commonDirTokens.push(token);
		if (this.commonDirErrors.has(projectRoot)) {
			throw new Error(`No git common dir for ${projectRoot}.`);
		}
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

	async listWorktrees(
		projectRoot: string,
		token: CancellationToken = CancellationToken.None
	): Promise<readonly WorktreeRecord[]> {
		this.listWorktreesCalls.push(projectRoot);
		this.listWorktreesTokens.push(token);
		if (this.listWorktreesHandler) {
			return this.listWorktreesHandler(projectRoot, token);
		}
		return this.worktrees.get(projectRoot) ?? [];
	}

	async listRefs(
		projectRoot: string,
		worktrees: readonly WorktreeRecord[],
		options?: WorktreeRefQueryOptions,
		token: CancellationToken = CancellationToken.None
	): Promise<readonly WorktreeRefRecord[]> {
		this.listRefsCalls.push({ projectRoot, worktrees, options });
		this.listRefsTokens.push(token);
		return this.refs.get(projectRoot) ?? [];
	}

	async isValidBranchName(
		_projectRoot: string,
		branchName: string,
		token: CancellationToken = CancellationToken.None
	): Promise<boolean> {
		this.branchNameTokens.push(token);
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
	readonly throwPaths = new Set<string>();
	private readonly listeners = new Map<string, (() => void)[]>();

	watch(path: string, onDidChange: () => void) {
		if (this.throwPaths.has(path)) {
			throw new Error(`Cannot watch ${path}.`);
		}
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

	activeListenerCount(path: string): number {
		return this.listeners.get(path)?.length ?? 0;
	}
}

class TestRetryDelay {
	readonly delays: number[] = [];
	readonly tokens: CancellationToken[] = [];
	private readonly pending: {
		readonly resolve: () => void;
	}[] = [];

	readonly delay = (
		milliseconds: number,
		token: CancellationToken
	): Promise<void> => {
		this.delays.push(milliseconds);
		this.tokens.push(token);
		return new Promise<void>((resolve, reject) => {
			const listener = token.onCancellationRequested(() => {
				listener.dispose();
				reject(new CancellationError());
			});
			this.pending.push({
				resolve: () => {
					listener.dispose();
					resolve();
				},
			});
		});
	};

	releaseNext(): void {
		const pending = this.pending.shift();
		assert.ok(pending, 'Expected a pending retry delay.');
		pending.resolve();
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

class TestGitChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = 1234;
	readonly killSignals: (NodeJS.Signals | number | undefined)[] = [];
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killSignals.push(signal);
		return true;
	}

	exit(
		code: number | null = 0,
		signal: NodeJS.Signals | null = null
	): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit('exit', code, signal);
	}

	close(
		code: number | null = 0,
		signal: NodeJS.Signals | null = null
	): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.stdout.end();
		this.stderr.end();
		this.emit('close', code, signal);
	}
}

class TestGitTimer {
	private readonly callbacks = new Map<NodeJS.Timeout, () => void>();
	readonly delays: number[] = [];
	clearCalls = 0;

	readonly setTimeout = (
		callback: () => void,
		delay: number
	): NodeJS.Timeout => {
		const handle = {} as NodeJS.Timeout;
		this.callbacks.set(handle, callback);
		this.delays.push(delay);
		return handle;
	};

	readonly clearTimeout = (handle: NodeJS.Timeout): void => {
		this.clearCalls++;
		this.callbacks.delete(handle);
	};

	fire(): void {
		const entry = this.callbacks.entries().next().value;
		if (!entry) {
			return;
		}
		const [handle, callback] = entry;
		this.callbacks.delete(handle);
		callback?.();
	}

	get pendingCount(): number {
		return this.callbacks.size;
	}
}

function runTestGitChild(
	child: TestGitChild,
	policy: GitCommandPolicy = {
		operation: 'listRefs',
		timeoutMs: 30_000,
		maxOutputBytes: 32 * 1024 * 1024,
	},
	token: CancellationToken = CancellationToken.None,
	overrides: {
		killTree?: (pid: number, forceful: boolean) => Promise<void>;
		timer?: TestGitTimer;
		env?: NodeJS.ProcessEnv;
		warnings?: string[];
		spawn?: (
			command: string,
			args: readonly string[],
			options: cp.SpawnOptions
		) => cp.ChildProcess;
	} = {}
) {
	const timer = overrides.timer ?? new TestGitTimer();
	const warnings = overrides.warnings ?? [];
	const spawn = overrides.spawn ?? (() => child as unknown as cp.ChildProcess);
	return {
		promise: GitWorktreeService.execGit(
			['for-each-ref', 'refs/heads'],
			'/repo',
			policy,
			token,
			{
				spawn,
				killTree: overrides.killTree ?? (async () => { }),
				setTimeout: timer.setTimeout,
				clearTimeout: timer.clearTimeout,
				env: overrides.env ?? {},
				warn: message => warnings.push(message),
			}
		),
		timer,
		warnings,
	};
}

suite('GitWorktreeService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('bounds error message and stderr diagnostics with head and tail', () => {
		const exact = 'x'.repeat(8 * 1024);
		const exactError = new GitCommandError(exact, {
			kind: 'exit',
			operation: 'listRefs',
			command: 'git for-each-ref',
			stderr: exact,
		});
		assert.strictEqual(exactError.message, exact);
		assert.strictEqual(exactError.stderr, exact);

		const aboveLimit = (first: string, last: string): string =>
			first +
			'x'.repeat((8 * 1024) + 1 - first.length - last.length) +
			last;
		const message = aboveLimit('MESSAGE-FIRST', 'MESSAGE-LAST');
		const stderr = aboveLimit('STDERR-FIRST', 'STDERR-LAST');
		const boundedError = new GitCommandError(message, {
			kind: 'exit',
			operation: 'listRefs',
			command: 'git for-each-ref',
			stderr,
		});

		assert.strictEqual(Buffer.byteLength(boundedError.message), 8 * 1024);
		assert.ok(boundedError.message.startsWith('MESSAGE-FIRST'));
		assert.ok(boundedError.message.endsWith('MESSAGE-LAST'));
		assert.ok(boundedError.message.includes('diagnostic output omitted'));
		assert.strictEqual(Buffer.byteLength(boundedError.stderr), 8 * 1024);
		assert.ok(boundedError.stderr.startsWith('STDERR-FIRST'));
		assert.ok(boundedError.stderr.endsWith('STDERR-LAST'));
		assert.ok(boundedError.stderr.includes('diagnostic output omitted'));

		const emoji = '🧪';
		const boundaryValue = (first: string, last: string): string => {
			const head = first + 'h'.repeat(
				4_078 - Buffer.byteLength(first)
			);
			const tail = 't'.repeat(
				4_077 - Buffer.byteLength(last)
			) + last;
			return head + emoji + 'm'.repeat(64) + emoji + tail;
		};
		const utf8Message = boundaryValue(
			`${emoji}MESSAGE-FIRST-`,
			`-MESSAGE-LAST${emoji}`
		);
		const utf8Stderr = boundaryValue(
			`${emoji}STDERR-FIRST-`,
			`-STDERR-LAST${emoji}`
		);
		const boundedUtf8Error = new GitCommandError(utf8Message, {
			kind: 'exit',
			operation: 'listRefs',
			command: 'git for-each-ref',
			stderr: utf8Stderr,
		});

		assert.strictEqual(
			Buffer.byteLength(boundedUtf8Error.message),
			8_190
		);
		assert.ok(boundedUtf8Error.message.startsWith(
			`${emoji}MESSAGE-FIRST-`
		));
		assert.ok(boundedUtf8Error.message.endsWith(
			`-MESSAGE-LAST${emoji}`
		));
		assert.ok(boundedUtf8Error.message.includes(
			'diagnostic output omitted'
		));
		assert.strictEqual(boundedUtf8Error.message.includes('\uFFFD'), false);
		assert.strictEqual(
			Buffer.byteLength(boundedUtf8Error.stderr),
			8_190
		);
		assert.ok(boundedUtf8Error.stderr.startsWith(
			`${emoji}STDERR-FIRST-`
		));
		assert.ok(boundedUtf8Error.stderr.endsWith(
			`-STDERR-LAST${emoji}`
		));
		assert.ok(boundedUtf8Error.stderr.includes(
			'diagnostic output omitted'
		));
		assert.strictEqual(boundedUtf8Error.stderr.includes('\uFFFD'), false);
	});

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

	test('uses CancellationToken.None when no token is supplied', async () => {
		let receivedToken: CancellationToken | undefined;
		const service = new GitWorktreeService(
			new NullLogService(),
			async (_args, _cwd, _policy, token) => {
				receivedToken = token;
				return { stdout: '', stderr: '' };
			},
			async () => false,
			async () => { },
		);

		await service.listWorktrees('/repo');

		assert.strictEqual(receivedToken, CancellationToken.None);
	});

	test('forwards per-operation policy and cancellation token', async () => {
		const calls: {
			args: readonly string[];
			policy: GitCommandPolicy;
			token: CancellationToken;
		}[] = [];
		const source = new CancellationTokenSource();
		const service = new GitWorktreeService(
			new NullLogService(),
			async (args, _cwd, policy, token) => {
				calls.push({ args, policy, token });
				const stdout = args.includes('--show-toplevel')
					? '/repo\n'
					: args.includes('--git-common-dir')
						? '/repo/.git\n'
						: '';
				return { stdout, stderr: '' };
			},
			async () => false,
			async () => { },
		);

		await service.resolveProjectRoot('/repo/subdir', source.token);
		await service.getGitCommonDir('/repo', source.token);
		await service.listWorktrees('/repo', source.token);
		await service.listRefs('/repo', [], {}, source.token);
		await service.isValidBranchName('/repo', 'feature/one', source.token);
		await service.createWorktree(
			'/repo',
			{ branchName: 'feature/one' },
			[],
			source.token
		);
		await service.removeWorktree(
			'/repo',
			'/repo.worktrees/feature-one',
			source.token
		);

		assert.deepStrictEqual(
			calls.map(call => call.policy),
			[
				{
					operation: 'resolveProjectRoot',
					timeoutMs: 5_000,
					maxOutputBytes: 1024 * 1024,
				},
				{
					operation: 'resolveProjectRoot',
					timeoutMs: 5_000,
					maxOutputBytes: 1024 * 1024,
				},
				{
					operation: 'getGitCommonDir',
					timeoutMs: 5_000,
					maxOutputBytes: 1024 * 1024,
				},
				{
					operation: 'listWorktrees',
					timeoutMs: 5_000,
					maxOutputBytes: 8 * 1024 * 1024,
				},
				{
					operation: 'listRefs',
					timeoutMs: 30_000,
					maxOutputBytes: 32 * 1024 * 1024,
				},
				{
					operation: 'isValidBranchName',
					timeoutMs: 5_000,
					maxOutputBytes: 1024 * 1024,
				},
				{
					operation: 'createWorktree',
					timeoutMs: 180_000,
					maxOutputBytes: 8 * 1024 * 1024,
				},
				{
					operation: 'removeWorktree',
					timeoutMs: 60_000,
					maxOutputBytes: 8 * 1024 * 1024,
				},
			]
		);
		assert.ok(calls.every(call => call.token === source.token));
		source.dispose();
	});

	test('separates worktree paths and refs from git options', async () => {
		const calls: string[][] = [];
		const service = new GitWorktreeService(
			new NullLogService(),
			async args => {
				calls.push([...args]);
				return { stdout: '', stderr: '' };
			},
			async () => false,
			async () => { },
		);

		await service.createWorktree(
			'/repo',
			{
				startPoint: '--force',
				path: '/repo.worktrees/option-shaped-ref',
			},
			[]
		);
		await service.removeWorktree('/repo', '--option-shaped-path');

		assert.deepStrictEqual(calls, [
			[
				'worktree',
				'add',
				'--',
				'/repo.worktrees/option-shaped-ref',
				'--force',
			],
			['worktree', 'remove', '--', '--option-shaped-path'],
		]);
	});

	test('rejects option-like branch names before filesystem or Git work',
		async () => {
			let gitCalls = 0;
			let pathChecks = 0;
			let directoryCreates = 0;
			const service = new GitWorktreeService(
				new NullLogService(),
				async () => {
					gitCalls++;
					return { stdout: '', stderr: '' };
				},
				async () => {
					pathChecks++;
					return false;
				},
				async () => {
					directoryCreates++;
				},
			);

			for (const branchName of ['-D', '--force', '  --force  ']) {
				await assert.rejects(
					service.createWorktree(
						'/repo',
						{ branchName },
						[]
					),
					/Invalid branch name\./
				);
			}

			assert.deepStrictEqual({
				gitCalls,
				pathChecks,
				directoryCreates,
			}, {
				gitCalls: 0,
				pathChecks: 0,
				directoryCreates: 0,
			});
		});

	test('spawn runner collects chunks and waits for close', async () => {
		const child = new TestGitChild();
		const { promise } = runTestGitChild(child);
		let settled = false;
		void promise.finally(() => settled = true);

		child.stdout.write(Buffer.from('first'));
		child.stdout.write(Buffer.from('-second'));
		child.stderr.write(Buffer.from('warning'));
		child.emit('exit', 0, null);
		await Promise.resolve();
		assert.strictEqual(settled, false);

		child.close();
		assert.deepStrictEqual(await promise, {
			stdout: 'first-second',
			stderr: 'warning',
		});
	});

	test('spawn runner uses non-interactive environment without mutating input', async () => {
		const child = new TestGitChild();
		const inheritedEnv = {
			KEEP_ME: 'yes',
			GIT_ASKPASS: '/tmp/git-askpass',
			git_askpass: '/tmp/lower-git-askpass',
			SSH_ASKPASS: '/tmp/ssh-askpass',
			ssh_askpass: '/tmp/lower-ssh-askpass',
			VSCODE_GIT_ASKPASS_NODE: '/tmp/node',
			VSCODE_GIT_ASKPASS_MAIN: '/tmp/main.js',
			VSCODE_GIT_ASKPASS_EXTRA_ARGS: '--ms-enable-electron-run-as-node',
			VsCoDe_GiT_AskPaSs_Helper: '/tmp/mixed-helper',
			VSCODE_GIT_IPC_HANDLE: '/tmp/socket',
			GIT_TERMINAL_PROMPT: '1',
			GCM_INTERACTIVE: 'Always',
			SSH_ASKPASS_REQUIRE: 'force',
		};
		let spawnOptions: cp.SpawnOptions | undefined;
		let spawnArgs: readonly string[] | undefined;
		const { promise } = runTestGitChild(child, undefined, undefined, {
			env: inheritedEnv,
			spawn: (_command, args, options) => {
				spawnArgs = args;
				spawnOptions = options;
				return child as unknown as cp.ChildProcess;
			},
		});
		child.close();
		await promise;

		assert.deepStrictEqual(inheritedEnv, {
			KEEP_ME: 'yes',
			GIT_ASKPASS: '/tmp/git-askpass',
			git_askpass: '/tmp/lower-git-askpass',
			SSH_ASKPASS: '/tmp/ssh-askpass',
			ssh_askpass: '/tmp/lower-ssh-askpass',
			VSCODE_GIT_ASKPASS_NODE: '/tmp/node',
			VSCODE_GIT_ASKPASS_MAIN: '/tmp/main.js',
			VSCODE_GIT_ASKPASS_EXTRA_ARGS: '--ms-enable-electron-run-as-node',
			VsCoDe_GiT_AskPaSs_Helper: '/tmp/mixed-helper',
			VSCODE_GIT_IPC_HANDLE: '/tmp/socket',
			GIT_TERMINAL_PROMPT: '1',
			GCM_INTERACTIVE: 'Always',
			SSH_ASKPASS_REQUIRE: 'force',
		});
		assert.deepStrictEqual(spawnOptions?.stdio, ['ignore', 'pipe', 'pipe']);
		assert.strictEqual(spawnOptions?.windowsHide, true);
		assert.strictEqual(spawnOptions?.cwd, '/repo');
		assert.deepStrictEqual(spawnOptions?.env, {
			KEEP_ME: 'yes',
			GIT_TERMINAL_PROMPT: '0',
			GCM_INTERACTIVE: 'Never',
			SSH_ASKPASS_REQUIRE: 'never',
		});
		assert.deepStrictEqual(spawnArgs, [
			'-c',
			'core.askPass=',
			'for-each-ref',
			'refs/heads',
		]);
	});

	test('spawn runner accepts the exact aggregate byte limit', async () => {
		const child = new TestGitChild();
		const { promise } = runTestGitChild(child, {
			operation: 'listRefs',
			timeoutMs: 30_000,
			maxOutputBytes: 6,
		});
		child.stdout.write(Buffer.from('four'));
		child.stderr.write(Buffer.from('!!'));
		child.close();

		assert.deepStrictEqual(await promise, {
			stdout: 'four',
			stderr: '!!',
		});
	});

	test('spawn runner rejects one byte beyond the aggregate limit', async () => {
		const child = new TestGitChild();
		const killCalls: [number, boolean][] = [];
		const { promise } = runTestGitChild(child, {
			operation: 'listRefs',
			timeoutMs: 30_000,
			maxOutputBytes: 6,
		}, undefined, {
			killTree: async (pid, forceful) => {
				killCalls.push([pid, forceful]);
			},
		});
		child.stdout.write(Buffer.from('four'));
		child.stderr.write(Buffer.from('!!!'));

		await assert.rejects(promise, error => {
			assert.ok(error instanceof GitCommandError);
			assert.strictEqual(error.kind, 'output-limit');
			assert.strictEqual(error.operation, 'listRefs');
			assert.strictEqual(error.maxOutputBytes, 6);
			return true;
		});
		assert.deepStrictEqual(killCalls, [[1234, true]]);
		assert.strictEqual(child.stdout.destroyed, true);
		assert.strictEqual(child.stderr.destroyed, true);
	});

	test('spawn runner counts multibyte output in bytes', async () => {
		const child = new TestGitChild();
		const { promise } = runTestGitChild(child, {
			operation: 'listRefs',
			timeoutMs: 30_000,
			maxOutputBytes: 2,
		});
		child.stdout.write('€');
		child.close(null, 'SIGKILL');

		await assert.rejects(promise, (error: GitCommandError) =>
			error.kind === 'output-limit'
		);
	});

	test('listRefs parses 10,001 refs through the 32 MiB runner buffer', async () => {
		const child = new TestGitChild();
		const longSubject = 'subject-'.padEnd(96, 'x');
		const output = Array.from({ length: 10_001 }, (_, index) => [
			`refs/heads/branch-${index}`,
			'1234567',
			'',
			'1 day ago',
			'Author',
			'',
			longSubject,
		].join('\0')).join('\n');
		assert.ok(Buffer.byteLength(output) > 1024 * 1024);

		const service = new GitWorktreeService(
			new NullLogService(),
			(args, cwd, policy, token) =>
				GitWorktreeService.execGit(args, cwd, policy, token, {
					spawn: () => child as unknown as cp.ChildProcess,
					killTree: async () => { },
					env: {},
				}),
			async () => false,
			async () => { },
		);
		const refsPromise = service.listRefs('/repo', []);
		child.stdout.write(Buffer.from(output));
		child.close();
		const refs = await refsPromise;

		assert.strictEqual(refs.length, 10_001);
		assert.strictEqual(refs[10_000].name, 'branch-10000');
	});

	test('timeout kills the process tree, logs, and stays typed', async () => {
		const child = new TestGitChild();
		const timer = new TestGitTimer();
		const killCalls: [number, boolean][] = [];
		const warnings: string[] = [];
		const { promise } = runTestGitChild(child, {
			operation: 'createWorktree',
			timeoutMs: 180_000,
			maxOutputBytes: 8 * 1024 * 1024,
		}, undefined, {
			timer,
			warnings,
			killTree: async (pid, forceful) => {
				killCalls.push([pid, forceful]);
			},
		});
		timer.fire();
		child.close(null, 'SIGKILL');

		await assert.rejects(promise, error => {
			assert.ok(error instanceof GitCommandError);
			assert.strictEqual(error.kind, 'timeout');
			assert.strictEqual(error.operation, 'createWorktree');
			assert.strictEqual(error.timeoutMs, 180_000);
			return true;
		});
		assert.deepStrictEqual(killCalls, [[1234, true]]);
		assert.ok(warnings.some(message =>
			message.includes('createWorktree') &&
			message.includes('180000ms')
		));
		await Promise.resolve();
		assert.strictEqual(timer.pendingCount, 0);
		timer.fire();
		assert.deepStrictEqual(child.killSignals, []);
		assert.strictEqual(warnings.some(message =>
			message.includes('process-tree cleanup did not settle')
		), false);
	});

	test('timeout skips process cleanup after the root exits', async () => {
		const child = new TestGitChild();
		const timer = new TestGitTimer();
		const killCalls: [number, boolean][] = [];
		const warnings: string[] = [];
		const { promise } = runTestGitChild(
			child,
			undefined,
			undefined,
			{
				timer,
				warnings,
				killTree: async (pid, forceful) => {
					killCalls.push([pid, forceful]);
				},
			}
		);

		child.exit();
		timer.fire();

		await assert.rejects(promise, (error: GitCommandError) =>
			error.kind === 'timeout'
		);
		assert.strictEqual(child.stdout.destroyed, true);
		assert.strictEqual(child.stderr.destroyed, true);
		assert.deepStrictEqual(killCalls, []);
		assert.deepStrictEqual(child.killSignals, []);
		assert.deepStrictEqual(timer.delays, [30_000]);
		assert.ok(warnings.some(message =>
			message.includes('already-exited Git subprocess')
		));
	});

	test('timeout rejects while live-root process-tree cleanup hangs', async () => {
		const child = new TestGitChild();
		const timer = new TestGitTimer();
		const warnings: string[] = [];
		const { promise } = runTestGitChild(
			child,
			undefined,
			undefined,
			{
				timer,
				warnings,
				killTree: () => new Promise<void>(() => { }),
			}
		);

		timer.fire();

		let guard: ReturnType<typeof setTimeout> | undefined;
		try {
			await assert.rejects(
				Promise.race([
					promise,
					new Promise<never>((_resolve, reject) => {
						guard = setTimeout(() => {
							reject(new Error(
								'Git timeout did not settle promptly.'
							));
						}, 100);
					}),
				]),
				error => {
					assert.ok(error instanceof GitCommandError);
					assert.strictEqual(error.kind, 'timeout');
					return true;
				}
			);
		} finally {
			if (guard !== undefined) {
				clearTimeout(guard);
			}
		}
		assert.strictEqual(child.stdout.destroyed, true);
		assert.strictEqual(child.stderr.destroyed, true);
		assert.doesNotThrow(() => {
			child.emit('error', new Error('late child error'));
		});
		timer.fire();
		assert.deepStrictEqual(child.killSignals, ['SIGKILL']);
		assert.deepStrictEqual(timer.delays, [30_000, 1_000]);
		assert.ok(warnings.some(message =>
			message.includes('did not settle within 1000ms')
		));
	});

	test('cleanup watchdog falls back only once when killTree rejects late', async () => {
		const child = new TestGitChild();
		const timer = new TestGitTimer();
		let rejectCleanup: ((error: Error) => void) | undefined;
		const { promise } = runTestGitChild(
			child,
			undefined,
			undefined,
			{
				timer,
				killTree: () => new Promise<void>((_resolve, reject) => {
					rejectCleanup = reject;
				}),
			}
		);

		timer.fire();
		await assert.rejects(promise, (error: GitCommandError) =>
			error.kind === 'timeout'
		);
		timer.fire();
		rejectCleanup?.(new Error('late tree-kill failure'));
		await Promise.resolve();
		await Promise.resolve();

		assert.deepStrictEqual(child.killSignals, ['SIGKILL']);
	});

	test('pipe error rejects promptly and cleans up a live process', async () => {
		const child = new TestGitChild();
		const killCalls: [number, boolean][] = [];
		const cause = new Error('stdout read failed');
		const { promise } = runTestGitChild(
			child,
			undefined,
			undefined,
			{
				killTree: async (pid, forceful) => {
					killCalls.push([pid, forceful]);
				},
			}
		);

		child.stdout.emit('error', cause);

		await assert.rejects(promise, error => {
			assert.ok(error instanceof GitCommandError);
			assert.strictEqual(error.kind, 'spawn');
			assert.strictEqual(error.cause, cause);
			return true;
		});
		assert.strictEqual(child.stdout.destroyed, true);
		assert.strictEqual(child.stderr.destroyed, true);
		assert.deepStrictEqual(killCalls, [[1234, true]]);
	});

	test('emitted spawn error rejects promptly without process cleanup', async () => {
		const child = new TestGitChild();
		const timer = new TestGitTimer();
		const killCalls: [number, boolean][] = [];
		const cause = new Error('spawn ENOENT');
		const { promise } = runTestGitChild(
			child,
			undefined,
			undefined,
			{
				timer,
				killTree: async (pid, forceful) => {
					killCalls.push([pid, forceful]);
				},
			}
		);

		child.emit('error', cause);

		let guard: ReturnType<typeof setTimeout> | undefined;
		try {
			await assert.rejects(
				Promise.race([
					promise,
					new Promise<never>((_resolve, reject) => {
						guard = setTimeout(() => {
							reject(new Error(
								'Spawn error did not settle promptly.'
							));
						}, 100);
					}),
				]),
				error => {
					assert.ok(error instanceof GitCommandError);
					assert.strictEqual(error.kind, 'spawn');
					assert.strictEqual(error.cause, cause);
					return true;
				}
			);
		} finally {
			if (guard !== undefined) {
				clearTimeout(guard);
			}
		}

		assert.strictEqual(child.stdout.destroyed, true);
		assert.strictEqual(child.stderr.destroyed, true);
		assert.strictEqual(timer.pendingCount, 0);
		assert.strictEqual(timer.clearCalls, 1);
		assert.deepStrictEqual(killCalls, []);
		assert.deepStrictEqual(child.killSignals, []);
		assert.doesNotThrow(() => {
			child.emit('error', new Error('later spawn error'));
		});
		assert.doesNotThrow(() => {
			child.stdout.emit('error', new Error('later stdout error'));
			child.stderr.emit('error', new Error('later stderr error'));
		});
	});

	test('synchronous spawn throw rejects without installing policy hooks', async () => {
		const child = new TestGitChild();
		const timer = new TestGitTimer();
		const cause = new Error('synchronous spawn failure');
		const { promise } = runTestGitChild(
			child,
			undefined,
			undefined,
			{
				timer,
				spawn: () => {
					throw cause;
				},
			}
		);

		await assert.rejects(promise, error => {
			assert.ok(error instanceof GitCommandError);
			assert.strictEqual(error.kind, 'spawn');
			assert.strictEqual(error.cause, cause);
			assert.strictEqual(error.command, 'git for-each-ref refs/heads');
			assert.strictEqual(error.message.includes('core.askPass'), false);
			return true;
		});
		assert.strictEqual(timer.pendingCount, 0);
	});

	test('pipe error listeners remain through execution and leave on close', async () => {
		const child = new TestGitChild();
		const { promise } = runTestGitChild(child);

		assert.strictEqual(child.stdout.listenerCount('error'), 1);
		assert.strictEqual(child.stderr.listenerCount('error'), 1);
		child.close();
		await promise;

		assert.strictEqual(child.stdout.listenerCount('error'), 0);
		assert.strictEqual(child.stderr.listenerCount('error'), 0);
	});

	test('pre-spawn cancellation rejects without spawning', async () => {
		const child = new TestGitChild();
		const source = new CancellationTokenSource();
		source.cancel();
		let spawnCalls = 0;
		const { promise } = runTestGitChild(
			child,
			undefined,
			source.token,
			{
				spawn: () => {
					spawnCalls++;
					return child as unknown as cp.ChildProcess;
				},
			}
		);

		await assert.rejects(promise, error => error instanceof CancellationError);
		assert.strictEqual(spawnCalls, 0);
		source.dispose();
	});

	test('post-spawn cancellation kills and rejects with CancellationError', async () => {
		const child = new TestGitChild();
		const source = new CancellationTokenSource();
		const killCalls: [number, boolean][] = [];
		const { promise } = runTestGitChild(
			child,
			undefined,
			source.token,
			{
				killTree: async (pid, forceful) => {
					killCalls.push([pid, forceful]);
				},
			}
		);
		source.cancel();

		await assert.rejects(promise, error => error instanceof CancellationError);
		assert.deepStrictEqual(killCalls, [[1234, true]]);
		assert.strictEqual(child.stdout.destroyed, true);
		assert.strictEqual(child.stderr.destroyed, true);
		source.dispose();
	});

	test('classifies exit, spawn, and signal failures', async () => {
		const exitChild = new TestGitChild();
		const exitRun = runTestGitChild(exitChild);
		exitChild.stderr.write('bad ref');
		exitChild.close(2);
		await assert.rejects(exitRun.promise, error => {
			assert.ok(error instanceof GitCommandError);
			assert.strictEqual(error.kind, 'exit');
			assert.strictEqual(error.code, 2);
			assert.strictEqual(error.stderr, 'bad ref');
			assert.ok(error.command.length <= 512);
			return true;
		});

		const spawnChild = new TestGitChild();
		const spawnRun = runTestGitChild(spawnChild);
		const spawnCause = new Error('spawn ENOENT');
		spawnChild.emit('error', spawnCause);
		spawnChild.close(-2);
		await assert.rejects(spawnRun.promise, error => {
			assert.ok(error instanceof GitCommandError);
			assert.strictEqual(error.kind, 'spawn');
			assert.strictEqual(error.cause, spawnCause);
			return true;
		});

		const signalChild = new TestGitChild();
		const signalRun = runTestGitChild(signalChild);
		signalChild.close(null, 'SIGTERM');
		await assert.rejects(signalRun.promise, error => {
			assert.ok(error instanceof GitCommandError);
			assert.strictEqual(error.kind, 'signal');
			assert.strictEqual(error.signal, 'SIGTERM');
			return true;
		});
	});

	test('falls back to child SIGKILL when killTree fails', async () => {
		const child = new TestGitChild();
		const timer = new TestGitTimer();
		const warnings: string[] = [];
		const { promise } = runTestGitChild(child, undefined, undefined, {
			timer,
			warnings,
			killTree: async () => {
				throw new Error('tree kill failed');
			},
		});
		timer.fire();
		await Promise.resolve();
		await Promise.resolve();
		child.close(null, 'SIGKILL');

		await assert.rejects(promise, (error: GitCommandError) =>
			error.kind === 'timeout'
		);
		assert.deepStrictEqual(child.killSignals, ['SIGKILL']);
		assert.ok(warnings.some(message => message.includes('tree kill failed')));
	});

	test('keeps the first policy failure when outcomes race', async () => {
		const child = new TestGitChild();
		const timer = new TestGitTimer();
		const source = new CancellationTokenSource();
		const { promise } = runTestGitChild(child, {
			operation: 'listRefs',
			timeoutMs: 30_000,
			maxOutputBytes: 1,
		}, source.token, { timer });
		child.stdout.write('too large');
		source.cancel();
		timer.fire();
		child.close(null, 'SIGKILL');

		await assert.rejects(promise, (error: GitCommandError) =>
			error.kind === 'output-limit'
		);
		source.dispose();
	});

	test('close clears policy hooks and prevents late kills', async () => {
		const child = new TestGitChild();
		const timer = new TestGitTimer();
		const source = new CancellationTokenSource();
		const killCalls: [number, boolean][] = [];
		const { promise } = runTestGitChild(
			child,
			undefined,
			source.token,
			{
				timer,
				killTree: async (pid, forceful) => {
					killCalls.push([pid, forceful]);
				},
			}
		);
		child.close();
		await promise;
		source.cancel();
		timer.fire();

		assert.strictEqual(timer.clearCalls, 1);
		assert.deepStrictEqual(killCalls, []);
		source.dispose();
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
					'--',
					'/repo.worktrees/feature-one',
					'HEAD',
				],
				cwd: '/repo',
			},
			{
				args: [
					'worktree',
					'add',
					'--',
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
					'--',
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
					'--',
					'/repo.worktrees/feature-four',
					'feature/four',
				],
				cwd: '/repo',
			},
		]);
	});

	test('createWorktree resolves relative custom paths before adding', async () => {
		const calls: { args: readonly string[]; cwd: string }[] = [];
		const checkedPaths: string[] = [];
		const createdDirs: string[] = [];
		const service = new GitWorktreeService(
			new NullLogService(),
			async (args, cwd) => {
				calls.push({ args, cwd });
				return { stdout: '', stderr: '' };
			},
			async path => {
				checkedPaths.push(path);
				return false;
			},
			async path => {
				createdDirs.push(path);
			},
		);

		const worktreePath = await service.createWorktree(
			'/workspace/repo',
			{ path: 'custom/feature', startPoint: 'origin/main' },
			[]
		);

		assert.deepStrictEqual({
			worktreePath,
			checkedPaths,
			createdDirs,
			calls,
		}, {
			worktreePath: '/workspace/custom/feature',
			checkedPaths: ['/workspace/custom/feature'],
			createdDirs: ['/workspace/custom'],
			calls: [{
				args: [
					'worktree',
					'add',
					'--',
					'/workspace/custom/feature',
					'origin/main',
				],
				cwd: '/workspace/repo',
			}],
		});
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
				throw new GitCommandError('invalid branch name', {
					kind: 'exit',
					operation: 'isValidBranchName',
					command: 'git check-ref-format --branch feature/two',
					stderr: '',
					code: 1,
				});
			},
			async () => false,
			async () => { },
		);

		assert.strictEqual(
			await service.isValidBranchName('/repo', 'feature two'),
			false
		);
	});

	test('isValidBranchName propagates policy failures', async () => {
		for (const kind of [
			'timeout',
			'output-limit',
			'spawn',
			'signal',
		] as const) {
			const failure = new GitCommandError(`git ${kind}`, {
				kind,
				operation: 'isValidBranchName',
				command: 'git check-ref-format --branch feature/two',
				stderr: '',
				timeoutMs: kind === 'timeout' ? 5_000 : undefined,
				maxOutputBytes: kind === 'output-limit'
					? 1024 * 1024
					: undefined,
				signal: kind === 'signal' ? 'SIGKILL' : undefined,
			});
			const service = new GitWorktreeService(
				new NullLogService(),
				async () => {
					throw failure;
				},
				async () => false,
				async () => { },
			);

			await assert.rejects(
				service.isValidBranchName('/repo', 'feature/two'),
				error => error === failure
			);
		}
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
		> = {},
		logService: NullLogService = new NullLogService()
	): ProjectManagerMainService {
		return disposables.add(new ProjectManagerMainService(
			stateService,
			logService,
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

	test('concurrent startup callers join one hydration result', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const discovery =
			new DeferredPromise<readonly WorktreeRecord[]>();
		stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: [{
				id: 'project-1',
				label: 'Repo',
				rootPath: '/repo',
				pinned: false,
				order: 1,
			}],
		} satisfies StoredProjectManagerState);
		gitWorktreeService.listWorktreesHandler = async () => discovery.p;
		const service = createService(stateService, gitWorktreeService);

		const firstGet = service.getProjects();
		const secondGet = service.getProjects();
		const rename = service.renameWorktree(
			'project-1',
			'/repo',
			'Startup Repo'
		);
		await timeout(0);

		assert.strictEqual(gitWorktreeService.listWorktreesCalls.length, 1);
		assert.strictEqual(
			gitWorktreeService.listWorktreesTokens[0].isCancellationRequested,
			false
		);

		discovery.complete([createMainWorktree('/repo')]);
		const [first, second] = await Promise.all([firstGet, secondGet]);
		await rename;

		for (const projects of [first, second]) {
			assert.strictEqual(projects[0].worktreeState, 'current');
			assert.deepStrictEqual(
				projects[0].worktrees.map(worktree => worktree.path),
				['/repo']
			);
		}
		const final = (await service.getProjects())[0];
		assert.strictEqual(final.worktrees[0].customLabel, 'Startup Repo');
		assert.strictEqual(gitWorktreeService.listWorktreesCalls.length, 1);
	});

	test('concurrent hydration followers publish one shared result', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const discovery =
			new DeferredPromise<readonly WorktreeRecord[]>();
		stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: [{
				id: 'project-1',
				label: 'Repo',
				rootPath: '/repo',
				pinned: false,
				order: 1,
			}],
		} satisfies StoredProjectManagerState);
		gitWorktreeService.listWorktreesHandler = async () => discovery.p;
		const service = createService(stateService, gitWorktreeService);
		const events: (readonly ProjectRecord[])[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects)
		));

		const firstGet = service.getProjects();
		const secondGet = service.getProjects();
		await timeout(0);
		discovery.complete([createMainWorktree('/repo')]);
		await Promise.all([firstGet, secondGet]);

		assert.strictEqual(gitWorktreeService.listWorktreesCalls.length, 1);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0][0].worktreeState, 'current');
	});

	test('successful hydration retries publication without rerunning Git',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const retry = new TestRetryDelay();
			const logService = new TestLogService();
			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
				version: PROJECT_MANAGER_STORAGE_VERSION,
				projects: [{
					id: 'project-1',
					label: 'Repo',
					rootPath: '/repo',
					pinned: false,
					order: 1,
				}],
			} satisfies StoredProjectManagerState);
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{ retryDelay: retry.delay },
				logService
			);
			const events: (readonly ProjectRecord[])[] = [];
			disposables.add(service.onDidChangeProjects(projects =>
				events.push(projects)
			));
			const savedBefore = stateService.setItemCalls;
			stateService.setItemError = new Error('state save failed');

			const hydrated = (await service.getProjects())[0];

			assert.strictEqual(hydrated.worktreeState, 'current');
			assert.strictEqual(events.length, 0);
			assert.strictEqual(
				stateService.setItemCalls,
				savedBefore + 1
			);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				1
			);
			assert.deepStrictEqual(retry.delays, [1000]);
			assert.ok(logService.warnings.some(warning =>
				String(warning).includes(
					'Failed to publish hydration /repo:'
				) &&
				String(warning).includes('state save failed')
			));
			const retryToken = retry.tokens[0];

			stateService.setItemError = undefined;
			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0][0].worktreeState, 'current');
			assert.strictEqual(
				stateService.setItemCalls,
				savedBefore + 2
			);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				1
			);
			assert.strictEqual(new Set(retry.tokens).size, 1);
			assert.strictEqual(retryToken.isCancellationRequested, false);
		});

	test('superseding refresh cancels pending hydration publication',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const retry = new TestRetryDelay();
			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
				version: PROJECT_MANAGER_STORAGE_VERSION,
				projects: [{
					id: 'project-1',
					label: 'Repo',
					rootPath: '/repo',
					pinned: false,
					order: 1,
				}],
			} satisfies StoredProjectManagerState);
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo', 'hydration'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{ retryDelay: retry.delay }
			);
			const events: (readonly ProjectRecord[])[] = [];
			disposables.add(service.onDidChangeProjects(projects =>
				events.push(projects)
			));
			stateService.setItemError = new Error('state save failed');

			await service.getProjects();
			const hydrationToken = retry.tokens[0];
			assert.deepStrictEqual(retry.delays, [1000]);
			assert.strictEqual(events.length, 0);

			stateService.setItemError = undefined;
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo', 'winner'),
			]);
			const winner = await service.refresh('project-1');

			assert.strictEqual(hydrationToken.isCancellationRequested, true);
			assert.strictEqual(events.length, 1);
			assert.strictEqual(winner[0].worktrees[0].branch, 'winner');
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				2
			);

			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			assert.strictEqual(events.length, 1);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				2
			);
		});

	test('failed hydration carries publication debt into its Git retry',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const retry = new TestRetryDelay();
			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
				version: PROJECT_MANAGER_STORAGE_VERSION,
				projects: [{
					id: 'project-1',
					label: 'Repo',
					rootPath: '/repo',
					pinned: false,
					order: 1,
				}],
			} satisfies StoredProjectManagerState);
			gitWorktreeService.listWorktreesHandler = async () => {
				throw new Error('Git unavailable at startup');
			};
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{ retryDelay: retry.delay }
			);
			const events: (readonly ProjectRecord[])[] = [];
			disposables.add(service.onDidChangeProjects(projects =>
				events.push(projects)
			));
			const savedBefore = stateService.setItemCalls;
			stateService.setItemError = new Error('state save failed');

			const unavailable = (await service.getProjects())[0];

			assert.strictEqual(unavailable.worktreeState, 'unavailable');
			assert.strictEqual(events.length, 0);
			assert.deepStrictEqual(retry.delays, [1000]);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				1
			);
			const retryToken = retry.tokens[0];

			stateService.setItemError = undefined;
			gitWorktreeService.listWorktreesHandler = undefined;
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0][0].worktreeState, 'current');
			assert.strictEqual(
				stateService.setItemCalls,
				savedBefore + 2
			);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				2
			);
			assert.strictEqual(new Set(retry.tokens).size, 1);
			assert.strictEqual(retry.tokens[0], retryToken);
			assert.strictEqual(retryToken.isCancellationRequested, false);
		});

	test('watcher-failed hydration carries publication debt into its retry',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const metadataWatcher = new TestProjectMetadataWatcher();
			const retry = new TestRetryDelay();
			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
				version: PROJECT_MANAGER_STORAGE_VERSION,
				projects: [{
					id: 'project-1',
					label: 'Repo',
					rootPath: '/repo',
					pinned: false,
					order: 1,
				}],
			} satisfies StoredProjectManagerState);
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			metadataWatcher.throwPaths.add('/repo/.git/HEAD');
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{
					metadataWatcher,
					retryDelay: retry.delay,
				}
			);
			const events: (readonly ProjectRecord[])[] = [];
			disposables.add(service.onDidChangeProjects(projects =>
				events.push(projects)
			));
			const savedBefore = stateService.setItemCalls;
			stateService.setItemError = new Error('state save failed');

			const hydrated = (await service.getProjects())[0];

			assert.strictEqual(hydrated.worktreeState, 'current');
			assert.strictEqual(events.length, 0);
			assert.deepStrictEqual(retry.delays, [1000]);
			const retryToken = retry.tokens[0];

			stateService.setItemError = undefined;
			metadataWatcher.throwPaths.clear();
			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			assert.strictEqual(events.length, 1);
			assert.strictEqual(
				stateService.setItemCalls,
				savedBefore + 2
			);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				2
			);
			assert.strictEqual(new Set(retry.tokens).size, 1);
			assert.strictEqual(retry.tokens[0], retryToken);
			assert.strictEqual(retryToken.isCancellationRequested, false);
		});

	test('startup hydration observes an explicitly superseding refresh',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const initialDiscovery =
				new DeferredPromise<readonly WorktreeRecord[]>();
			const winningDiscovery =
				new DeferredPromise<readonly WorktreeRecord[]>();
			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
				version: PROJECT_MANAGER_STORAGE_VERSION,
				projects: [{
					id: 'project-1',
					label: 'Repo',
					rootPath: '/repo',
					pinned: false,
					order: 1,
				}],
			} satisfies StoredProjectManagerState);
			let discovery = 0;
			gitWorktreeService.listWorktreesHandler = async () => {
				discovery++;
				return discovery === 1
					? initialDiscovery.p
					: winningDiscovery.p;
			};
			const service = createService(stateService, gitWorktreeService);
			const events: (readonly ProjectRecord[])[] = [];
			disposables.add(service.onDidChangeProjects(projects =>
				events.push(projects)
			));

			const startupGet = service.getProjects();
			await timeout(0);
			const explicitRefresh = service.refresh('project-1');
			initialDiscovery.complete([
				createMainWorktree('/repo', 'superseded'),
			]);
			await timeout(0);
			winningDiscovery.complete([
				createMainWorktree('/repo', 'winner'),
				createLinkedWorktree(
					'/repo.worktrees/winner',
					'winner'
				),
			]);
			const [explicit, startup] = await Promise.all([
				explicitRefresh,
				startupGet,
			]);

			for (const projects of [explicit, startup]) {
				assert.strictEqual(projects[0].worktreeState, 'current');
				assert.deepStrictEqual(
					projects[0].worktrees.map(worktree => worktree.branch),
					['winner', 'winner']
				);
			}
			assert.strictEqual(
				gitWorktreeService.listWorktreesTokens[0]
					.isCancellationRequested,
				true
			);
			assert.strictEqual(
				gitWorktreeService.listWorktreesTokens[1]
					.isCancellationRequested,
				false
			);
			assert.strictEqual(events.length, 1);
			assert.deepStrictEqual(
				events[0][0].worktrees.map(worktree => worktree.branch),
				['winner', 'winner']
			);
		});

	test('lazy hydration joins an active initial refresh', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const discovery =
			new DeferredPromise<readonly WorktreeRecord[]>();
		stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: [{
				id: 'project-1',
				label: 'Repo',
				rootPath: '/repo',
				pinned: false,
				order: 1,
			}],
		} satisfies StoredProjectManagerState);
		gitWorktreeService.listWorktreesHandler = async () => discovery.p;
		const service = createService(stateService, gitWorktreeService);
		const events: (readonly ProjectRecord[])[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects)
		));

		const explicit = service.refresh('project-1');
		await timeout(0);
		const lazy = service.getProjects();
		await timeout(0);
		assert.strictEqual(
			gitWorktreeService.listWorktreesCalls.length,
			1
		);

		discovery.complete([createMainWorktree('/repo')]);
		await Promise.all([explicit, lazy]);

		assert.strictEqual(
			gitWorktreeService.listWorktreesCalls.length,
			1
		);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0][0].worktreeState, 'current');
	});

	test('keeps worktrees when the git common dir cannot be resolved', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const metadataWatcher = new TestProjectMetadataWatcher();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
		]);
		// getGitCommonDir feeds only the metadata watchers; its failure must
		// not blank the worktree list that listWorktrees already resolved.
		gitWorktreeService.commonDirErrors.add('/repo');

		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{ metadataWatcher }
		);
		await service.addProject(URI.file('/repo'));

		assert.deepStrictEqual({
			worktrees: (await service.getProjects())[0].worktrees,
			watchedPaths: metadataWatcher.watchedPaths,
		}, {
			worktrees: [
				createMainWorktree('/repo'),
				createLinkedWorktree('/repo.worktrees/alpha', 'alpha'),
			],
			watchedPaths: [],
		});
	});

	test('retains stale worktrees, metadata, and watchers before retry recovery',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const metadataWatcher = new TestProjectMetadataWatcher();
			const retry = new TestRetryDelay();
			const alphaPath = '/repo.worktrees/alpha';
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
				createLinkedWorktree(alphaPath, 'alpha'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				() => 42,
				{
					metadataWatcher,
					retryDelay: retry.delay,
				}
			);
			const project = await service.addProject(URI.file('/repo'));
			await service.renameWorktree(project.id, alphaPath, 'Custom Alpha');
			await service.setWorktreePinned(project.id, alphaPath, true);
			await service.setLastActiveWorktree(project.id, alphaPath);
			const watchedBeforeFailure = [...metadataWatcher.watchedPaths];

			gitWorktreeService.listWorktreesHandler = async () => {
				throw new Error('temporary Git failure');
			};
			const stale = (await service.refresh(project.id))[0];

			assert.strictEqual(stale.worktreeState, 'stale');
			assert.deepStrictEqual(stale.worktrees.map(worktree => ({
				path: worktree.path,
				customLabel: worktree.customLabel,
				pinned: worktree.pinned,
				lastVisitedAt: worktree.lastVisitedAt,
			})), [{
				path: '/repo',
				customLabel: undefined,
				pinned: undefined,
				lastVisitedAt: undefined,
			}, {
				path: alphaPath,
				customLabel: 'Custom Alpha',
				pinned: true,
				lastVisitedAt: 42,
			}]);
			assert.strictEqual(stale.lastActiveWorktreePath, alphaPath);
			assert.deepStrictEqual(metadataWatcher.watchedPaths, watchedBeforeFailure);
			assert.deepStrictEqual(metadataWatcher.disposedPaths, []);
			assert.deepStrictEqual(retry.delays, [1000]);

			gitWorktreeService.listWorktreesHandler = undefined;
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
				createLinkedWorktree(alphaPath, 'feature/alpha'),
			]);
			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			const recovered = (await service.getProjects())[0];
			assert.strictEqual(recovered.worktreeState, 'current');
			assert.strictEqual(recovered.worktrees[1].branch, 'feature/alpha');
			assert.strictEqual(recovered.worktrees[1].customLabel, 'Custom Alpha');
			assert.strictEqual(recovered.worktrees[1].pinned, true);
			assert.ok(metadataWatcher.disposedPaths.length > 0);
		});

	test('caps persistent refresh retries at thirty seconds with one chain',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const retry = new TestRetryDelay();
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{ retryDelay: retry.delay }
			);
			const project = await service.addProject(URI.file('/repo'));
			gitWorktreeService.listWorktreesHandler = async () => {
				throw new Error('still unavailable');
			};

			await service.refresh(project.id);
			for (let index = 0; index < 5; index++) {
				retry.releaseNext();
				await timeout(0);
			}

			assert.deepStrictEqual(
				retry.delays,
				[1000, 2000, 5000, 10_000, 30_000, 30_000]
			);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				7
			);
			assert.strictEqual(new Set(retry.tokens).size, 1);
		});

	test('completed retry republishes without rerunning Git', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const retry = new TestRetryDelay();
		const logService = new TestLogService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{ retryDelay: retry.delay },
			logService
		);
		const project = await service.addProject(URI.file('/repo'));
		gitWorktreeService.listWorktreesHandler = async () => {
			throw new Error('temporary Git failure');
		};
		await service.refresh(project.id);

		gitWorktreeService.listWorktreesHandler = undefined;
		const events: (readonly ProjectRecord[])[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects)
		));
		stateService.setItemError = new Error('state save failed');
		retry.releaseNext();
		await timeout(0);
		await timeout(0);

		assert.ok(logService.warnings.some(warning =>
			String(warning).includes('Failed to publish retry refresh /repo:') &&
			String(warning).includes('state save failed')
		));
		assert.deepStrictEqual(retry.delays, [1000, 2000]);
		assert.strictEqual(events.length, 0);
		assert.strictEqual(
			gitWorktreeService.listWorktreesCalls.length,
			3
		);

		stateService.setItemError = undefined;
		retry.releaseNext();
		await timeout(0);
		await timeout(0);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0][0].worktreeState, 'current');
		assert.strictEqual(
			gitWorktreeService.listWorktreesCalls.length,
			3
		);
		assert.strictEqual(new Set(retry.tokens).size, 1);
	});

	test('watcher retry continues after persistence failure', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const metadataWatcher = new TestProjectMetadataWatcher();
		const retry = new TestRetryDelay();
		const logService = new TestLogService();
		metadataWatcher.throwPaths.add('/repo/.git/HEAD');
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{
				metadataWatcher,
				retryDelay: retry.delay,
			},
			logService
		);

		await service.addProject(URI.file('/repo'));
		const retryToken = retry.tokens[0];
		stateService.setItemError = new Error('state save failed');
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/new', 'feature/new'),
		]);
		retry.releaseNext();
		await timeout(0);
		await timeout(0);

		assert.deepStrictEqual(retry.delays, [1000, 2000]);
		assert.ok(logService.warnings.some(warning =>
			String(warning).includes('Failed to publish retry refresh /repo:') &&
			String(warning).includes('state save failed')
		));

		stateService.setItemError = undefined;
		metadataWatcher.throwPaths.clear();
		retry.releaseNext();
		await timeout(0);
		await timeout(0);

		assert.strictEqual(
			metadataWatcher.activeListenerCount('/repo/.git/HEAD'),
			1
		);
		assert.strictEqual(
			metadataWatcher.activeListenerCount('/repo/.git/worktrees'),
			1
		);
		assert.strictEqual(new Set(retry.tokens).size, 1);
		assert.strictEqual(retry.tokens[1], retryToken);
		assert.strictEqual(retryToken.isCancellationRequested, false);
	});

	test('failed stale publication is retried after storage recovers', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const metadataWatcher = new TestProjectMetadataWatcher();
		const retry = new TestRetryDelay();
		metadataWatcher.throwPaths.add('/repo/.git/HEAD');
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{
				metadataWatcher,
				retryDelay: retry.delay,
			}
		);
		await service.addProject(URI.file('/repo'));
		const events: (readonly ProjectRecord[])[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects)
		));
		gitWorktreeService.listWorktreesHandler = async () => {
			throw new Error('Git remains unavailable');
		};

		stateService.setItemError = new Error('state save failed');
		retry.releaseNext();
		await timeout(0);
		await timeout(0);
		assert.deepStrictEqual(retry.delays, [1000, 2000]);
		assert.strictEqual(events.length, 0);

		stateService.setItemError = undefined;
		retry.releaseNext();
		await timeout(0);
		await timeout(0);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0][0].worktreeState, 'stale');
		assert.deepStrictEqual(
			events[0][0].worktrees,
			[createMainWorktree('/repo')]
		);
		assert.deepStrictEqual(retry.delays, [1000, 2000, 5000]);
		assert.strictEqual(new Set(retry.tokens).size, 1);
	});

	test('retry delay rejection releases refresh ownership', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const logService = new TestLogService();
		let retryToken: CancellationToken | undefined;
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{
				retryDelay: async (_milliseconds, token) => {
					retryToken = token;
					throw new Error('delay failed');
				},
			},
			logService
		);
		const project = await service.addProject(URI.file('/repo'));
		gitWorktreeService.listWorktreesHandler = async () => {
			throw new Error('temporary Git failure');
		};

		await service.refresh(project.id);
		await timeout(0);
		assert.ok(retryToken);
		assert.ok(logService.warnings.some(warning =>
			String(warning).includes('Failed to delay refresh /repo:') &&
			String(warning).includes('delay failed')
		));

		service.dispose();
		assert.strictEqual(retryToken.isCancellationRequested, false);
	});

	test('unavailable hydration restarts after retry ownership ends', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		let retryToken: CancellationToken | undefined;
		stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: [{
				id: 'project-1',
				label: 'Repo',
				rootPath: '/repo',
				pinned: false,
				order: 1,
			}],
		} satisfies StoredProjectManagerState);
		gitWorktreeService.listWorktreesHandler = async () => {
			throw new Error('Git unavailable at startup');
		};
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{
				retryDelay: async (_milliseconds, token) => {
					retryToken = token;
					throw new Error('delay failed');
				},
			}
		);

		const unavailable = (await service.getProjects())[0];
		await timeout(0);
		assert.strictEqual(unavailable.worktreeState, 'unavailable');
		assert.ok(retryToken);
		assert.strictEqual(retryToken.isCancellationRequested, false);
		assert.strictEqual(
			gitWorktreeService.listWorktreesCalls.length,
			1
		);

		gitWorktreeService.listWorktreesHandler = undefined;
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const events: (readonly ProjectRecord[])[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects)
		));
		const recovered = (await service.getProjects())[0];

		assert.strictEqual(recovered.worktreeState, 'current');
		assert.deepStrictEqual(recovered.worktrees, [
			createMainWorktree('/repo'),
		]);
		assert.strictEqual(
			gitWorktreeService.listWorktreesCalls.length,
			2
		);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0][0].worktreeState, 'current');
	});

	test('direct worktree reads publish unavailable recovery', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: [{
				id: 'project-1',
				label: 'Repo',
				rootPath: '/repo',
				pinned: false,
				order: 1,
			}],
		} satisfies StoredProjectManagerState);
		gitWorktreeService.listWorktreesHandler = async () => {
			throw new Error('Git unavailable at startup');
		};
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{
				retryDelay: async () => {
					throw new Error('delay failed');
				},
			}
		);

		const unavailable = (await service.getProjects())[0];
		await timeout(0);
		assert.strictEqual(unavailable.worktreeState, 'unavailable');

		gitWorktreeService.listWorktreesHandler = undefined;
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const events: (readonly ProjectRecord[])[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects)
		));

		await service.getWorktreeRefs('project-1');

		assert.deepStrictEqual(
			gitWorktreeService.listRefsCalls[0].worktrees,
			[createMainWorktree('/repo')]
		);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0][0].worktreeState, 'current');
	});

	test('forwards caller cancellation to ref and branch-name Git reads',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			gitWorktreeService.validBranchNames.add('feature/one');
			const service = createService(stateService, gitWorktreeService);
			const project = await service.addProject(URI.file('/repo'));
			const source = new CancellationTokenSource();

			await service.getWorktreeRefs(
				project.id,
				undefined,
				source.token
			);
			await service.isValidBranchName(
				project.id,
				'feature/one',
				source.token
			);

			assert.strictEqual(
				gitWorktreeService.listRefsTokens.at(-1),
				source.token
			);
			assert.strictEqual(
				gitWorktreeService.branchNameTokens.at(-1),
				source.token
			);
			source.dispose();
		}
	);

	test('cancels request-owned ref hydration with its caller token',
		async () => {
			const stateService = new TestStateService();
			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
				version: PROJECT_MANAGER_STORAGE_VERSION,
				projects: [{
					id: 'project-1',
					label: 'Repo',
					rootPath: '/repo',
					pinned: false,
					order: 1,
				}],
			} satisfies StoredProjectManagerState);
			const gitWorktreeService = new TestGitWorktreeService();
			const discoveryStarted = new DeferredPromise<CancellationToken>();
			gitWorktreeService.listWorktreesHandler =
				async (_projectRoot, token) => {
					await discoveryStarted.complete(token);
					await new Promise<void>((_resolve, reject) => {
						const listener = token.onCancellationRequested(() => {
							listener.dispose();
							reject(new CancellationError());
						});
					});
					return [];
				};
			const service = createService(stateService, gitWorktreeService);
			const source = new CancellationTokenSource();

			const refs = service.getWorktreeRefs(
				'project-1',
				undefined,
				source.token
			);
			const hydrationToken = await discoveryStarted.p;
			source.cancel();
			await refs;

			assert.strictEqual(hydrationToken.isCancellationRequested, true);
			assert.strictEqual(
				gitWorktreeService.listRefsTokens.at(-1),
				source.token
			);
			gitWorktreeService.listWorktreesHandler = undefined;
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const recoveredRefs = await service.getWorktreeRefs('project-1');
			assert.deepStrictEqual(recoveredRefs, []);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				2
			);
			source.dispose();
		}
	);

	test('retries canceled shared hydration for a live ref follower',
		async () => {
			const stateService = new TestStateService();
			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
				version: PROJECT_MANAGER_STORAGE_VERSION,
				projects: [{
					id: 'project-1',
					label: 'Repo',
					rootPath: '/repo',
					pinned: false,
					order: 1,
				}],
			} satisfies StoredProjectManagerState);
			const gitWorktreeService = new TestGitWorktreeService();
			const firstDiscoveryStarted =
				new DeferredPromise<CancellationToken>();
			let discoveries = 0;
			gitWorktreeService.listWorktreesHandler =
				async (_projectRoot, token) => {
					if (++discoveries === 1) {
						await firstDiscoveryStarted.complete(token);
						await new Promise<void>((_resolve, reject) => {
							const listener =
								token.onCancellationRequested(() => {
									listener.dispose();
									reject(new CancellationError());
								});
						});
					}
					return [
						createMainWorktree('/repo'),
						createLinkedWorktree('/repo.worktrees/feature', 'feature'),
					];
				};
			gitWorktreeService.refs.set('/repo', [{
				name: 'feature',
				type: 'head',
				checkedOutPath: '/repo.worktrees/feature',
			}]);
			const service = createService(stateService, gitWorktreeService);
			const firstSource = new CancellationTokenSource();

			const first = service.getWorktreeRefs(
				'project-1',
				undefined,
				firstSource.token
			);
			await firstDiscoveryStarted.p;
			const follower = service.getWorktreeRefs('project-1');
			await timeout(0);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				1
			);

			firstSource.cancel();
			const [, followerRefs] = await Promise.all([first, follower]);

			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				2
			);
			assert.deepStrictEqual(
				gitWorktreeService.listRefsCalls.at(-1)?.worktrees,
				[
					createMainWorktree('/repo'),
					createLinkedWorktree('/repo.worktrees/feature', 'feature'),
				]
			);
			assert.deepStrictEqual(followerRefs, [{
				name: 'feature',
				type: 'head',
				checkedOutPath: '/repo.worktrees/feature',
			}]);
			firstSource.dispose();
		}
	);

	test('keeps committed watcher recovery after its ref request cancels',
		async () => {
			const stateService = new TestStateService();
			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
				version: PROJECT_MANAGER_STORAGE_VERSION,
				projects: [{
					id: 'project-1',
					label: 'Repo',
					rootPath: '/repo',
					pinned: false,
					order: 1,
				}],
			} satisfies StoredProjectManagerState);
			const gitWorktreeService = new TestGitWorktreeService();
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const metadataWatcher = new TestProjectMetadataWatcher();
			metadataWatcher.throwPaths.add('/repo/.git/HEAD');
			const retry = new TestRetryDelay();
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{
					metadataWatcher,
					retryDelay: retry.delay,
				}
			);
			const source = new CancellationTokenSource();

			await service.getWorktreeRefs(
				'project-1',
				undefined,
				source.token
			);
			assert.deepStrictEqual(retry.delays, [1000]);
			const retryToken = retry.tokens[0];

			source.cancel();
			assert.strictEqual(retryToken.isCancellationRequested, false);
			metadataWatcher.throwPaths.clear();
			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			assert.strictEqual(
				metadataWatcher.activeListenerCount('/repo/.git/HEAD'),
				1
			);
			assert.strictEqual(
				metadataWatcher.activeListenerCount('/repo/.git/worktrees'),
				1
			);
			source.dispose();
		}
	);

	test('recovers an initially unavailable project through retry', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const retry = new TestRetryDelay();
		stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
			version: PROJECT_MANAGER_STORAGE_VERSION,
			projects: [{
				id: 'project-1',
				label: 'Repo',
				rootPath: '/repo',
				pinned: false,
				order: 1,
			}],
		} satisfies StoredProjectManagerState);
		gitWorktreeService.listWorktreesHandler = async () => {
			throw new Error('Git unavailable at startup');
		};
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{ retryDelay: retry.delay }
		);

		const initial = (await service.getProjects())[0];
		assert.strictEqual(initial.worktreeState, 'unavailable');
		assert.deepStrictEqual(initial.worktrees, []);
		const initialCalls = gitWorktreeService.listWorktreesCalls.length;
		const initialRetryToken = retry.tokens[0];

		const repeated = (await service.getProjects())[0];
		assert.strictEqual(repeated.worktreeState, 'unavailable');
		assert.strictEqual(
			gitWorktreeService.listWorktreesCalls.length,
			initialCalls
		);
		assert.deepStrictEqual(retry.delays, [1000]);
		assert.strictEqual(initialRetryToken.isCancellationRequested, false);

		gitWorktreeService.listWorktreesHandler = undefined;
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		retry.releaseNext();
		await timeout(0);
		await timeout(0);

		const recovered = (await service.getProjects())[0];
		assert.strictEqual(recovered.worktreeState, 'current');
		assert.deepStrictEqual(recovered.worktrees, [
			createMainWorktree('/repo'),
		]);
	});

	test('superseded refreshes cannot overwrite newer discovery', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const metadataWatcher = new TestProjectMetadataWatcher();
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{ metadataWatcher }
		);
		const project = await service.addProject(URI.file('/repo'));
		const oldDiscovery =
			new DeferredPromise<readonly WorktreeRecord[]>();
		let discovery = 0;
		gitWorktreeService.listWorktreesHandler = async () => {
			discovery++;
			if (discovery === 1) {
				return oldDiscovery.p;
			}
			return [
				createMainWorktree('/repo', 'new-main'),
				createLinkedWorktree('/repo.worktrees/new', 'new'),
			];
		};

		const oldRefresh = service.refresh(project.id);
		await timeout(0);
		const fresh = await service.refresh(project.id);
		oldDiscovery.complete([
			createMainWorktree('/repo', 'old-main'),
			createLinkedWorktree('/repo.worktrees/old', 'old'),
		]);
		await oldRefresh;

		assert.deepStrictEqual(
			fresh[0].worktrees.map(worktree => worktree.branch),
			['new-main', 'new']
		);
		assert.deepStrictEqual(
			(await service.getProjects())[0].worktrees.map(
				worktree => worktree.branch
			),
			['new-main', 'new']
		);
		assert.strictEqual(
			gitWorktreeService.listWorktreesTokens[1].isCancellationRequested,
			true
		);
		assert.strictEqual(
			gitWorktreeService.listWorktreesTokens[2].isCancellationRequested,
			false
		);
		assert.strictEqual(
			gitWorktreeService.commonDirTokens[1].isCancellationRequested,
			true
		);
		assert.strictEqual(
			gitWorktreeService.commonDirTokens[2].isCancellationRequested,
			false
		);
	});

	test('superseded refresh waits for the winning initial attempt', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const service = createService(stateService, gitWorktreeService);
		const project = await service.addProject(URI.file('/repo'));
		const supersededDiscovery =
			new DeferredPromise<readonly WorktreeRecord[]>();
		const winningDiscovery =
			new DeferredPromise<readonly WorktreeRecord[]>();
		let discovery = 0;
		gitWorktreeService.listWorktreesHandler = async () => {
			discovery++;
			return discovery === 1
				? supersededDiscovery.p
				: winningDiscovery.p;
		};

		let supersededSettled = false;
		const supersededRefresh = service.refresh(project.id);
		void supersededRefresh.then(() => supersededSettled = true);
		await timeout(0);
		const winningRefresh = service.refresh(project.id);
		supersededDiscovery.complete([
			createMainWorktree('/repo', 'superseded'),
		]);
		await timeout(0);
		assert.strictEqual(supersededSettled, false);

		winningDiscovery.complete([
			createMainWorktree('/repo', 'winner'),
			createLinkedWorktree('/repo.worktrees/winner', 'winner'),
		]);
		const [superseded, winner] = await Promise.all([
			supersededRefresh,
			winningRefresh,
		]);

		for (const projects of [superseded, winner]) {
			assert.deepStrictEqual(
				projects[0].worktrees.map(worktree => worktree.branch),
				['winner', 'winner']
			);
		}
	});

	test('superseded refresh does not duplicate the winner retry chain',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const retry = new TestRetryDelay();
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{ retryDelay: retry.delay }
			);
			const project = await service.addProject(URI.file('/repo'));
			const supersededDiscovery =
				new DeferredPromise<readonly WorktreeRecord[]>();
			let discovery = 0;
			gitWorktreeService.listWorktreesHandler = async () => {
				discovery++;
				if (discovery === 1) {
					return supersededDiscovery.p;
				}
				throw new Error('winning discovery failed');
			};

			const supersededRefresh = service.refresh(project.id);
			await timeout(0);
			const winnerRefresh = service.refresh(project.id);
			await winnerRefresh;
			supersededDiscovery.complete([
				createMainWorktree('/repo', 'superseded'),
			]);
			await supersededRefresh;

			assert.deepStrictEqual(retry.delays, [1000]);
		});

	test('refresh preserves metadata edits made while Git discovery is pending',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const alphaPath = '/repo.worktrees/alpha';
			const bravoPath = '/repo.worktrees/bravo';
			gitWorktreeService.worktrees.set('/other', [
				createMainWorktree('/other'),
			]);
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
				createLinkedWorktree(alphaPath, 'alpha'),
				createLinkedWorktree(bravoPath, 'bravo'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				() => 123
			);
			const other = await service.addProject(URI.file('/other'));
			const project = await service.addProject(URI.file('/repo'));
			const discovery =
				new DeferredPromise<readonly WorktreeRecord[]>();
			gitWorktreeService.listWorktreesHandler = async root =>
				root === '/repo'
					? discovery.p
					: gitWorktreeService.worktrees.get(root) ?? [];

			const refresh = service.refresh(project.id);
			await timeout(0);
			await service.renameProject(project.id, 'Renamed Repo');
			await service.setPinned(project.id, true);
			await service.moveProject(project.id, other.id);
			await service.renameWorktree(project.id, alphaPath, 'Custom Alpha');
			await service.setWorktreePinned(project.id, alphaPath, true);
			await service.moveWorktree(project.id, bravoPath, alphaPath);
			await service.setLastActiveWorktree(project.id, alphaPath);
			discovery.complete([
				createMainWorktree('/repo', 'updated-main'),
				createLinkedWorktree(alphaPath, 'updated-alpha'),
				createLinkedWorktree(bravoPath, 'updated-bravo'),
			]);
			await refresh;

			const projects = await service.getProjects();
			const refreshed = projects[0];
			assert.strictEqual(refreshed.id, project.id);
			assert.strictEqual(refreshed.label, 'Renamed Repo');
			assert.strictEqual(refreshed.pinned, true);
			assert.strictEqual(refreshed.lastActiveWorktreePath, alphaPath);
			assert.deepStrictEqual(
				refreshed.worktrees.map(worktree => ({
					path: worktree.path,
					branch: worktree.branch,
					customLabel: worktree.customLabel,
					pinned: worktree.pinned,
					lastVisitedAt: worktree.lastVisitedAt,
				})),
				[{
					path: '/repo',
					branch: 'updated-main',
					customLabel: undefined,
					pinned: undefined,
					lastVisitedAt: undefined,
				}, {
					path: bravoPath,
					branch: 'updated-bravo',
					customLabel: undefined,
					pinned: undefined,
					lastVisitedAt: undefined,
				}, {
					path: alphaPath,
					branch: 'updated-alpha',
					customLabel: 'Custom Alpha',
					pinned: true,
					lastVisitedAt: 123,
				}]
			);

			const stored = stateService.getItem<StoredProjectManagerState>(
				PROJECT_MANAGER_STORAGE_KEY
			);
			assert.deepStrictEqual(
				stored?.projects.toSorted((a, b) => a.order - b.order)
					.map(entry => ({
						id: entry.id,
						label: entry.label,
						pinned: entry.pinned,
						order: entry.order,
						lastActiveWorktreePath: entry.lastActiveWorktreePath,
						worktreeOrder: entry.worktreeOrder,
						pinnedWorktreePaths: entry.pinnedWorktreePaths,
						worktreeLabels: entry.worktreeLabels,
						worktreeVisits: entry.worktreeVisits,
					})),
				[{
					id: project.id,
					label: 'Renamed Repo',
					pinned: true,
					order: 1,
					lastActiveWorktreePath: alphaPath,
					worktreeOrder: [bravoPath, alphaPath],
					pinnedWorktreePaths: [alphaPath],
					worktreeLabels: [{
						path: alphaPath,
						label: 'Custom Alpha',
					}],
					worktreeVisits: [{
						path: alphaPath,
						lastVisitedAt: 123,
					}],
				}, {
					id: other.id,
					label: 'other',
					pinned: false,
					order: 2,
					lastActiveWorktreePath: undefined,
					worktreeOrder: undefined,
					pinnedWorktreePaths: undefined,
					worktreeLabels: undefined,
					worktreeVisits: undefined,
				}]
			);
		});

	test('cancellation is inert and does not warn or change current state',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const logService = new TestLogService();
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{},
				logService
			);
			const project = await service.addProject(URI.file('/repo'));
			let discovery = 0;
			gitWorktreeService.listWorktreesHandler = async (_root, token) => {
				discovery++;
				if (discovery === 1) {
					return new Promise<readonly WorktreeRecord[]>(
						(_resolve, reject) => {
							const listener = token.onCancellationRequested(() => {
								listener.dispose();
								reject(new CancellationError());
							});
						}
					);
				}
				return [
					createMainWorktree('/repo'),
					createLinkedWorktree('/repo.worktrees/new', 'new'),
				];
			};

			const canceledRefresh = service.refresh(project.id);
			await timeout(0);
			const fresh = await service.refresh(project.id);
			await canceledRefresh;

			assert.strictEqual(fresh[0].worktreeState, 'current');
			assert.deepStrictEqual(
				(await service.getProjects())[0].worktrees.map(
					worktree => worktree.branch
				),
				['main', 'new']
			);
			assert.deepStrictEqual(logService.warnings, []);
		});

	test('watcher refresh supersedes an older manual discovery', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const metadataWatcher = new TestProjectMetadataWatcher();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
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
		const oldDiscovery =
			new DeferredPromise<readonly WorktreeRecord[]>();
		let discovery = 0;
		gitWorktreeService.listWorktreesHandler = async () => {
			discovery++;
			return discovery === 1
				? oldDiscovery.p
				: [
					createMainWorktree('/repo'),
					createLinkedWorktree('/repo.worktrees/watcher', 'watcher'),
				];
		};

		const manualRefresh = service.refresh(project.id);
		await timeout(0);
		metadataWatcher.fire('/repo/.git/worktrees');
		await timeout(0);
		await timeout(0);
		oldDiscovery.complete([
			createMainWorktree('/repo'),
			createLinkedWorktree('/repo.worktrees/old', 'old'),
		]);
		await manualRefresh;

		assert.deepStrictEqual(
			(await service.getProjects())[0].worktrees.map(
				worktree => worktree.branch
			),
			['main', 'watcher']
		);
		assert.strictEqual(
			gitWorktreeService.listWorktreesTokens[1].isCancellationRequested,
			true
		);
	});

	test('first watcher failure retries while discovered data stays current',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const metadataWatcher = new TestProjectMetadataWatcher();
			const retry = new TestRetryDelay();
			metadataWatcher.throwPaths.add('/repo/.git/HEAD');
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{
					metadataWatcher,
					retryDelay: retry.delay,
				}
			);

			const project = await service.addProject(URI.file('/repo'));

			assert.strictEqual(project.worktreeState, 'current');
			assert.deepStrictEqual(project.worktrees, [
				createMainWorktree('/repo'),
			]);
			assert.strictEqual(
				metadataWatcher.activeListenerCount('/repo/.git/HEAD'),
				0
			);
			assert.deepStrictEqual(retry.delays, [1000]);

			metadataWatcher.throwPaths.clear();
			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			assert.strictEqual(
				metadataWatcher.activeListenerCount('/repo/.git/HEAD'),
				1
			);
			assert.strictEqual(
				metadataWatcher.activeListenerCount('/repo/.git/worktrees'),
				1
			);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				2
			);
			assert.strictEqual(new Set(retry.tokens).size, 1);
		});

	test('unchanged watcher retries do not publish or persist', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const metadataWatcher = new TestProjectMetadataWatcher();
		const retry = new TestRetryDelay();
		metadataWatcher.throwPaths.add('/repo/.git/HEAD');
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{
				metadataWatcher,
				retryDelay: retry.delay,
			}
		);
		await service.addProject(URI.file('/repo'));
		const savedBeforeRetries = stateService.setItemCalls;
		const events: (readonly ProjectRecord[])[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects)
		));

		retry.releaseNext();
		await timeout(0);
		await timeout(0);
		retry.releaseNext();
		await timeout(0);
		await timeout(0);

		metadataWatcher.throwPaths.clear();
		retry.releaseNext();
		await timeout(0);
		await timeout(0);

		assert.strictEqual(events.length, 0);
		assert.strictEqual(stateService.setItemCalls, savedBeforeRetries);
		assert.deepStrictEqual(retry.delays, [1000, 2000, 5000]);
		assert.strictEqual(
			gitWorktreeService.listWorktreesCalls.length,
			4
		);
		assert.strictEqual(
			metadataWatcher.activeListenerCount('/repo/.git/HEAD'),
			1
		);
		assert.strictEqual(new Set(retry.tokens).size, 1);
	});

	test('mid-set watcher failure retains old watchers until retry recovery',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const metadataWatcher = new TestProjectMetadataWatcher();
			const retry = new TestRetryDelay();
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{
					metadataWatcher,
					autoRefreshDebounceMs: 0,
					autoRefreshQuietMs: 0,
					retryDelay: retry.delay,
				}
			);
			const project = await service.addProject(URI.file('/repo'));
			const watchedBefore = [...metadataWatcher.watchedPaths];
			metadataWatcher.throwPaths.add(
				'/repo/.git/worktrees/new/HEAD'
			);
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
				createLinkedWorktree('/repo.worktrees/new', 'new'),
			]);

			const refreshed = (await service.refresh(project.id))[0];

			assert.strictEqual(refreshed.worktreeState, 'current');
			assert.deepStrictEqual(
				refreshed.worktrees.map(worktree => worktree.branch),
				['main', 'new']
			);
			assert.deepStrictEqual(metadataWatcher.watchedPaths, [
				...watchedBefore,
				'/repo/.git/HEAD',
				'/repo/.git/worktrees',
			]);
			assert.deepStrictEqual(metadataWatcher.disposedPaths, [
				'/repo/.git/HEAD',
				'/repo/.git/worktrees',
			]);
			assert.strictEqual(
				metadataWatcher.activeListenerCount('/repo/.git/HEAD'),
				1
			);
			assert.strictEqual(
				metadataWatcher.activeListenerCount('/repo/.git/worktrees'),
				1
			);
			assert.deepStrictEqual(retry.delays, [1000]);

			metadataWatcher.throwPaths.clear();
			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			assert.strictEqual(
				metadataWatcher.activeListenerCount(
					'/repo/.git/worktrees/new/HEAD'
				),
				1
			);
			assert.strictEqual(
				metadataWatcher.activeListenerCount(
					'/repo/.git/worktrees/new/gitdir'
				),
				1
			);
			assert.deepStrictEqual(metadataWatcher.disposedPaths, [
				'/repo/.git/HEAD',
				'/repo/.git/worktrees',
				'/repo/.git/HEAD',
				'/repo/.git/worktrees',
			]);
			assert.strictEqual(
				gitWorktreeService.listWorktreesCalls.length,
				3
			);
			assert.strictEqual(new Set(retry.tokens).size, 1);
		});

	test('watcher retries publish and persist every committed discovery',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const metadataWatcher = new TestProjectMetadataWatcher();
			const retry = new TestRetryDelay();
			const alphaPath = '/repo.worktrees/alpha';
			const bravoPath = '/repo.worktrees/bravo';
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
				createLinkedWorktree(alphaPath, 'alpha'),
				createLinkedWorktree(bravoPath, 'bravo'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{
					metadataWatcher,
					retryDelay: retry.delay,
				}
			);
			const project = await service.addProject(URI.file('/repo'));
			await service.renameWorktree(project.id, alphaPath, 'Alpha');
			await service.renameWorktree(project.id, bravoPath, 'Bravo');
			await service.setWorktreePinned(project.id, alphaPath, true);
			await service.setWorktreePinned(project.id, bravoPath, true);
			metadataWatcher.throwPaths.add('/repo/.git/HEAD');
			const events: (readonly ProjectRecord[])[] = [];
			disposables.add(service.onDidChangeProjects(projects =>
				events.push(projects)
			));
			await service.refresh(project.id);
			events.length = 0;

			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
				createLinkedWorktree(alphaPath, 'updated-alpha'),
			]);
			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0][0].worktreeState, 'current');
			assert.deepStrictEqual(
				events[0][0].worktrees.map(worktree => worktree.branch),
				['main', 'updated-alpha']
			);
			let stored = stateService.getItem<StoredProjectManagerState>(
				PROJECT_MANAGER_STORAGE_KEY
			);
			assert.deepStrictEqual(
				stored?.projects[0].pinnedWorktreePaths,
				[alphaPath]
			);
			assert.deepStrictEqual(stored?.projects[0].worktreeLabels, [{
				path: alphaPath,
				label: 'Alpha',
			}]);

			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			assert.strictEqual(events.length, 2);
			assert.deepStrictEqual(
				events[1][0].worktrees.map(worktree => worktree.branch),
				['main']
			);
			stored = stateService.getItem<StoredProjectManagerState>(
				PROJECT_MANAGER_STORAGE_KEY
			);
			assert.strictEqual(
				stored?.projects[0].pinnedWorktreePaths,
				undefined
			);
			assert.strictEqual(stored?.projects[0].worktreeLabels, undefined);
			assert.deepStrictEqual(
				retry.delays,
				[1000, 2000, 5000]
			);
		});

	test('retry Git failure publishes a stale transition', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const metadataWatcher = new TestProjectMetadataWatcher();
		const retry = new TestRetryDelay();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{
				metadataWatcher,
				retryDelay: retry.delay,
			}
		);
		const project = await service.addProject(URI.file('/repo'));
		metadataWatcher.throwPaths.add('/repo/.git/HEAD');
		await service.refresh(project.id);
		const events: (readonly ProjectRecord[])[] = [];
		disposables.add(service.onDidChangeProjects(projects =>
			events.push(projects)
		));
		gitWorktreeService.listWorktreesHandler = async () => {
			throw new Error('Git failed during watcher retry');
		};

		retry.releaseNext();
		await timeout(0);
		await timeout(0);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0][0].worktreeState, 'stale');
		assert.deepStrictEqual(events[0][0].worktrees, [
			createMainWorktree('/repo'),
		]);
		assert.deepStrictEqual(retry.delays, [1000, 2000]);
	});

	test('cancels retry ownership when a project is removed', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const retry = new TestRetryDelay();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{ retryDelay: retry.delay }
		);
		const project = await service.addProject(URI.file('/repo'));
		gitWorktreeService.listWorktreesHandler = async () => {
			throw new Error('temporary');
		};
		await service.refresh(project.id);
		const retryToken = retry.tokens[0];

		await service.removeProject(project.id);
		await timeout(0);

		assert.strictEqual(retryToken.isCancellationRequested, true);
		assert.deepStrictEqual(await service.getProjects(), []);
	});

	test('cancels retry ownership when the service is disposed', async () => {
		const stateService = new TestStateService();
		const gitWorktreeService = new TestGitWorktreeService();
		const retry = new TestRetryDelay();
		gitWorktreeService.worktrees.set('/repo', [
			createMainWorktree('/repo'),
		]);
		const service = createService(
			stateService,
			gitWorktreeService,
			undefined,
			{ retryDelay: retry.delay }
		);
		const project = await service.addProject(URI.file('/repo'));
		gitWorktreeService.listWorktreesHandler = async () => {
			throw new Error('temporary');
		};
		await service.refresh(project.id);
		const retryToken = retry.tokens[0];

		service.dispose();
		await timeout(0);

		assert.strictEqual(retryToken.isCancellationRequested, true);
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
		await service.moveProject(two.id, two.id);
		assert.deepStrictEqual(
			(await service.getProjects()).map(project => project.rootUri.fsPath),
			['two', 'three', 'one'].map(path => `/${path}`)
		);

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
			'/repo.worktrees/alpha',
			'/repo.worktrees/alpha'
		);
		assert.deepStrictEqual(
			(await service.getProjects())[0].worktrees.map(worktree => worktree.path),
			[
				'/repo',
				'/repo.worktrees/alpha',
				'/repo.worktrees/bravo',
				'/repo.worktrees/charlie',
			]
		);

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
		// Reordering the main worktree onto itself must reject too, rather than
		// being short-circuited to success by the equal-path early return.
		await assert.rejects(
			service.moveWorktree(project.id, '/repo', '/repo'),
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
			assert.strictEqual(refreshed[0].worktreeState, 'current');
			assert.deepStrictEqual(
				refreshed[0].worktrees,
				[createMainWorktree('/repo')]
			);
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

	test('returns a stale created worktree when post-add refresh fails',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const retry = new TestRetryDelay();
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{ retryDelay: retry.delay }
			);
			const project = await service.addProject(URI.file('/repo'));
			gitWorktreeService.listWorktreesHandler = async () => {
				throw new Error('refresh failed after git worktree add');
			};

			const created = await service.createWorktree(project.id, {
				branchName: 'feature/recovery',
				path: '/repo.worktrees/feature-recovery',
			});
			const stale = (await service.getProjects())[0];

			assert.deepStrictEqual(created, createLinkedWorktree(
				'/repo.worktrees/feature-recovery',
				'feature/recovery'
			));
			assert.strictEqual(stale.worktreeState, 'stale');
			assert.ok(stale.worktrees.some(worktree =>
				worktree.path === created.path
			));
			assert.deepStrictEqual(retry.delays, [1000]);

			gitWorktreeService.listWorktreesHandler = undefined;
			retry.releaseNext();
			await timeout(0);
			await timeout(0);

			const recovered = (await service.getProjects())[0];
			assert.strictEqual(recovered.worktreeState, 'current');
			assert.deepStrictEqual(
				recovered.worktrees,
				[
					createMainWorktree('/repo'),
					createLinkedWorktree(
						'/repo.worktrees/feature-recovery',
						'feature/recovery'
					),
				]
			);
		}
	);

	test('publishes a stale created worktree after initial discovery is unavailable',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			const retry = new TestRetryDelay();
			stateService.setItem(PROJECT_MANAGER_STORAGE_KEY, {
				version: PROJECT_MANAGER_STORAGE_VERSION,
				projects: [{
					id: 'project-1',
					label: 'Repo',
					rootPath: '/repo',
					pinned: false,
					order: 1,
				}],
			} satisfies StoredProjectManagerState);
			gitWorktreeService.listWorktreesHandler = async () => {
				throw new Error('Git discovery unavailable');
			};
			const service = createService(
				stateService,
				gitWorktreeService,
				undefined,
				{ retryDelay: retry.delay }
			);
			const events: (readonly ProjectRecord[])[] = [];
			disposables.add(service.onDidChangeProjects(projects =>
				events.push(projects)
			));

			const initial = (await service.getProjects())[0];
			assert.strictEqual(initial.worktreeState, 'unavailable');
			assert.deepStrictEqual(initial.worktrees, []);

			const created = await service.createWorktree('project-1', {
				branchName: 'feature/recovery',
				path: '/repo.worktrees/feature-recovery',
			});
			const published = (await service.getProjects())[0];

			assert.deepStrictEqual(created, createLinkedWorktree(
				'/repo.worktrees/feature-recovery',
				'feature/recovery'
			));
			assert.strictEqual(published.worktreeState, 'stale');
			assert.deepStrictEqual(published.worktrees, [created]);
			assert.strictEqual(
				events.at(-1)?.[0].worktreeState,
				'stale'
			);
			assert.deepStrictEqual(
				events.at(-1)?.[0].worktrees,
				[created]
			);
			assert.deepStrictEqual(retry.delays, [1000, 1000]);
		}
	);

	test('returns the canonical created worktree without a duplicate fallback',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const service = createService(stateService, gitWorktreeService);
			const project = await service.addProject(URI.file('/repo'));
			const canonical = createLinkedWorktree(
				'/canonical/repo.worktrees/feature',
				'feature/canonical'
			);
			gitWorktreeService.createWorktree = async () => {
				gitWorktreeService.worktrees.set('/repo', [
					createMainWorktree('/repo'),
					canonical,
				]);
				return '/alias/repo.worktrees/feature';
			};

			const created = await service.createWorktree(project.id, {
				branchName: 'feature/canonical',
				path: '/alias/repo.worktrees/feature',
			});
			const refreshed = (await service.getProjects())[0];

			assert.deepStrictEqual(created, canonical);
			assert.strictEqual(refreshed.worktreeState, 'current');
			assert.deepStrictEqual(refreshed.worktrees, [
				createMainWorktree('/repo'),
				canonical,
			]);
		}
	);

	test('does not cache a provisional worktree after uncorrelated discovery',
		async () => {
			const stateService = new TestStateService();
			const gitWorktreeService = new TestGitWorktreeService();
			gitWorktreeService.worktrees.set('/repo', [
				createMainWorktree('/repo'),
			]);
			const service = createService(stateService, gitWorktreeService);
			const project = await service.addProject(URI.file('/repo'));
			const discovered = [
				createLinkedWorktree(
					'/canonical/repo.worktrees/first',
					'feature/first'
				),
				createLinkedWorktree(
					'/canonical/repo.worktrees/second',
					'feature/second'
				),
			];
			gitWorktreeService.createWorktree = async () => {
				gitWorktreeService.worktrees.set('/repo', [
					createMainWorktree('/repo'),
					...discovered,
				]);
				return '/alias/repo.worktrees/requested';
			};

			const created = await service.createWorktree(project.id, {
				branchName: 'feature/requested',
				path: '/alias/repo.worktrees/requested',
			});
			const refreshed = (await service.getProjects())[0];

			assert.deepStrictEqual(created, createLinkedWorktree(
				'/alias/repo.worktrees/requested',
				'feature/requested'
			));
			assert.strictEqual(refreshed.worktreeState, 'current');
			assert.deepStrictEqual(refreshed.worktrees, [
				createMainWorktree('/repo'),
				...discovered,
			]);
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
