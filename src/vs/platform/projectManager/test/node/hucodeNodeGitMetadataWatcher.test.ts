/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import {
	NodeGitMetadataWatcher,
	NodeGitMetadataWatcherFileSystem,
} from '../../node/gitWorktreeMonitor.js';

const REAL_FS_DEADLINE_MS = 10_000;
const REAL_FS_RECREATE_INTERVAL_MS = 1000;

suite('NodeGitMetadataWatcher', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	suite('pending existence probes', () => {
		test('installs nothing and reports nothing after disposal during a probe', async () => {
			const fileSystem = new FakeWatcherFileSystem(['/repo']);
			fileSystem.deferProbes = true;
			let changes = 0;
			const store = new NodeGitMetadataWatcher(new NullLogService(), fileSystem)
				.watch('/repo/.git/HEAD', () => changes++);
			const probe = fileSystem.takeProbe('/repo/.git');
			assert.deepStrictEqual(fileSystem.activePaths(), ['/repo']);

			store.dispose();
			const watchCallsAtDisposal = fileSystem.watchCalls.length;
			fileSystem.add('/repo/.git', '/repo/.git/HEAD');
			probe.complete(true);
			await probe.p;

			assert.deepStrictEqual({
				lateWatchCalls: fileSystem.watchCalls.slice(watchCallsAtDisposal),
				activePaths: fileSystem.activePaths(),
				changes,
			}, {
				lateWatchCalls: [],
				activePaths: [],
				changes: 0,
			});
		});

		test('ignores a probe from a superseded arm', async () => {
			const fileSystem = new FakeWatcherFileSystem(['/repo']);
			fileSystem.deferProbes = true;
			let changes = 0;
			disposables.add(new NodeGitMetadataWatcher(new NullLogService(), fileSystem)
				.watch('/repo/.git', () => changes++));
			const verification = fileSystem.takeProbe('/repo/.git');
			fileSystem.add('/repo/.git');
			fileSystem.fire('/repo', 'rename', '.git');
			const eventProbe = fileSystem.takeProbe('/repo/.git');

			eventProbe.complete(true);
			await eventProbe.p;
			const afterRearm = { changes, activePaths: fileSystem.activePaths() };
			verification.complete(true);
			await verification.p;

			assert.deepStrictEqual({
				afterRearm,
				afterStaleProbe: { changes, activePaths: fileSystem.activePaths() },
			}, {
				afterRearm: { changes: 1, activePaths: ['/repo/.git'] },
				afterStaleProbe: { changes: 1, activePaths: ['/repo/.git'] },
			});
		});

		test('detects an appearance while an earlier probe is pending', async () => {
			const fileSystem = new FakeWatcherFileSystem(['/repo']);
			fileSystem.deferProbes = true;
			let changes = 0;
			disposables.add(new NodeGitMetadataWatcher(new NullLogService(), fileSystem)
				.watch('/repo/.git', () => changes++));
			fileSystem.takeProbe('/repo/.git').complete(false);
			fileSystem.fire('/repo', 'rename', '.git');
			const staleProbe = fileSystem.takeProbe('/repo/.git');

			// The segment appears while the first event's probe is still pending.
			fileSystem.add('/repo/.git');
			fileSystem.fire('/repo', 'rename', '.git');
			const currentProbe = fileSystem.takeProbe('/repo/.git');
			staleProbe.complete(false);
			await staleProbe.p;
			const afterStaleProbe = { changes, activePaths: fileSystem.activePaths() };
			currentProbe.complete(true);
			await currentProbe.p;

			assert.deepStrictEqual({
				afterStaleProbe,
				afterCurrentProbe: { changes, activePaths: fileSystem.activePaths() },
			}, {
				afterStaleProbe: { changes: 0, activePaths: ['/repo'] },
				afterCurrentProbe: { changes: 1, activePaths: ['/repo/.git'] },
			});
		});

		for (const kind of ['watch', 'watchEntry'] as const) {
			test(`${kind} detects a path that appears before its ancestor watcher is installed`, async () => {
				const missing = kind === 'watch' ? '/repo/.git' : '/repo/worktree';
				const path = kind === 'watch' ? missing : '/repo/worktree/.git';
				const fileSystem = new FakeWatcherFileSystem(['/repo']);
				// The segment appears after its own watch attempt failed and before
				// the ancestor watcher exists, so no watcher event can report it.
				fileSystem.beforeWatch = watchedPath => {
					if (watchedPath === '/repo') {
						fileSystem.beforeWatch = undefined;
						fileSystem.add(missing);
					}
				};
				const changed = new DeferredPromise<void>();
				let changes = 0;
				const watcher = new NodeGitMetadataWatcher(new NullLogService(), fileSystem);
				disposables.add(watcher[kind](path, () => {
					changes++;
					changed.complete();
				}));

				await raceTimeout(changed.p, 1000);

				assert.deepStrictEqual({
					changes,
					watchCalls: fileSystem.watchCalls,
					activePaths: fileSystem.activePaths(),
				}, {
					changes: 1,
					watchCalls: [missing, '/repo', missing],
					activePaths: [missing],
				});
			});
		}
	});

	// macOS FSEvents can drop events for a moment after a watcher starts,
	// especially under load, so these tests recreate the path until the
	// callback arrives. A dropped event delays the test instead of failing it;
	// a watcher that never reports still fails at the deadline. The fake
	// filesystem tests above are the proof of probe ordering and re-arming.
	suite('real filesystem', function () {
		this.timeout(REAL_FS_DEADLINE_MS + 5000);
		let root: string;
		let watchers: DisposableStore;

		setup(async () => {
			watchers = new DisposableStore();
			root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'hucode-git-metadata-watcher-')));
		});

		teardown(async () => {
			// Stop watching before removing the tree so removal events cannot re-arm.
			watchers.dispose();
			await fs.rm(root, { recursive: true, force: true });
		});

		test('reports a missing nested path once it appears', async () => {
			const target = join(root, 'worktrees', 'feature');
			let changes = 0;
			watchers.add(new NodeGitMetadataWatcher(new NullLogService())
				.watch(target, () => changes++));

			await recreateUntil(() => changes > 0, async () => {
				await fs.rm(join(root, 'worktrees'), { recursive: true, force: true });
				await fs.mkdir(target, { recursive: true });
			});
		});

		test('reports entry membership once a missing parent appears', async () => {
			const worktree = join(root, 'worktree');
			let changes = 0;
			watchers.add(new NodeGitMetadataWatcher(new NullLogService())
				.watchEntry(join(worktree, '.git'), () => changes++));

			await recreateUntil(() => changes > 0, async () => {
				await fs.rm(worktree, { recursive: true, force: true });
				await fs.mkdir(worktree);
			});
		});
	});
});

