/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { promises as fs } from 'fs';
import {
	CancellationToken,
} from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	resolve,
} from '../../../base/common/path.js';
import { isEqual } from '../../../base/common/extpath.js';
import { isLinux } from '../../../base/common/platform.js';
import { killTree } from '../../../base/node/processes.js';
import { ILogService } from '../../log/common/log.js';
import {
	WorktreeRecord,
	WorktreeRefQueryOptions,
	WorktreeRefRecord,
} from '../common/projectManager.js';

type ExecGitResult = {
	readonly stdout: string;
	readonly stderr: string;
};

export type GitOperation =
	'resolveProjectRoot' |
	'getGitCommonDir' |
	'listWorktrees' |
	'listRefs' |
	'isValidBranchName' |
	'createWorktree' |
	'removeWorktree';

/**
 * Resource limits attached to one project-manager Git operation.
 */
export interface GitCommandPolicy {
	readonly operation: GitOperation;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
}

export type ExecGitFn = (
	args: readonly string[],
	cwd: string,
	policy: GitCommandPolicy,
	token: CancellationToken
) => Promise<ExecGitResult>;

export type PathExistsFn = (path: string) => Promise<boolean>;
export type EnsureDirFn = (path: string) => Promise<void>;

export type GitCommandErrorKind =
	'exit' |
	'timeout' |
	'output-limit' |
	'spawn' |
	'signal';

interface GitCommandErrorOptions {
	readonly kind: GitCommandErrorKind;
	readonly operation: GitOperation;
	readonly command: string;
	readonly stderr: string;
	readonly code?: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly cause?: unknown;
}

/**
 * A bounded, classified failure from a project-manager Git subprocess.
 */
export class GitCommandError extends Error {
	readonly kind: GitCommandErrorKind;
	readonly operation: GitOperation;
	readonly command: string;
	readonly stderr: string;
	readonly code?: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	override readonly cause?: unknown;

	constructor(
		message: string,
		options: GitCommandErrorOptions
	) {
		super(message);
		this.name = 'GitCommandError';
		this.kind = options.kind;
		this.operation = options.operation;
		this.command = options.command;
		this.stderr = options.stderr;
		this.code = options.code;
		this.signal = options.signal;
		this.timeoutMs = options.timeoutMs;
		this.maxOutputBytes = options.maxOutputBytes;
		this.cause = options.cause;
	}
}

/**
 * Injectable process boundaries used by the Git subprocess runner.
 */
export interface GitProcessRunnerDependencies {
	readonly spawn: (
		command: string,
		args: readonly string[],
		options: cp.SpawnOptions
	) => cp.ChildProcess;
	readonly killTree: (pid: number, forceful: boolean) => Promise<void>;
	readonly setTimeout: (
		callback: () => void,
		delay: number
	) => NodeJS.Timeout;
	readonly clearTimeout: (handle: NodeJS.Timeout) => void;
	readonly env: NodeJS.ProcessEnv;
	readonly warn: (message: string) => void;
}

const KIB = 1024;
const MIB = KIB * KIB;
const GIT_COMMAND_SUMMARY_LIMIT = 512;
// Tree-kill is best-effort, so bound it before falling back to the root process.
const GIT_PROCESS_CLEANUP_WATCHDOG_MS = 1_000;
const GIT_POLICIES: Readonly<Record<GitOperation, GitCommandPolicy>> = {
	resolveProjectRoot: {
		operation: 'resolveProjectRoot',
		timeoutMs: 5_000,
		maxOutputBytes: MIB,
	},
	getGitCommonDir: {
		operation: 'getGitCommonDir',
		timeoutMs: 5_000,
		maxOutputBytes: MIB,
	},
	listWorktrees: {
		operation: 'listWorktrees',
		timeoutMs: 5_000,
		maxOutputBytes: 8 * MIB,
	},
	listRefs: {
		operation: 'listRefs',
		timeoutMs: 30_000,
		maxOutputBytes: 32 * MIB,
	},
	isValidBranchName: {
		operation: 'isValidBranchName',
		timeoutMs: 5_000,
		maxOutputBytes: MIB,
	},
	createWorktree: {
		operation: 'createWorktree',
		timeoutMs: 180_000,
		maxOutputBytes: 8 * MIB,
	},
	removeWorktree: {
		operation: 'removeWorktree',
		timeoutMs: 60_000,
		maxOutputBytes: 8 * MIB,
	},
};

