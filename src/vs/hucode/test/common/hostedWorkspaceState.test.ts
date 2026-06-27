/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	createHostedWorkspaceRestoreEntries,
	createHostedWorkspaceState,
	getMostRecentHostedWorkspace,
	getReadyHostedWorkspaceState,
	getRestoreActiveWorktreePath,
	hasLoadedHostedWorkspace,
	isHostedWorkspacePendingReady,
	sortRestoreEntries,
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
			entry('loaded'),
		], candidate => candidate.instanceId === 'loaded'), false);
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
