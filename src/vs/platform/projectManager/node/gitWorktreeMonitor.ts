/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { timeout, ThrottledDelayer } from '../../../base/common/async.js';
import {
	CancellationToken,
	CancellationTokenSource,
} from '../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { isEqualOrParent } from '../../../base/common/extpath.js';
import {
	Disposable,
	DisposableMap,
	DisposableStore,
	IDisposable,
	MutableDisposable,
	toDisposable,
} from '../../../base/common/lifecycle.js';
import { basename, dirname, join } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import {
	GitWorktreeTargetChange,
	GitWorktreeTargetObservation,
	WorktreeRecord,
} from '../common/projectManager.js';
import { getProjectManagerPathComparisonKey } from
	'../common/projectManagerState.js';
import { GitCommandError, GitWorktreeService } from './gitWorktreeService.js';

const GIT_MONITOR_DEBOUNCE_MS = 1000;
const GIT_MONITOR_RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
const DEFAULT_GIT_MONITOR_TARGET_CONCURRENCY = 4;

/** Narrow filesystem watcher used by the shared Git worktree monitor. */
export interface IGitMetadataWatcher {
	watch(path: string, onDidChange: () => void): IDisposable;
	watchEntry(path: string, onDidChange: () => void): IDisposable;
}

/** Git reads required by the shared Git worktree monitor. */
export type GitWorktreeMonitorGitService = Pick<
	GitWorktreeService,
	'resolveProjectRoot' |
	'getGitCommonDir' |
	'listWorktreeAdminDirs' |
	'listWorktrees'
>;

/** Optional timing and watcher dependencies for the shared Git monitor. */
export interface GitWorktreeMonitorOptions {
	readonly fileService?: IFileService;
	readonly metadataWatcher?: IGitMetadataWatcher;
	readonly debounceMs?: number;
	readonly retryDelay?: (
		milliseconds: number,
		token: CancellationToken
	) => Promise<void>;
	/** Internal bounded-worker override used by focused tests. */
	readonly targetConcurrency?: number;
}

/** One repository snapshot and the lease keeping its metadata watch active. */
export interface GitRepositoryObservation {
	readonly repositoryRoot: string;
	readonly worktrees: readonly WorktreeRecord[];
	readonly watcher: IDisposable | null | undefined;
}

/** Hints for observing a repository that a caller has already resolved. */
export interface GitRepositoryObservationOptions {
	readonly repositoryRoot?: string;
	readonly forceReplaceWatcher?: boolean;
}

interface RepositoryWatchEntry {
	readonly listeners: Map<number, () => void>;
	watchers: DisposableStore;
	paths: readonly string[];
}

interface SharedProbeWatchEntry {
	readonly path: string;
	readonly listeners: Map<number, () => void>;
	watcher: IDisposable;
	dirty: boolean;
}

interface GitMonitorConsumer {
	readonly targetPaths: readonly string[];
	readonly source: CancellationTokenSource;
	readonly leases: DisposableStore;
	readonly delayer: ThrottledDelayer<void>;
	observations: readonly GitWorktreeTargetObservation[];
	retryGeneration: number;
	retryPromise: Promise<void> | undefined;
	needsRetry: boolean;
}

/** Desktop adapter for narrow, correlated Git metadata watchers. */
export class FileServiceGitMetadataWatcher implements IGitMetadataWatcher {
	constructor(private readonly fileService: IFileService) { }

	watch(path: string, onDidChange: () => void): IDisposable {
		const store = new DisposableStore();
		const watcher = store.add(this.fileService.createWatcher(URI.file(path), {
			recursive: false,
			excludes: [],
		}));
		store.add(watcher.onDidChange(() => onDidChange()));
		return store;
	}

