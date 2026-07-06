/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeHostedWorkspaceState
} from '../../common/omniWindow.js';
import {
	IHucodeHostedWorkspaceReopenDelegate,
	reopenHucodeHostedWorkspaceInNormalWindow
} from '../../electron-main/omniWorkspaceReopen.js';

suite('HucodeOmniWorkspaceReopen', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function state(
		instances: IHucodeHostedWorkspaceState['instances']
	): IHucodeHostedWorkspaceState {
		return {
			activeInstanceId: instances[0]?.instanceId,
			projectsSidebarVisible: false,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances,
		};
	}

	function instance(
		stateValue: HucodeHostedWorkbenchLifecycleState = 'active'
	): IHucodeHostedWorkspaceState['instances'][number] {
		return {
			instanceId: 'instance',
			projectId: 'project',
			worktreePath: '/repo',
			state: stateValue,
			visible: true,
			focused: true,
		};
	}

	test('ignores missing hosted instance', async () => {
		const calls: string[] = [];
		const delegate: IHucodeHostedWorkspaceReopenDelegate = {
			getState: () => state([]),
			closeWorkspace: async () => {
				calls.push('close');
			},
			focusNormalWindowByPath: async () => {
				calls.push('focusNormal');
				return true;
			},
			openNormalWindow: async () => {
				calls.push('openNormal');
			},
		};

		assert.strictEqual(
			await reopenHucodeHostedWorkspaceInNormalWindow(
				delegate,
				'instance'
			),
			false
		);
		assert.deepStrictEqual(calls, []);
	});

	for (const stateValue of ['crashed', 'unloaded'] as const) {
		test(`ignores ${stateValue} hosted instance`, async () => {
			const calls: string[] = [];
			const delegate: IHucodeHostedWorkspaceReopenDelegate = {
				getState: () => state([instance(stateValue)]),
				closeWorkspace: async () => {
					calls.push('close');
				},
				focusNormalWindowByPath: async () => {
					calls.push('focusNormal');
					return true;
				},
				openNormalWindow: async () => {
					calls.push('openNormal');
				},
			};

			assert.strictEqual(
				await reopenHucodeHostedWorkspaceInNormalWindow(
					delegate,
					'instance'
				),
				false
			);
			assert.deepStrictEqual(calls, []);
		});
	}

	test('closes hosted instance before focusing existing normal window',
		async () => {
			const calls: string[] = [];
			let currentState = state([instance()]);
			const delegate: IHucodeHostedWorkspaceReopenDelegate = {
				getState: () => currentState,
				closeWorkspace: async targetInstanceId => {
					assert.strictEqual(targetInstanceId, 'instance');
					calls.push('close');
					currentState = state([]);
				},
				focusNormalWindowByPath: async worktreePath => {
					assert.strictEqual(worktreePath, '/repo');
					calls.push('focusNormal');
					return true;
				},
				openNormalWindow: async () => {
					calls.push('openNormal');
				},
			};

			assert.strictEqual(
				await reopenHucodeHostedWorkspaceInNormalWindow(
					delegate,
					'instance'
				),
				true
			);
			assert.deepStrictEqual(calls, ['close', 'focusNormal']);
		}
	);

	test('does not focus or open when hosted close is vetoed', async () => {
		const calls: string[] = [];
		const currentState = state([instance()]);
		const delegate: IHucodeHostedWorkspaceReopenDelegate = {
			getState: () => currentState,
			closeWorkspace: async () => {
				calls.push('close');
			},
			focusNormalWindowByPath: async () => {
				calls.push('focusNormal');
				return true;
			},
			openNormalWindow: async () => {
				calls.push('openNormal');
			},
		};

		assert.strictEqual(
			await reopenHucodeHostedWorkspaceInNormalWindow(
				delegate,
				'instance'
			),
			false
		);
		assert.deepStrictEqual(calls, ['close']);
	});

	test('opens normal window when no existing normal window owns path',
		async () => {
			const calls: string[] = [];
			let currentState = state([instance()]);
			const delegate: IHucodeHostedWorkspaceReopenDelegate = {
				getState: () => currentState,
				closeWorkspace: async targetInstanceId => {
					calls.push(`close:${targetInstanceId}`);
					currentState = state([]);
				},
				focusNormalWindowByPath: async worktreePath => {
					calls.push(`focusNormal:${worktreePath}`);
					return false;
				},
				openNormalWindow: async worktreePath => {
					calls.push(`openNormal:${worktreePath}`);
				},
			};

			assert.strictEqual(
				await reopenHucodeHostedWorkspaceInNormalWindow(
					delegate,
					'instance'
				),
				true
			);
			assert.deepStrictEqual(calls, [
				'close:instance',
				'focusNormal:/repo',
				'openNormal:/repo',
			]);
		}
	);
});