class FakeWatcherFileSystem implements NodeGitMetadataWatcherFileSystem {
	readonly watchCalls: string[] = [];
	deferProbes = false;
	beforeWatch: ((path: string) => void) | undefined;
	private readonly existing = new Set<string>(['/']);
	private readonly watchers = new Set<{
		readonly path: string;
		readonly listener: (event: string, filename: string | null) => void;
	}>();
	private readonly probes: { readonly path: string; readonly result: DeferredPromise<boolean> }[] = [];

	constructor(existing: readonly string[]) {
		this.add(...existing);
	}

	add(...paths: string[]): void {
		for (const path of paths) {
			this.existing.add(path);
		}
	}

	watch(path: string, listener: (event: string, filename: string | null) => void): IDisposable {
		this.watchCalls.push(path);
		this.beforeWatch?.(path);
		if (!this.existing.has(path)) {
			throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
		}
		const watcher = { path, listener };
		this.watchers.add(watcher);
		return toDisposable(() => this.watchers.delete(watcher));
	}

	exists(path: string): Promise<boolean> {
		if (!this.deferProbes) {
			return Promise.resolve(this.existing.has(path));
		}
		const result = new DeferredPromise<boolean>();
		this.probes.push({ path, result });
		return result.p;
	}

	activePaths(): string[] {
		return [...this.watchers].map(watcher => watcher.path);
	}

	fire(path: string, event: string, filename: string | null): void {
		for (const watcher of [...this.watchers]) {
			if (watcher.path === path) {
				watcher.listener(event, filename);
			}
		}
	}

	/** Removes and returns the single pending probe, which must target `path`. */
	takeProbe(path: string): DeferredPromise<boolean> {
		assert.deepStrictEqual(this.probes.map(probe => probe.path), [path]);
		return this.probes.shift()!.result;
	}
}

/**
 * Runs `recreate` now and again after each quiet interval until `predicate`
 * holds, failing once the deadline passes.
 */
async function recreateUntil(predicate: () => boolean, recreate: () => Promise<void>): Promise<void> {
	const deadline = Date.now() + REAL_FS_DEADLINE_MS;
	let nextRecreateAt = 0;
	while (!predicate()) {
		const now = Date.now();
		if (now >= deadline) {
			throw new Error('Timed out waiting for a watcher callback.');
		}
		if (now >= nextRecreateAt) {
			await recreate();
			nextRecreateAt = Date.now() + REAL_FS_RECREATE_INTERVAL_MS;
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}
