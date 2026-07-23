/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	createHostedWorkspaceRestoreEntries,
	createHostedWorkspaceState,
	getMostRecentHostedWorkspace,
	getReadyHostedWorkspaceState,
	getRestoreActiveWorktreePath,
	hasLoadedHostedWorkspace,
	HostedWorkspaceStateModel,
	isHostedWorkspaceAvailable,
	isHostedWorkspacePendingReady,
	isHostedWorkspaceRestorable,
	sortRestoreEntries,
	waitForHostedWorkspaceReady,
	type IHostedWorkspaceStateEntry,
} from '../../common/hostedWorkspaceState.js';

suite('HostedWorkspaceState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('projects active instance first then inactive by recency', () => {
		const state = createHostedWorkspaceState([
			entry('one', { lastActiveAt: 10 }),
			entry('two', { lastActiveAt: 30 }),
			entry('three', { lastActiveAt: 20 }),
		], 'three', true, false, true);

		assert.deepStrictEqual({
			instances: state.instances.map(instance => instance.instanceId),
			activeInstanceId: state.activeInstanceId,
			projectsSidebarVisible: state.projectsSidebarVisible,
			projectSwitcherCanGoBack: state.projectSwitcherCanGoBack,
			projectSwitcherCanGoForward: state.projectSwitcherCanGoForward,
		}, {
			instances: ['three', 'two', 'one'],
			activeInstanceId: 'three',
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: true,
		});
	});

	test('reports loaded workspaces while excluding terminal states', () => {
		assert.strictEqual(hasLoadedHostedWorkspace([
			entry('crashed', { state: 'crashed' }),
			entry('unloaded', { state: 'unloaded' }),
		]), false);
		assert.strictEqual(hasLoadedHostedWorkspace([
			entry('loading', { state: 'loading' }),
		]), true);
		assert.strictEqual(hasLoadedHostedWorkspace([
			entry('dormant', { state: 'dormant' }),
		]), false);
		assert.strictEqual(hasLoadedHostedWorkspace([
			entry('loaded'),
		], candidate => candidate.instanceId === 'loaded'), false);
	});

	test('distinguishes dormant restore state from live availability', () => {
		const dormant = entry('dormant', { state: 'dormant' });

		assert.deepStrictEqual({
			dormantAvailable: isHostedWorkspaceAvailable(dormant),
			dormantRestorable: isHostedWorkspaceRestorable(dormant),
			unloadedRestorable: isHostedWorkspaceRestorable(
				entry('unloaded', { state: 'unloaded' })
			),
		}, {
			dormantAvailable: false,
			dormantRestorable: true,
			unloadedRestorable: false,
		});
	});

	test('uses active selection for ready state', () => {
		const candidate = entry('one', { state: 'loading' });

		assert.strictEqual(getReadyHostedWorkspaceState(candidate, 'one'), 'active');
		assert.strictEqual(getReadyHostedWorkspaceState(candidate, 'two'), 'loaded');
		assert.strictEqual(isHostedWorkspacePendingReady(candidate), true);
		assert.strictEqual(
			isHostedWorkspacePendingReady(entry('loaded')),
			false
		);
		assert.strictEqual(
			isHostedWorkspaceAvailable(entry('crashed', { state: 'crashed' })),
			false
		);
	});

	test('models hosted workspace indexing and shell state', () => {
		let clock = 10;
		const model = new HostedWorkspaceStateModel<IHostedWorkspaceStateEntry>(
			path => path.toLowerCase(),
			() => clock
		);
		const first = entry('one', { worktreePath: '/Repo/One' });
		const second = entry('two', { worktreePath: '/repo/two' });

		model.addInstance(first);
		model.addInstance(second);
		assert.strictEqual(model.getInstanceByPath('/repo/one'), first);

		clock = 20;
		model.activateInstance(second);
		assert.strictEqual(model.activeInstanceId, 'two');
		assert.strictEqual(second.lastActiveAt, 20);
		assert.strictEqual(second.state, 'active');

		model.markInstanceReady(second);
		assert.strictEqual(second.state, 'active');
		assert.strictEqual(
			model.setProjectSwitcherNavigationState(true, false),
			true
		);
		assert.strictEqual(
			model.setProjectSwitcherNavigationState(true, false),
			false
		);
		assert.strictEqual(model.projectSwitcherCanGoBack, true);
		const sectionOrderChanged = model.setProjectSwitcherSectionOrder(
			['projects', 'workbenches']
		);
		const emptySectionOrderChanged =
			model.setProjectSwitcherSectionOrder([]);
		const duplicateSectionOrderChanged = model.setProjectSwitcherSectionOrder(
			['projects', 'projects']
		);
		assert.deepStrictEqual({
			sectionOrderChanged,
			emptySectionOrderChanged,
			duplicateSectionOrderChanged,
			sectionOrder: model.projectSwitcherSectionOrder,
		}, {
			sectionOrderChanged: true,
			emptySectionOrderChanged: false,
			duplicateSectionOrderChanged: false,
			sectionOrder: ['projects', 'workbenches'],
		});

		assert.strictEqual(model.setProjectsSidebarVisible(false, false), false);
		assert.strictEqual(model.projectsSidebarVisible, true);
		assert.strictEqual(model.setProjectsSidebarVisible(false, true), true);
		assert.strictEqual(model.projectsSidebarVisible, false);

		assert.deepStrictEqual({
			activeInstanceId: model.toState().activeInstanceId,
			instances: model.toState().instances.map(instance => instance.instanceId),
		}, {
			activeInstanceId: 'two',
			instances: ['two', 'one'],
		});

		model.removeInstance(second);
		assert.strictEqual(model.activeInstanceId, undefined);
		assert.strictEqual(model.getInstanceByPath('/repo/two'), undefined);
	});

	test('promotes and demotes ready instances during activation', () => {
		const model = new HostedWorkspaceStateModel<IHostedWorkspaceStateEntry>();
		const first = entry('one');
		const second = entry('two');
		const loading = entry('three', { state: 'loading' });

		model.addInstance(first);
		model.addInstance(second);
		model.addInstance(loading);

		model.activateInstance(first);
		model.activateInstance(second);
		assert.strictEqual(first.state, 'loaded');
		assert.strictEqual(second.state, 'active');

		model.activateInstance(loading);
		assert.strictEqual(second.state, 'loaded');
		assert.strictEqual(loading.state, 'loading');
	});

	test('keeps normalized path collisions indexed consistently', () => {
		const model = new HostedWorkspaceStateModel<IHostedWorkspaceStateEntry>(
			path => path.toLowerCase()
		);
		const first = entry('one', { worktreePath: '/Repo' });
		const second = entry('two', { worktreePath: '/repo' });

		model.addInstance(first);
		model.activateInstance(first);
		model.addInstance(second);

		assert.deepStrictEqual({
			activeInstanceId: model.activeInstanceId,
			instances: [...model.instancesById.keys()],
			pathInstance: model.getInstanceByPath('/REPO')?.instanceId,
		}, {
			activeInstanceId: undefined,
			instances: ['two'],
			pathInstance: 'two',
		});

		model.removeInstance(first);
		assert.strictEqual(model.getInstanceByPath('/repo'), second);

		model.removeInstance(second);
		assert.strictEqual(model.getInstanceByPath('/repo'), undefined);
	});

	test('selects most recent available workspace', () => {
		const entries = [
			entry('one', { lastActiveAt: 10 }),
			entry('two', { lastActiveAt: 30 }),
			entry('three', { lastActiveAt: 20, state: 'crashed' }),
		];

		assert.strictEqual(
			getMostRecentHostedWorkspace(entries, 'two')?.instanceId,
			'one'
		);
		assert.strictEqual(
			getMostRecentHostedWorkspace(entries)?.instanceId,
			'two'
		);
	});

	test('honors configured restore active path when present', () => {
		const entries = [
			restoreEntry('/repo/one', 10, 'loaded'),
			restoreEntry('/repo/two', 20, 'active'),
		];

		assert.strictEqual(
			getRestoreActiveWorktreePath(entries, '/repo/one'),
			'/repo/one'
		);
		assert.strictEqual(
			getRestoreActiveWorktreePath(entries, '/repo/missing'),
			'/repo/two'
		);
	});

	test('sorts restore entries with active path first', () => {
		const sorted = sortRestoreEntries([
			restoreEntry('/repo/old', 10, 'loaded'),
			restoreEntry('/repo/new', 30, 'loaded'),
			restoreEntry('/repo/active', 20, 'active'),
		], '/repo/active');

		assert.deepStrictEqual(
			sorted.map(entry => entry.worktreePath),
			['/repo/active', '/repo/new', '/repo/old']
		);
	});

	test('creates restore entries from live state', () => {
		const entries = createHostedWorkspaceRestoreEntries([
			entry('one', {
				projectId: 'project',
				worktreePath: '/repo/one',
				lastActiveAt: 10,
			}),
			entry('two', {
				worktreePath: '/repo/two',
				lastActiveAt: 30,
				state: 'crashed',
			}),
			entry('three', {
				worktreePath: '/repo/three',
				lastActiveAt: 20,
			}),
		], 'three');

		assert.deepStrictEqual(entries, [
			restoreEntry('/repo/three', 20, 'active'),
			{
				projectId: 'project',
				worktreePath: '/repo/one',
				lastActiveAt: 10,
				state: 'loaded',
			},
		]);
	});

	test('waits for hosted workspace readiness through shared helper', async () => {
		const stateEmitter = new Emitter<void>();
		const candidate = entry('one', { state: 'loading' });

		try {
			const ready = waitForHostedWorkspaceReady(
				candidate,
				stateEmitter.event,
				1000
			);
			candidate.state = 'active';
			stateEmitter.fire();

			assert.strictEqual(await ready, true);
		} finally {
			stateEmitter.dispose();
		}
	});

	test('handles synchronous readiness events during subscription', async () => {
		const candidate = entry('one', { state: 'loading' });
		const ready = waitForHostedWorkspaceReady(
			candidate,
			listener => {
				candidate.state = 'active';
				listener(undefined);
				return { dispose() { } };
			},
			1000
		);

		assert.strictEqual(await ready, true);
	});

	test('reports readiness timeout through shared helper', async () => {
		const stateEmitter = new Emitter<void>();
		const candidate = entry('one', { state: 'loading' });

		try {
			assert.strictEqual(
				await waitForHostedWorkspaceReady(
					candidate,
					stateEmitter.event,
					1
				),
				false
			);
		} finally {
			stateEmitter.dispose();
		}
	});
});

function entry(
	instanceId: string,
	overrides: Partial<IHostedWorkspaceStateEntry> = {}
): IHostedWorkspaceStateEntry {
	return {
		instanceId,
		worktreePath: overrides.worktreePath ?? `/repo/${instanceId}`,
		state: overrides.state ?? 'loaded',
		visible: overrides.visible ?? false,
		focused: overrides.focused ?? false,
		projectId: overrides.projectId,
		lastActiveAt: overrides.lastActiveAt,
	};
}

function restoreEntry(
	worktreePath: string,
	lastActiveAt: number,
	state: 'active' | 'loaded'
) {
	return { worktreePath, lastActiveAt, state };
}