	watchEntry(path: string, onDidChange: () => void): IDisposable {
		const store = new DisposableStore();
		const resource = URI.file(path);
		const watcher = store.add(this.fileService.createWatcher(
			URI.file(dirname(path)),
			{
				recursive: false,
				excludes: [],
			}
		));
		store.add(watcher.onDidChange(event => {
			if (event.contains(resource)) {
				onDidChange();
			}
		}));
		return store;
	}
}

/**
 * Node adapter that recovers a narrow watch when a missing metadata path
 * appears. This matches the desktop file-service watcher's missing-path
 * behavior without recursively watching a repository.
 */
export class NodeGitMetadataWatcher implements IGitMetadataWatcher {
	constructor(private readonly logService: ILogService) { }

	watch(path: string, onDidChange: () => void): IDisposable {
		const store = new DisposableStore();
		const currentWatcher = store.add(new MutableDisposable<IDisposable>());
		this.watchPath(store, currentWatcher, path, onDidChange);
		return store;
	}

	watchEntry(path: string, onDidChange: () => void): IDisposable {
		const store = new DisposableStore();
		this.watchEntryPath(store, path, onDidChange);
		return store;
	}

	private watchPath(
		store: DisposableStore,
		currentWatcher: MutableDisposable<IDisposable>,
		path: string,
		onDidChange: () => void
	): void {
		if (store.isDisposed) {
			return;
		}

		if (fs.existsSync(path)) {
			try {
				const watcher = fs.watch(
					path,
					{ persistent: false },
					event => {
						if (event === 'rename') {
							currentWatcher.clear();
							this.watchPath(
								store,
								currentWatcher,
								path,
								onDidChange
							);
						}
						onDidChange();
					}
				);
				currentWatcher.value = toDisposable(() => watcher.close());
				return;
			} catch (error) {
				this.logService.warn(
					`[GitWorktreeMonitor] Failed to watch ${path}: ${error}`
				);
			}
		}

		const ancestor = nearestExistingAncestor(path);
		if (!ancestor) {
			return;
		}

		try {
			const watcher = fs.watch(
				ancestor.dir,
				{ persistent: false },
				(_event, filename) => {
					if (filename !== null && filename !== ancestor.nextSegment) {
						return;
					}
					if (!fs.existsSync(join(ancestor.dir, ancestor.nextSegment))) {
						return;
					}

					currentWatcher.clear();
					this.watchPath(
						store,
						currentWatcher,
						path,
						onDidChange
					);
					onDidChange();
				}
			);
			currentWatcher.value = toDisposable(() => watcher.close());
		} catch (error) {
			this.logService.warn(
				`[GitWorktreeMonitor] Failed to watch ${ancestor.dir}: ${error}`
			);
		}
	}

	private watchEntryPath(
		store: DisposableStore,
		path: string,
		onDidChange: () => void
	): void {
		if (store.isDisposed) {
			return;
		}

		const parent = dirname(path);
		if (fs.existsSync(parent)) {
			try {
				const entryName = basename(path);
				const watcher = fs.watch(
					parent,
					{ persistent: false },
					(event, filename) => {
						if (event !== 'rename' ||
							(filename !== null && !samePathSegment(
								filename.toString(),
								entryName
							))) {
							return;
						}
						onDidChange();
					}
				);
				store.add(toDisposable(() => watcher.close()));
				return;
			} catch (error) {
				this.logService.warn(
					`[GitWorktreeMonitor] Failed to watch ${parent}: ${error}`
				);
			}
		}

		const ancestor = nearestExistingAncestor(path);
		if (!ancestor) {
			return;
		}

		const pending = new MutableDisposable();
		store.add(pending);
		try {
			const watcher = fs.watch(
				ancestor.dir,
				{ persistent: false },
				(event, filename) => {
					if (event !== 'rename' ||
						(filename !== null && !samePathSegment(
							filename.toString(),
							ancestor.nextSegment
						))) {
						return;
					}
					if (!fs.existsSync(join(ancestor.dir, ancestor.nextSegment))) {
						return;
					}

					pending.clear();
					this.watchEntryPath(store, path, onDidChange);
					onDidChange();
				}
			);
			pending.value = toDisposable(() => watcher.close());
		} catch (error) {
			this.logService.warn(
				`[GitWorktreeMonitor] Failed to watch ${ancestor.dir}: ${error}`
			);
		}
	}
}

