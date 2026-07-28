/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import type {
	IProjectManagerService,
	ProjectRecord,
} from '../../../../platform/projectManager/common/projectManager.js';
import type {
	IHucodeHostedWorkbenchInstance,
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../../../common/omniWindow.js';
import { removeProjectWithHostedWorkbenchCleanup } from
	'../../../browser/projectSwitcher/removeProject.js';

suite('Remove Project', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('closes every hosted instance for the project before removal', async () => {
		const calls: string[] = [];
		const loadedCloseStarted = new DeferredPromise<void>();
		const dormantCloseStarted = new DeferredPromise<void>();
		const releaseLoadedClose =
			new DeferredPromise<IHucodeHostedWorkspaceState>();
		const releaseDormantClose =
			new DeferredPromise<IHucodeHostedWorkspaceState>();
		const activeCloseStarted = new DeferredPromise<void>();
		const releaseActiveClose =
			new DeferredPromise<IHucodeHostedWorkspaceState>();
		const harness = createHarness({
			activeInstanceId: 'active',
			instances: [
				instance('active', 'project', 'active'),
				instance('loaded', 'project', 'loaded'),
				instance('dormant', 'project', 'dormant'),
				instance('other', 'other-project', 'active'),
				instance('arbitrary', undefined, 'active'),
			],
			onClose(instanceId) {
				calls.push(`close:${instanceId}`);
				if (instanceId === 'active') {
					void activeCloseStarted.complete();
					return releaseActiveClose.p;
				}
				if (instanceId === 'loaded') {
					void loadedCloseStarted.complete();
					return releaseLoadedClose.p;
				}
				assert.strictEqual(instanceId, 'dormant');
				void dormantCloseStarted.complete();
				return releaseDormantClose.p;
			},
			onRemove(projectId) {
				calls.push(`remove:${projectId}`);
			},
		});

		const removing = run(harness);
		await loadedCloseStarted.p;
		await Promise.resolve();

		assert.strictEqual(dormantCloseStarted.isSettled, true);
		assert.deepStrictEqual(new Set(calls), new Set([
			'close:loaded',
			'close:dormant',
		]));
		assert.ok(!calls.includes('close:active'));
		assert.ok(!calls.includes('close:other'));
		assert.ok(!calls.includes('close:arbitrary'));
		assert.ok(!calls.includes('remove:project'));

		await releaseLoadedClose.complete(emptyState);
		await Promise.resolve();
		await Promise.resolve();

		assert.strictEqual(activeCloseStarted.isSettled, false);
		assert.deepStrictEqual(calls, [
			'close:loaded',
			'close:dormant',
		]);
		assert.ok(!calls.includes('remove:project'));

		await releaseDormantClose.complete(emptyState);
		await Promise.resolve();
		await Promise.resolve();

		assert.strictEqual(activeCloseStarted.isSettled, true);
		assert.deepStrictEqual(calls, [
			'close:loaded',
			'close:dormant',
			'close:active',
		]);
		assert.ok(!calls.includes('remove:project'));

		await releaseActiveClose.error(new Error('active close failed'));
		await removing;

		assert.strictEqual(calls.at(-1), 'remove:project');
	});

	test('continues removal when hosted cleanup preserves or rejects instances', async () => {
		const removed: string[] = [];
		const preservedState = state([
			instance('vetoed', 'project', 'active'),
			instance('timed-out', 'project', 'loaded'),
		]);
		const harness = createHarness({
			instances: preservedState.instances,
			async onClose(instanceId) {
				if (instanceId === 'rejected') {
					throw new Error('close failed');
				}
				return preservedState;
			},
			onRemove(projectId) {
				removed.push(projectId);
			},
		});
		harness.state.instances = [
			...harness.state.instances,
			instance('rejected', 'project', 'dormant'),
		];

		await run(harness);

		assert.deepStrictEqual(
			new Set(harness.closed),
			new Set(['vetoed', 'timed-out', 'rejected'])
		);
		assert.deepStrictEqual(removed, ['project']);
	});

	test('removes an Omni project with no matching hosted instances', async () => {
		const harness = createHarness({
			instances: [
				instance('other', 'other-project', 'active'),
				instance('arbitrary', undefined, 'loaded'),
			],
		});

		await run(harness);

		assert.strictEqual(harness.stateReads, 1);
		assert.deepStrictEqual(harness.closed, []);
		assert.deepStrictEqual(harness.removed, ['project']);
	});

	test('does nothing when the project no longer exists', async () => {
		const harness = createHarness({ projects: [] });

		await run(harness);

		assert.strictEqual(harness.confirmed.length, 0);
		assert.strictEqual(harness.stateReads, 0);
		assert.deepStrictEqual(harness.closed, []);
		assert.deepStrictEqual(harness.removed, []);
	});

	test('does nothing when removal is cancelled', async () => {
		const harness = createHarness({ confirm: false });

		await run(harness);

		assert.deepStrictEqual(harness.confirmed, ['project']);
		assert.strictEqual(harness.stateReads, 0);
		assert.deepStrictEqual(harness.closed, []);
		assert.deepStrictEqual(harness.removed, []);
	});

	test('keeps non-Omni project removal unchanged', async () => {
		const harness = createHarness({
			isOmniWindow: false,
			instances: [instance('active', 'project', 'active')],
		});

		await run(harness);

		assert.strictEqual(harness.stateReads, 0);
		assert.deepStrictEqual(harness.closed, []);
		assert.deepStrictEqual(harness.removed, ['project']);
	});

	test('propagates project removal failures', async () => {
		const harness = createHarness({
			async onRemove() {
				throw new Error('remove failed');
			},
		});

		await assert.rejects(run(harness), /remove failed/);
	});
});