/**
 * Thin main-process git wrapper for Hucode project/worktree flows.
 */
export class GitWorktreeService {

	constructor(
		@ILogService private readonly logService: ILogService,
		private readonly execGit: ExecGitFn = (args, cwd, policy, token) =>
			GitWorktreeService.execGit(
				args,
				cwd,
				policy,
				token,
				{
					spawn: (command, spawnArgs, options) =>
						cp.spawn(command, [...spawnArgs], options),
					killTree,
					setTimeout,
					clearTimeout,
					env: process.env,
					warn: message => this.logService.warn(message),
				}
			),
		private readonly pathExists: PathExistsFn = path =>
			GitWorktreeService.pathExists(path),
		private readonly ensureDir: EnsureDirFn = path =>
			GitWorktreeService.ensureDir(path),
	) {
	}

	async resolveProjectRoot(
		cwd: string,
		token: CancellationToken = CancellationToken.None
	): Promise<string> {
		const topLevel = (await this.runGit(
			['rev-parse', '--show-toplevel'],
			cwd,
			GIT_POLICIES.resolveProjectRoot,
			token
		)).stdout.trim();
		const commonDir = (await this.runGit(
			['rev-parse', '--path-format=absolute', '--git-common-dir'],
			cwd,
			GIT_POLICIES.resolveProjectRoot,
			token
		)).stdout.trim();

		if (basename(commonDir) === '.git') {
			return dirname(commonDir);
		}

		return topLevel;
	}

	/**
	 * Returns Git's absolute common metadata directory for a project root.
	 */
	async getGitCommonDir(
		projectRoot: string,
		token: CancellationToken = CancellationToken.None
	): Promise<string> {
		return (await this.runGit(
			['rev-parse', '--path-format=absolute', '--git-common-dir'],
			projectRoot,
			GIT_POLICIES.getGitCommonDir,
			token
		)).stdout.trim();
	}