/**
 * Shared, repository-deduplicated observer for project and arbitrary-folder
 * Git worktree metadata.
 */
export class GitWorktreeMonitor extends Disposable {
	private readonly metadataWatcher: IGitMetadataWatcher | undefined;
	private readonly debounceMs: number;
	private readonly retryDelay: (
		milliseconds: number,
		token: CancellationToken
	) => Promise<void>;
	private readonly repositoryWatches = new Map<string, RepositoryWatchEntry>();
	private readonly probeWatches = new Map<string, SharedProbeWatchEntry>();
	private nextListenerId = 0;
	private readonly targetConcurrency: number;
	private readonly consumers = this._register(new DisposableMap<
		string,
		IDisposable & GitMonitorConsumer
	>());
	private readonly _onDidChangeTargets = this._register(
		new Emitter<GitWorktreeTargetChange>()
	);
	readonly onDidChangeTargets = this._onDidChangeTargets.event;

	/** Whether this host can install narrow Git metadata watchers. */
	private get hasMetadataWatcher(): boolean {
		return !!this.metadataWatcher;
	}

	constructor(
		private readonly gitWorktreeService: GitWorktreeMonitorGitService,
		private readonly logService: ILogService,
		options: GitWorktreeMonitorOptions = {},
	) {
		super();
		this.metadataWatcher = options.metadataWatcher ??
			(options.fileService
				? new FileServiceGitMetadataWatcher(options.fileService)
				: undefined);
		this.debounceMs = options.debounceMs ?? GIT_MONITOR_DEBOUNCE_MS;
		this.retryDelay = options.retryDelay ??
			((milliseconds, token) => timeout(milliseconds, token));
		this.targetConcurrency = Math.max(
			1,
			options.targetConcurrency ?? DEFAULT_GIT_MONITOR_TARGET_CONCURRENCY
		);
		this._register(toDisposable(() => {
			for (const entry of this.repositoryWatches.values()) {
				entry.watchers.dispose();
			}
			this.repositoryWatches.clear();
			for (const entry of this.probeWatches.values()) {
				entry.watcher.dispose();
			}
			this.probeWatches.clear();
		}));
	}

