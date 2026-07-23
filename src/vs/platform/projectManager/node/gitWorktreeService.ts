/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { promises as fs } from 'fs';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	resolve,
} from '../../../base/common/path.js';
import { isEqual } from '../../../base/common/extpath.js';
import { isLinux } from '../../../base/common/platform.js';
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

export type ExecGitFn = (
	args: readonly string[],
	cwd: string
) => Promise<ExecGitResult>;

export type PathExistsFn = (path: string) => Promise<boolean>;
export type EnsureDirFn = (path: string) => Promise<void>;

export class GitCommandError extends Error {
	constructor(
		message: string,
		readonly stderr: string
	) {
		super(message);
	}
}

/**
 * Thin main-process git wrapper for Hucode project/worktree flows.
 */
export class GitWorktreeService {

	constructor(
		@ILogService private readonly logService: ILogService,
		private readonly execGit: ExecGitFn = (args, cwd) =>
			GitWorktreeService.execGit(args, cwd),
		private readonly pathExists: PathExistsFn = path =>
			GitWorktreeService.pathExists(path),
		private readonly ensureDir: EnsureDirFn = path =>
			GitWorktreeService.ensureDir(path),
	) {
	}

	async resolveProjectRoot(cwd: string): Promise<string> {
		const topLevel = (await this.runGit(
			['rev-parse', '--show-toplevel'],
			cwd
		)).stdout.trim();
		const commonDir = (await this.runGit(
			['rev-parse', '--path-format=absolute', '--git-common-dir'],
			cwd
		)).stdout.trim();

		if (basename(commonDir) === '.git') {
			return dirname(commonDir);
		}

		return topLevel;
	}

	/**
	 * Returns Git's absolute common metadata directory for a project root.
	 */
	async getGitCommonDir(projectRoot: string): Promise<string> {
		return (await this.runGit(
			['rev-parse', '--path-format=absolute', '--git-common-dir'],
			projectRoot
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

	async listWorktrees(projectRoot: string): Promise<readonly WorktreeRecord[]> {
		const result = await this.runGit(
			['worktree', 'list', '--porcelain'],
			projectRoot
		);

		return GitWorktreeService.parseWorktreeList(
			projectRoot,
			result.stdout
		);
	}

	async listRefs(
		projectRoot: string,
		worktrees: readonly WorktreeRecord[],
		options: WorktreeRefQueryOptions = {}
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
			projectRoot
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
		await this.runGit(args, projectRoot);

		return worktreePath;
	}

	async isValidBranchName(
		projectRoot: string,
		branchName: string
	): Promise<boolean> {
		try {
			await this.runGit(
				['check-ref-format', '--branch', branchName],
				projectRoot
			);
			return true;
		} catch (error) {
			if (error instanceof GitCommandError) {
				return false;
			}

			throw error;
		}
	}

	async removeWorktree(
		projectRoot: string,
		worktreePath: string
	): Promise<void> {
		await this.runGit(
			['worktree', 'remove', worktreePath],
			projectRoot
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
		cwd: string
	): Promise<ExecGitResult> {
		this.logService.trace(
			`[GitWorktreeService] git ${args.join(' ')} (cwd: ${cwd})`
		);

		return this.execGit(args, cwd);
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

	private static execGit(
		args: readonly string[],
		cwd: string
	): Promise<ExecGitResult> {
		return new Promise((resolve, reject) => {
			cp.execFile(
				'git',
				[...args],
				{ cwd, encoding: 'utf8' },
				(err, stdout, stderr) => {
					if (err) {
						const message = stderr.trim() || err.message;
						reject(new GitCommandError(message, stderr));
						return;
					}

					resolve({ stdout, stderr });
				}
			);
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