	/**
	 * Lists linked worktree metadata directories under a common Git directory.
	 */
	async listWorktreeAdminDirs(
		commonGitDir: string
	): Promise<readonly string[]> {
		try {
			const worktreesPath = join(commonGitDir, 'worktrees');
			const dirents = await fs.readdir(worktreesPath, {
				withFileTypes: true,
			});

			return dirents
				.filter(dirent => dirent.isDirectory())
				.map(dirent => dirent.name)
				.sort((a, b) => a.localeCompare(b));
		} catch (error) {
			if (error instanceof Error &&
				(error as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}

			throw error;
		}
	}

	async listWorktrees(
		projectRoot: string,
		token: CancellationToken = CancellationToken.None
	): Promise<readonly WorktreeRecord[]> {
		const result = await this.runGit(
			['worktree', 'list', '--porcelain'],
			projectRoot,
			GIT_POLICIES.listWorktrees,
			token
		);

		return GitWorktreeService.parseWorktreeList(
			projectRoot,
			result.stdout
		);
	}

	async listRefs(
		projectRoot: string,
		worktrees: readonly WorktreeRecord[],
		options: WorktreeRefQueryOptions = {},
		token: CancellationToken = CancellationToken.None
	): Promise<readonly WorktreeRefRecord[]> {
		const sort = options.sort ?? 'committerdate';
		const args = [
			'for-each-ref',
			'--format=%(refname)%00%(objectname:short)%00' +
			'%(upstream:short)%00%(committerdate:relative)%00' +
			'%(authorname)%00%(upstream:track)%00%(subject)',
		];
		if (sort === 'committerdate') {
			args.push('--sort', '-committerdate');
		}
		args.push('refs/heads', 'refs/remotes', 'refs/tags');

		const result = await this.runGit(
			args,
			projectRoot,
			GIT_POLICIES.listRefs,
			token
		);

		return GitWorktreeService.parseRefList(
			result.stdout,
			worktrees,
			sort
		);
	}

	async createWorktree(
		projectRoot: string,
		options: {
			branchName?: string;
			startPoint?: string;
			detached?: boolean;
			path?: string;
		},
		existingPaths: readonly string[],
		token: CancellationToken = CancellationToken.None,
	): Promise<string> {
		const branchName = options.branchName?.trim();
		const startPoint = options.startPoint?.trim() || 'HEAD';
		const branchSlug = GitWorktreeService.sanitizeBranchName(
			branchName || startPoint
		);
		const defaultBasePath = join(
			dirname(projectRoot),
			`${basename(projectRoot)}.worktrees`,
			branchSlug
		);
		const customPath = options.path?.trim();
		const requestedPath = customPath
			? isAbsolute(customPath)
				? customPath
				: resolve(dirname(projectRoot), customPath)
			: defaultBasePath;
		const worktreePath = await this.ensureUniquePath(
			requestedPath,
			existingPaths
		);

		await this.ensureDir(dirname(worktreePath));
		const args = ['worktree', 'add'];
		if (branchName) {
			args.push('-b', branchName);
		} else if (options.detached) {
			args.push('--detach');
		}
		args.push(worktreePath, startPoint);
		await this.runGit(
			args,
			projectRoot,
			GIT_POLICIES.createWorktree,
			token
		);

		return worktreePath;
	}

	async isValidBranchName(
		projectRoot: string,
		branchName: string,
		token: CancellationToken = CancellationToken.None
	): Promise<boolean> {
		try {
			await this.runGit(
				['check-ref-format', '--branch', branchName],
				projectRoot,
				GIT_POLICIES.isValidBranchName,
				token
			);
			return true;
		} catch (error) {
			if (
				error instanceof GitCommandError &&
				error.kind === 'exit'
			) {
				return false;
			}

			throw error;
		}
	}

	async removeWorktree(
		projectRoot: string,
		worktreePath: string,
		token: CancellationToken = CancellationToken.None
	): Promise<void> {
		await this.runGit(
			['worktree', 'remove', worktreePath],
			projectRoot,
			GIT_POLICIES.removeWorktree,
			token
		);
	}

	private async ensureUniquePath(
		basePath: string,
		existingPaths: readonly string[]
	): Promise<string> {
		if (!(await this.isPathTaken(basePath, existingPaths))) {
			return basePath;
		}

		let counter = 2;
		while (true) {
			const candidate = `${basePath}-${counter++}`;
			if (!(await this.isPathTaken(candidate, existingPaths))) {
				return candidate;
			}
		}
	}

	private async isPathTaken(
		targetPath: string,
		existingPaths: readonly string[]
	): Promise<boolean> {
		if (existingPaths.some(path =>
			GitWorktreeService.pathsEqual(path, targetPath)
		)) {
			return true;
		}

		return this.pathExists(targetPath);
	}

	private async runGit(
		args: readonly string[],
		cwd: string,
		policy: GitCommandPolicy,
		token: CancellationToken
	): Promise<ExecGitResult> {
		this.logService.trace(
			`[GitWorktreeService] git ${args.join(' ')} (cwd: ${cwd})`
		);

		return this.execGit(args, cwd, policy, token);
	}

	static parseWorktreeList(
		projectRoot: string,
		stdout: string
	): readonly WorktreeRecord[] {
		const entries: WorktreeRecord[] = [];
		const blocks = stdout.trim()
			? stdout.trim().split(/\n\n+/)
			: [];

		for (const block of blocks) {
			let worktreePath: string | undefined;
			let branch: string | undefined;
			let isDetached = false;

			for (const line of block.split('\n')) {
				if (line.startsWith('worktree ')) {
					worktreePath = line.slice('worktree '.length);
				} else if (line.startsWith('branch ')) {
					branch = line.slice('branch '.length)
						.replace(/^refs\/heads\//, '');
				} else if (line === 'detached') {
					isDetached = true;
				}
			}

			if (!worktreePath) {
				continue;
			}

			const isMain = GitWorktreeService.pathsEqual(
				worktreePath,
				projectRoot
			);
			const label = branch || basename(worktreePath);
			entries.push({
				path: worktreePath,
				label,
				branch,
				isMain,
				isDetached,
			});
		}

		return entries.sort((a, b) => {
			if (a.isMain !== b.isMain) {
				return a.isMain ? -1 : 1;
			}

			return a.label.localeCompare(b.label) ||
				a.path.localeCompare(b.path);
		});
	}

	static parseRefList(
		stdout: string,
		worktrees: readonly WorktreeRecord[],
		sort: WorktreeRefQueryOptions['sort'] = 'alphabetically'
	): readonly WorktreeRefRecord[] {
		const checkedOutPaths = new Map<string, string>();
		for (const worktree of worktrees) {
			if (worktree.branch) {
				checkedOutPaths.set(worktree.branch, worktree.path);
			}
		}

		const refs: WorktreeRefRecord[] = [];
		for (const line of stdout.split('\n')) {
			if (!line.trim()) {
				continue;
			}

			const [
				refName,
				commit,
				upstream,
				relativeDate,
				authorName,
				tracking,
				subject,
			] = line.split('\0');
			let type: WorktreeRefRecord['type'];
			let name: string;
			if (refName.startsWith('refs/heads/')) {
				type = 'head';
				name = refName.slice('refs/heads/'.length);
			} else if (refName.startsWith('refs/remotes/')) {
				type = 'remote';
				name = refName.slice('refs/remotes/'.length);
				if (name.endsWith('/HEAD')) {
					continue;
				}
			} else if (refName.startsWith('refs/tags/')) {
				type = 'tag';
				name = refName.slice('refs/tags/'.length);
			} else {
				continue;
			}

			refs.push({
				name,
				type,
				commit: commit || undefined,
				upstream: upstream || undefined,
				tracking: normalizeTrackingStatus(tracking),
				relativeDate: relativeDate || undefined,
				authorName: authorName || undefined,
				subject: subject || undefined,
				checkedOutPath: type === 'head'
					? checkedOutPaths.get(name)
					: undefined,
			});
		}

		if (sort === 'committerdate') {
			return refs;
		}

		return refs.sort(compareRefsByTypeAndName);
	}

	static sanitizeBranchName(branchName: string): string {
		const sanitized = branchName
			.replace(/[\\/]/g, '-')
			.replace(/[^A-Za-z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '');

		return sanitized || 'worktree';
	}

	/**
	 * Runs one bounded Git subprocess, draining normal outcomes through close.
	 */
	static execGit(
		args: readonly string[],
		cwd: string,
		policy: GitCommandPolicy,
		token: CancellationToken = CancellationToken.None,
		dependencies: Partial<GitProcessRunnerDependencies> = {}
	): Promise<ExecGitResult> {
		if (token.isCancellationRequested) {
			return Promise.reject(new CancellationError());
		}

		const command = summarizeGitCommand(args);
		const runner = {
			spawn: dependencies.spawn ?? ((
				spawnCommand: string,
				spawnArgs: readonly string[],
				options: cp.SpawnOptions
			) => cp.spawn(spawnCommand, [...spawnArgs], options)),
			killTree: dependencies.killTree ?? killTree,
			setTimeout: dependencies.setTimeout ??
				((callback, delay) =>
					setTimeout(callback, delay) as unknown as NodeJS.Timeout),
			clearTimeout: dependencies.clearTimeout ??
				(handle => clearTimeout(handle)),
			env: dependencies.env ?? process.env,
			warn: dependencies.warn ?? (() => { }),
		};
		const env = nonInteractiveGitEnvironment(runner.env);
		let child: cp.ChildProcess;
		try {
			child = runner.spawn('git', args, {
				cwd,
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (cause) {
			return Promise.reject(new GitCommandError(
				`${command} failed to start: ${errorMessage(cause)}`,
				{
					kind: 'spawn',
					operation: policy.operation,
					command,
					stderr: '',
					cause,
				}
			));
		}

		return new Promise((resolve, reject) => {
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let bufferedBytes = 0;
			let killStarted = false;
			let fallbackKillStarted = false;
			let exitedCleanupWarned = false;
			let timer: NodeJS.Timeout | undefined;
			let cancellationListener: { dispose(): void } | undefined;
			let settled = false;

			const childHasExited = (): boolean =>
				child.exitCode !== null || child.signalCode !== null;
			const skipExitedChildCleanup = (): boolean => {
				if (!childHasExited()) {
					return false;
				}
				if (!exitedCleanupWarned) {
					exitedCleanupWarned = true;
					runner.warn(
						`[GitWorktreeService] ${policy.operation} ` +
						'process-tree cleanup is unsafe for an ' +
						'already-exited Git subprocess; skipping cleanup.'
					);
				}
				return true;
			};

			const fallbackKillChild = (): void => {
				if (fallbackKillStarted) {
					return;
				}
				fallbackKillStarted = true;
				if (skipExitedChildCleanup()) {
					return;
				}

				try {
					if (!child.kill('SIGKILL')) {
						runner.warn(
							`[GitWorktreeService] ` +
							`${policy.operation} fallback SIGKILL ` +
							`did not reach the Git subprocess.`
						);
					}
				} catch (fallbackError) {
					runner.warn(
						`[GitWorktreeService] ` +
						`${policy.operation} fallback SIGKILL ` +
						`failed: ${errorMessage(fallbackError)}`
					);
				}
			};

			const killChild = (): void => {
				if (killStarted) {
					return;
				}
				killStarted = true;

				// Node offers no atomic process-state check plus numeric-PID
				// tree kill, but checking here narrows the PID-reuse window.
				if (skipExitedChildCleanup()) {
					return;
				}
				if (typeof child.pid !== 'number') {
					runner.warn(
						`[GitWorktreeService] ${policy.operation} ` +
						`could not kill the Git process tree: ` +
						'Git subprocess has no process identifier.'
					);
					fallbackKillChild();
					return;
				}

				let cleanupSettled = false;
				let cleanupWatchdog: NodeJS.Timeout | undefined;
				const clearCleanupWatchdog = (): void => {
					if (cleanupWatchdog) {
						runner.clearTimeout(cleanupWatchdog);
						cleanupWatchdog = undefined;
					}
				};
				const cleanupFailed = (error: unknown): void => {
					if (cleanupSettled) {
						return;
					}
					cleanupSettled = true;
					clearCleanupWatchdog();
					runner.warn(
						`[GitWorktreeService] ${policy.operation} ` +
						`could not kill the Git process tree: ` +
						errorMessage(error)
					);
					fallbackKillChild();
				};

				cleanupWatchdog = runner.setTimeout(() => {
					if (cleanupSettled) {
						return;
					}
					cleanupSettled = true;
					cleanupWatchdog = undefined;
					runner.warn(
						`[GitWorktreeService] ${policy.operation} ` +
						`process-tree cleanup did not settle within ` +
						`${GIT_PROCESS_CLEANUP_WATCHDOG_MS}ms; ` +
						'falling back to direct SIGKILL.'
					);
					fallbackKillChild();
				}, GIT_PROCESS_CLEANUP_WATCHDOG_MS);

				let cleanup: Promise<void>;
				try {
					cleanup = runner.killTree(child.pid, true);
				} catch (error) {
					cleanupFailed(error);
					return;
				}
				void cleanup.then(
					() => {
						if (cleanupSettled) {
							return;
						}
						cleanupSettled = true;
						clearCleanupWatchdog();
					},
					cleanupFailed
				);
			};

			const clearPolicyHooks = (destroyPipes: boolean): void => {
				if (timer) {
					runner.clearTimeout(timer);
					timer = undefined;
				}
				cancellationListener?.dispose();
				cancellationListener = undefined;
				child.stdout?.removeListener('data', onStdout);
				child.stderr?.removeListener('data', onStderr);
				if (destroyPipes) {
					child.stdout?.destroy();
					child.stderr?.destroy();
				}
			};

			const abort = (
				error: Error,
				cleanupProcess: boolean = true
			): void => {
				if (settled) {
					return;
				}

				settled = true;
				clearPolicyHooks(true);
				reject(error);
				if (cleanupProcess) {
					killChild();
				}
			};

			const collect = (
				value: Buffer | string,
				chunks: Buffer[]
			): void => {
				const chunk = Buffer.isBuffer(value)
					? value
					: Buffer.from(value);
				const remaining = Math.max(
					0,
					policy.maxOutputBytes - bufferedBytes
				);
				if (remaining > 0) {
					chunks.push(
						remaining < chunk.byteLength
							? chunk.subarray(0, remaining)
							: chunk
					);
				}
				bufferedBytes += chunk.byteLength;
				if (bufferedBytes > policy.maxOutputBytes) {
					abort(new GitCommandError(
						`${command} exceeded its ` +
						`${policy.maxOutputBytes}-byte output limit.`,
						{
							kind: 'output-limit',
							operation: policy.operation,
							command,
							stderr: Buffer.concat(stderr).toString('utf8'),
							maxOutputBytes: policy.maxOutputBytes,
						}
					));
				}
			};

			const onStdout = (chunk: Buffer | string): void =>
				collect(chunk, stdout);
			const onStderr = (chunk: Buffer | string): void =>
				collect(chunk, stderr);
			const onError = (cause: Error): void => {
				abort(new GitCommandError(
					`${command} failed to start: ${cause.message}`,
					{
						kind: 'spawn',
						operation: policy.operation,
						command,
						stderr: Buffer.concat(stderr).toString('utf8'),
						cause,
					}
				), false);
			};
			cancellationListener = token.onCancellationRequested(() => {
				abort(new CancellationError());
			});
			const onClose = (
				code: number | null,
				signal: NodeJS.Signals | null
			): void => {
				clearPolicyHooks(false);
				child.removeListener('error', onError);
				child.removeListener('close', onClose);

				if (settled) {
					return;
				}
				settled = true;
				const stdoutText = Buffer.concat(stdout).toString('utf8');
				const stderrText = Buffer.concat(stderr).toString('utf8');
				if (signal) {
					reject(new GitCommandError(
						`${command} was terminated by ${signal}.`,
						{
							kind: 'signal',
							operation: policy.operation,
							command,
							stderr: stderrText,
							signal,
						}
					));
				} else if (code !== 0) {
					reject(new GitCommandError(
						stderrText.trim() ||
						`${command} exited with code ${code}.`,
						{
							kind: 'exit',
							operation: policy.operation,
							command,
							stderr: stderrText,
							code,
						}
					));
				} else {
					resolve({
						stdout: stdoutText,
						stderr: stderrText,
					});
				}
			};

			child.stdout?.on('data', onStdout);
			child.stderr?.on('data', onStderr);
			child.on('error', onError);
			child.on('close', onClose);
			timer = runner.setTimeout(() => {
				if (settled) {
					return;
				}
				runner.warn(
					`[GitWorktreeService] ${policy.operation} timed out ` +
					`after ${policy.timeoutMs}ms; killing ${command}.`
				);
				abort(new GitCommandError(
					`${command} timed out after ${policy.timeoutMs}ms.`,
					{
						kind: 'timeout',
						operation: policy.operation,
						command,
						stderr: Buffer.concat(stderr).toString('utf8'),
						timeoutMs: policy.timeoutMs,
					}
				));
			}, policy.timeoutMs);
		});
	}

	private static async pathExists(path: string): Promise<boolean> {
		try {
			await fs.access(path);
			return true;
		} catch {
			return false;
		}
	}

	private static async ensureDir(path: string): Promise<void> {
		await fs.mkdir(path, { recursive: true });
	}

	private static pathsEqual(pathA: string, pathB: string): boolean {
		return isEqual(pathA, pathB, !isLinux);
	}
}

function normalizeTrackingStatus(
	tracking: string | undefined
): string | undefined {
	const value = tracking?.trim().replace(/^\[|\]$/g, '');
	return value || undefined;
}

function compareRefsByTypeAndName(
	a: WorktreeRefRecord,
	b: WorktreeRefRecord
): number {
	const typeOrder = refTypeOrder(a.type) - refTypeOrder(b.type);
	return typeOrder || a.name.localeCompare(b.name);
}

function refTypeOrder(type: WorktreeRefRecord['type']): number {
	switch (type) {
		case 'head':
			return 0;
		case 'remote':
			return 1;
		case 'tag':
			return 2;
	}
}

function nonInteractiveGitEnvironment(
	inheritedEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
	const env = { ...inheritedEnv };
	const removedKeys = new Set([
		'GIT_ASKPASS',
		'GIT_TERMINAL_PROMPT',
		'GCM_INTERACTIVE',
		'SSH_ASKPASS',
		'SSH_ASKPASS_REQUIRE',
		'VSCODE_GIT_IPC_HANDLE',
	]);
	for (const key of Object.keys(env)) {
		const normalizedKey = key.toUpperCase();
		if (
			removedKeys.has(normalizedKey) ||
			normalizedKey.startsWith('VSCODE_GIT_ASKPASS_')
		) {
			delete env[key];
		}
	}

	env.GIT_TERMINAL_PROMPT = '0';
	env.GCM_INTERACTIVE = 'Never';
	env.SSH_ASKPASS_REQUIRE = 'never';
	return env;
}

function summarizeGitCommand(args: readonly string[]): string {
	const summary = `git ${args.map(arg =>
		/\s/.test(arg) ? JSON.stringify(arg) : arg
	).join(' ')}`;
	if (summary.length <= GIT_COMMAND_SUMMARY_LIMIT) {
		return summary;
	}

	return `${summary.slice(0, GIT_COMMAND_SUMMARY_LIMIT - 1)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