	/**
	 * Acquires one shared repository watcher lease. A `null` result means
	 * watcher creation failed and should be retried; `undefined` means watching
	 * is unavailable in this host.
	 */
	private async acquireRepositoryWatch(
		projectRoot: string,
		onDidChange: () => void,
		token: CancellationToken = CancellationToken.None,
		commonGitDirPromise?: Promise<string>,
		forceReplace = false,
	): Promise<IDisposable | null | undefined> {
		if (!this.metadataWatcher) {
			return undefined;
		}

		let commonGitDir: string;
		try {
			commonGitDir = await (commonGitDirPromise ??
				this.gitWorktreeService.getGitCommonDir(projectRoot, token));
		} catch (error) {
			if (isCancellationError(error) || token.isCancellationRequested) {
				throw error;
			}
			this.logService.warn(
				`[GitWorktreeMonitor] Failed to resolve metadata for ` +
				`${projectRoot}: ${error}`
			);
			return null;
		}
		this.throwIfCanceled(token);
		const key = this.pathKey(commonGitDir);
		let entry = this.repositoryWatches.get(key);
		let paths: readonly string[];
		try {
			paths = [
				join(commonGitDir, 'HEAD'),
				join(commonGitDir, 'worktrees'),
				...(await this.gitWorktreeService.listWorktreeAdminDirs(commonGitDir))
					.flatMap(adminDirName => {
						const adminDir = join(
							commonGitDir,
							'worktrees',
							adminDirName
						);
						return [join(adminDir, 'HEAD'), join(adminDir, 'gitdir')];
					}),
			];
		} catch (error) {
			if (isCancellationError(error) || token.isCancellationRequested) {
				throw error;
			}
			this.logService.warn(
				`[GitWorktreeMonitor] Failed to resolve watcher paths for ` +
				`${projectRoot}: ${error}`
			);
			return null;
		}
		this.throwIfCanceled(token);
		const pathsMatch = !!entry && this.samePaths(entry.paths, paths);
		if (!entry || forceReplace || !pathsMatch) {
			const watchers = new DisposableStore();
			try {
				for (const path of paths) {
					this.watchMetadataPath(watchers, key, path);
				}
			} catch (error) {
				watchers.dispose();
				if (isCancellationError(error) || token.isCancellationRequested) {
					throw error;
				}
				this.logService.warn(
					`[GitWorktreeMonitor] Failed to watch ${projectRoot}: ${error}`
				);
				return null;
			}
			if (entry) {
				const previousWatchers = entry.watchers;
				entry.watchers = watchers;
				entry.paths = paths;
				previousWatchers.dispose();
			} else {
				entry = { listeners: new Map(), watchers, paths };
				this.repositoryWatches.set(key, entry);
			}
		}

		this.throwIfCanceled(token);
		const listenerId = ++this.nextListenerId;
		entry.listeners.set(listenerId, onDidChange);
		return toDisposable(() => {
			const current = this.repositoryWatches.get(key);
			if (!current || current.listeners.get(listenerId) !== onDidChange) {
				return;
			}
			current.listeners.delete(listenerId);
			if (current.listeners.size === 0) {
				this.repositoryWatches.delete(key);
				current.watchers.dispose();
			}
		});
	}

	/** Replaces and immediately resolves one consumer's complete target list. */
	async setTargets(
		consumerId: string,
		targetPaths: readonly string[]
	): Promise<readonly GitWorktreeTargetObservation[]> {
		const paths = this.dedupePaths(targetPaths);
		const existing = this.consumers.get(consumerId);
		if (existing && this.samePaths(existing.targetPaths, paths)) {
			return existing.observations;
		}

		this.consumers.deleteAndDispose(consumerId);
		const source = new CancellationTokenSource();
		const leases = new DisposableStore();
		const delayer = new ThrottledDelayer<void>(this.debounceMs);
		const consumer: IDisposable & GitMonitorConsumer = {
			targetPaths: paths,
			source,
			leases,
			delayer,
			observations: [],
			retryGeneration: 0,
			retryPromise: undefined,
			needsRetry: false,
			dispose: () => {
				source.dispose(true);
				leases.dispose();
				delayer.dispose();
			},
		};
		this.consumers.set(consumerId, consumer);
		try {
			await this.refreshConsumer(consumerId, consumer);
		} catch (error) {
			if (isCancellationError(error) &&
				this.consumers.get(consumerId) !== consumer) {
				return [];
			}
			throw error;
		}
		return consumer.observations;
	}

	/** Releases one consumer and repository watches no longer shared. */
	clearTargets(consumerId: string): void {
		this.consumers.deleteAndDispose(consumerId);
	}

	/**
	 * Resolves, discovers, and watches one repository through the shared thin
	 * Git observation path used by Projects and arbitrary folder consumers.
	 */
	async observeRepository(
		targetPath: string,
		onDidChange: () => void,
		token: CancellationToken = CancellationToken.None,
		options: GitRepositoryObservationOptions = {}
	): Promise<GitRepositoryObservation> {
		const repositoryRoot = options.repositoryRoot ??
			await this.gitWorktreeService.resolveProjectRoot(targetPath, token);
		this.throwIfCanceled(token);
		const commonGitDirPromise = this.hasMetadataWatcher
			? this.gitWorktreeService.getGitCommonDir(repositoryRoot, token)
			: undefined;
		commonGitDirPromise?.catch(() => undefined);
		const worktrees = await this.gitWorktreeService.listWorktrees(
			repositoryRoot,
			token
		);
		this.throwIfCanceled(token);
		const watcher = await this.acquireRepositoryWatch(
			repositoryRoot,
			onDidChange,
			token,
			commonGitDirPromise,
			options.forceReplaceWatcher
		);
		return { repositoryRoot, worktrees, watcher };
	}