interface IHarness {
	readonly routing: {
		readonly isOmniWindow: boolean;
		readonly windowId: number;
	};
	readonly projectManagerService: Pick<
		IProjectManagerService,
		'getProjects' | 'removeProject'
	>;
	readonly shellService: Pick<
		IHucodeShellService,
		'getWindowState' | 'closeWorkspace'
	>;
	readonly confirmRemoval: (project: ProjectRecord) => Promise<boolean>;
	readonly confirmed: string[];
	readonly closed: string[];
	readonly removed: string[];
	readonly state: {
		activeInstanceId?: string;
		instances: readonly IHucodeHostedWorkbenchInstance[];
	};
	readonly stateReads: number;
}

function createHarness(options: {
	readonly projects?: readonly ProjectRecord[];
	readonly activeInstanceId?: string;
	readonly instances?: readonly IHucodeHostedWorkbenchInstance[];
	readonly confirm?: boolean;
	readonly isOmniWindow?: boolean;
	readonly onClose?: (
		instanceId: string
	) => Promise<IHucodeHostedWorkspaceState>;
	readonly onRemove?: (projectId: string) => void | Promise<void>;
} = {}): IHarness {
	const confirmed: string[] = [];
	const closed: string[] = [];
	const removed: string[] = [];
	const mutable = {
		stateReads: 0,
		activeInstanceId: options.activeInstanceId,
		instances: options.instances ?? [],
	};
	const projectManagerService = {
		async getProjects() {
			return options.projects ?? [project];
		},
		async removeProject(projectId: string) {
			await options.onRemove?.(projectId);
			removed.push(projectId);
		},
	};
	const shellService = {
		async getWindowState(windowId: number) {
			assert.strictEqual(windowId, 7);
			mutable.stateReads++;
			return state(mutable.instances, mutable.activeInstanceId);
		},
		async closeWorkspace(windowId: number, instanceId?: string) {
			assert.strictEqual(windowId, 7);
			assert.ok(instanceId);
			closed.push(instanceId);
			return options.onClose?.(instanceId) ?? emptyState;
		},
	};

	return {
		routing: {
			isOmniWindow: options.isOmniWindow ?? true,
			windowId: 7,
		},
		projectManagerService,
		shellService,
		async confirmRemoval(candidate) {
			confirmed.push(candidate.id);
			return options.confirm ?? true;
		},
		confirmed,
		closed,
		removed,
		state: mutable,
		get stateReads() {
			return mutable.stateReads;
		},
	};
}

function run(harness: IHarness): Promise<void> {
	return removeProjectWithHostedWorkbenchCleanup(
		'project',
		harness.routing,
		harness.projectManagerService,
		harness.shellService,
		harness.confirmRemoval
	);
}

function instance(
	instanceId: string,
	projectId: string | undefined,
	stateValue: IHucodeHostedWorkbenchInstance['state']
): IHucodeHostedWorkbenchInstance {
	return {
		instanceId,
		projectId,
		worktreePath: `/worktrees/${instanceId}`,
		state: stateValue,
		visible: stateValue === 'active',
		focused: stateValue === 'active',
	};
}

function state(
	instances: readonly IHucodeHostedWorkbenchInstance[],
	activeInstanceId?: string
): IHucodeHostedWorkspaceState {
	return {
		activeInstanceId,
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances,
	};
}

const emptyState = state([]);

const project: ProjectRecord = {
	id: 'project',
	label: 'Project',
	rootUri: URI.file('/project'),
	pinned: false,
	order: 0,
	worktreeState: 'current',
	worktrees: [],
};