	private async refreshConsumer(
		consumerId: string,
		consumer: GitMonitorConsumer
	): Promise<void> {
		const token = consumer.source.token;
		const previous = new Map(consumer.observations.map(observation => [
			this.pathKey(observation.targetPath),
			observation,
		]));
		const nextLeases = new DisposableStore();
		const probePaths = new Set<string>();
		const repositories = new Map<string, Promise<{
			readonly projectRoot: string;
			readonly worktrees: readonly WorktreeRecord[];
		}>>();
		let needsRetry = false;
		const scheduleRefresh = () =>
			this.scheduleConsumerRefresh(consumerId, consumer);
		const addProbe = (path: string) => {
			const key = this.pathKey(path);
			if (probePaths.has(key)) {
				return;
			}
			probePaths.add(key);
			const lease = this.acquireProbeWatch(path, scheduleRefresh);
			if (lease) {
				nextLeases.add(lease);
			} else if (lease === null) {
				needsRetry = true;
			}
		};
		const loadRepository = (
			repositoryRoot: string,
			observationToken: CancellationToken
		) => {
			const key = this.pathKey(repositoryRoot);
			let loading = repositories.get(key);
			if (!loading) {
				loading = (async () => {
					const observation = await this.observeRepository(
						repositoryRoot,
						() => this.scheduleConsumerRefresh(consumerId, consumer),
						observationToken,
						{ repositoryRoot }
					);
					if (observation.watcher) {
						nextLeases.add(observation.watcher);
					} else if (observation.watcher === null) {
						needsRetry = true;
					}
					return {
						projectRoot: observation.repositoryRoot,
						worktrees: observation.worktrees,
					};
				})();
				repositories.set(key, loading);
			}
			return loading;
		};
		let observations: readonly GitWorktreeTargetObservation[];
		try {
			observations = await this.mapWithConcurrency(
				consumer.targetPaths,
				this.targetConcurrency,
				token,
				async (targetPath, operationToken) => {
					addProbe(targetPath);
					addProbe(join(targetPath, '.git'));
					try {
						const projectRoot = await this.gitWorktreeService
							.resolveProjectRoot(targetPath, operationToken);
						const repository = await loadRepository(
							projectRoot,
							operationToken
						);
						const worktree = this.findContainingWorktree(
							targetPath,
							repository.worktrees
						);
						this.addRepositoryMembershipProbes(
							targetPath,
							worktree?.path ?? repository.projectRoot,
							addProbe
						);
						return {
							targetPath,
							state: 'current' as const,
							repositoryRoot: repository.projectRoot,
							worktree,
						};
					} catch (error) {
						if (isCancellationError(error) ||
							operationToken.isCancellationRequested) {
							throw error;
						}
						if (isNotRepositoryError(error)) {
							this.addNonRepositoryProbes(targetPath, addProbe);
							return { targetPath, state: 'notRepository' as const };
						}
						const prior = previous.get(this.pathKey(targetPath));
						if (prior?.state === 'current' || prior?.state === 'stale') {
							needsRetry = true;
							return { ...prior, state: 'stale' as const };
						}
						needsRetry = true;
						return { targetPath, state: 'unavailable' as const };
					}
				}
			);
		} catch (error) {
			nextLeases.dispose();
			throw error;
		}
		if (token.isCancellationRequested || this.consumers.get(consumerId) !== consumer) {
			nextLeases.dispose();
			return;
		}

		consumer.leases.clear();
		consumer.leases.add(nextLeases);
		consumer.observations = observations;
		this._onDidChangeTargets.fire({ consumerId, observations });
		consumer.needsRetry = needsRetry;
		if (needsRetry) {
			this.startRetry(consumerId, consumer);
		} else {
			consumer.retryGeneration++;
		}
	}

	private scheduleConsumerRefresh(
		consumerId: string,
		consumer: GitMonitorConsumer
	): void {
		consumer.delayer.trigger(() => this.refreshConsumer(consumerId, consumer))
			.then(undefined, error => {
				if (!isCancellationError(error)) {
					this.logService.warn(
						`[GitWorktreeMonitor] Failed to refresh ${consumerId}: ${error}`
					);
				}
			});
	}

	private startRetry(consumerId: string, consumer: GitMonitorConsumer): void {
		if (consumer.retryPromise) {
			return;
		}
		const generation = ++consumer.retryGeneration;
		const run = async () => {
			for (let retry = 0;
				this.consumers.get(consumerId) === consumer &&
				consumer.retryGeneration === generation;
				retry++
			) {
				const delay = GIT_MONITOR_RETRY_DELAYS_MS[
					Math.min(retry, GIT_MONITOR_RETRY_DELAYS_MS.length - 1)
				];
				await this.retryDelay(delay, consumer.source.token);
				if (this.consumers.get(consumerId) !== consumer ||
					consumer.retryGeneration !== generation) {
					return;
				}
				await this.refreshConsumer(consumerId, consumer);
				if (!consumer.needsRetry) {
					return;
				}
			}
		};
		const retryPromise = run().catch(error => {
			if (!isCancellationError(error)) {
				this.logService.warn(
					`[GitWorktreeMonitor] Failed to retry ${consumerId}: ${error}`
				);
			}
		}).finally(() => {
			if (consumer.retryPromise === retryPromise) {
				const shouldRearm =
					this.consumers.get(consumerId) === consumer &&
					consumer.needsRetry &&
					consumer.retryGeneration !== generation;
				consumer.retryPromise = undefined;
				if (shouldRearm) {
					this.startRetry(consumerId, consumer);
				}
			}
		});
		consumer.retryPromise = retryPromise;
	}

	private watchMetadataPath(
		watchers: DisposableStore,
		repositoryKey: string,
		path: string
	): void {
		watchers.add(this.metadataWatcher!.watch(path, () => {
			const entry = this.repositoryWatches.get(repositoryKey);
			for (const listener of entry?.listeners.values() ?? []) {
				listener();
			}
		}));
	}

	private addNonRepositoryProbes(
		targetPath: string,
		addProbe: (path: string) => void
	): void {
		if (!this.metadataWatcher) {
			return;
		}
		let current = targetPath;
		while (true) {
			addProbe(join(current, '.git'));
			const parent = dirname(current);
			if (parent === current) {
				return;
			}
			current = parent;
		}
	}

	private addRepositoryMembershipProbes(
		targetPath: string,
		worktreeRoot: string,
		addProbe: (path: string) => void
	): void {
		if (!isEqualOrParent(targetPath, worktreeRoot, !isLinux)) {
			return;
		}
		let current = targetPath;
		while (true) {
			addProbe(join(current, '.git'));
			if (this.pathKey(current) === this.pathKey(worktreeRoot)) {
				return;
			}
			const parent = dirname(current);
			if (parent === current) {
				return;
			}
			current = parent;
		}
	}

	private acquireProbeWatch(
		path: string,
		onDidChange: () => void
	): IDisposable | null | undefined {
		if (!this.metadataWatcher) {
			return undefined;
		}
		const key = this.pathKey(path);
		let entry = this.probeWatches.get(key);
		if (!entry || entry.dirty) {
			const listeners = entry?.listeners ?? new Map<number, () => void>();
			try {
				const watcherRef: { current?: IDisposable } = {};
				const watcher = this.metadataWatcher.watchEntry(path, () => {
					const current = this.probeWatches.get(key);
					if (!current || current.watcher !== watcherRef.current) {
						return;
					}
					for (const probe of this.probeWatches.values()) {
						if (isEqualOrParent(probe.path, path, !isLinux)) {
							probe.dirty = true;
						}
					}
					for (const listener of current.listeners.values()) {
						listener();
					}
				});
				watcherRef.current = watcher;
				if (entry) {
					const previousWatcher = entry.watcher;
					entry.watcher = watcher;
					entry.dirty = false;
					previousWatcher.dispose();
				} else {
					entry = { path, listeners, watcher, dirty: false };
					this.probeWatches.set(key, entry);
				}
			} catch (error) {
				this.logService.warn(
					`[GitWorktreeMonitor] Failed to watch ${path}: ${error}`
				);
				return null;
			}
		}
		const listenerId = ++this.nextListenerId;
		entry.listeners.set(listenerId, onDidChange);
		return toDisposable(() => {
			const current = this.probeWatches.get(key);
			if (!current || current.listeners.get(listenerId) !== onDidChange) {
				return;
			}
			current.listeners.delete(listenerId);
			if (current.listeners.size === 0) {
				this.probeWatches.delete(key);
				current.watcher.dispose();
			}
		});
	}

	private async mapWithConcurrency<T, R>(
		items: readonly T[],
		concurrency: number,
		token: CancellationToken,
		map: (item: T, token: CancellationToken) => Promise<R>
	): Promise<readonly R[]> {
		if (!items.length) {
			return [];
		}
		const source = new CancellationTokenSource(token);
		const results = new Array<R>(items.length);
		let nextIndex = 0;
		const worker = async () => {
			while (true) {
				this.throwIfCanceled(source.token);
				const index = nextIndex++;
				if (index >= items.length) {
					return;
				}
				results[index] = await map(items[index], source.token);
			}
		};
		const workers = Array.from(
			{ length: Math.min(concurrency, items.length) },
			() => worker()
		);
		try {
			await Promise.all(workers);
			return results;
		} catch (error) {
			source.cancel();
			await Promise.allSettled(workers);
			throw error;
		} finally {
			source.dispose();
		}
	}

	private throwIfCanceled(token: CancellationToken): void {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
	}

	private findContainingWorktree(
		targetPath: string,
		worktrees: readonly WorktreeRecord[]
	): WorktreeRecord | undefined {
		return worktrees
			.filter(worktree => isEqualOrParent(
				targetPath,
				worktree.path,
				!isLinux
			))
			.toSorted((a, b) => b.path.length - a.path.length)[0];
	}

	private dedupePaths(paths: readonly string[]): readonly string[] {
		const seen = new Set<string>();
		return paths.filter(path => {
			const key = this.pathKey(path);
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	}

	private samePaths(a: readonly string[], b: readonly string[]): boolean {
		return a.length === b.length && a.every((path, index) =>
			this.pathKey(path) === this.pathKey(b[index])
		);
	}

	private pathKey(path: string): string {
		return getProjectManagerPathComparisonKey(path, isLinux);
	}
}

function isNotRepositoryError(error: unknown): boolean {
	if (!(error instanceof GitCommandError)) {
		return false;
	}
	return error.kind === 'exit' && /not a git repository/i.test(
		`${error.message}\n${error.stderr}`
	);
}

function nearestExistingAncestor(
	path: string
): { readonly dir: string; readonly nextSegment: string } | undefined {
	let current = path;
	let parent = dirname(current);
	while (parent !== current) {
		if (fs.existsSync(parent)) {
			return { dir: parent, nextSegment: basename(current) };
		}
		current = parent;
		parent = dirname(current);
	}
	return undefined;
}

function samePathSegment(first: string, second: string): boolean {
	return isLinux
		? first === second
		: first.toLowerCase() === second.toLowerCase();
}
