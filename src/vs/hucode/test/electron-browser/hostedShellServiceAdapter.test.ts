/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { HucodeHostedShellOperationOutcome } from
	'../../../platform/window/common/hucodeHostedShellService.js';
import { HucodeHostedShellAction } from
	'../../../platform/window/common/hucodeHostedShellActions.js';
import { INativeWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/electron-browser/environmentService.js';
import { DesktopHostedShellServiceAdapter } from
	'../../electron-browser/hostedShellServiceAdapter.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../../common/omniWindow.js';

suite('DesktopHostedShellServiceAdapter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('projects self state and preserves inactive self lifecycle authority',
		async () => {
			const changes = new Emitter<{
				readonly windowId: number;
				readonly state: IHucodeHostedWorkspaceState;
			}>();
			disposables.add(changes);
			let state = createState('other');
			const calls: string[] = [];
			const shell = {
				onDidChangeWindowState: changes.event,
				getWindowState: async () => state,
				notifyHostedWorkspaceReady: async () => { calls.push('ready:self'); },
				closeWorkspace: async (_windowId: number, instanceId: string) => {
					calls.push(`close:${instanceId}`);
					return state;
				},
				reopenWorkspaceInNormalWindow: async (
					_windowId: number,
					instanceId: string
				) => {
					calls.push(`reopen:${instanceId}`);
					return true;
				},
				focusHostedWorkspaceByPath: async (path: string) => {
					calls.push(`focusPath:${path}`);
					state = createState('self');
					return true;
				},
				focusWorkspace: async () => { calls.push('focusWorkspace'); },
				reloadWorkspace: async () => { calls.push('reload'); },
				focusShell: async () => { calls.push('focusShell'); },
				runActionInShell: async () => {
					calls.push('action');
					return true;
				},
			} as Partial<IHucodeShellService> as IHucodeShellService;
			const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
				{
					window: { id: 7 },
					isHostedOmniWorkspace: true,
					hostedInstanceId: 'self',
				} as INativeWorkbenchEnvironmentService,
				shell
			));

			assert.deepStrictEqual(await adapter.getState(), {
				available: true,
				projectsSidebarVisible: true,
				projectSwitcherCanGoBack: false,
				projectSwitcherCanGoForward: true,
				lifecycleState: 'loaded',
				active: false,
				visible: false,
			});
			assert.strictEqual(
				await adapter.requestShellAction(HucodeHostedShellAction.AddProject),
				HucodeHostedShellOperationOutcome.Rejected
			);
			assert.strictEqual(
				await adapter.requestShellAction('bad' as HucodeHostedShellAction),
				HucodeHostedShellOperationOutcome.Unsupported
			);
			assert.strictEqual(
				await adapter.reloadSelf(),
				HucodeHostedShellOperationOutcome.Rejected
			);
			assert.strictEqual(
				await adapter.closeSelf(),
				HucodeHostedShellOperationOutcome.Accepted
			);
			assert.strictEqual(
				await adapter.reopenSelfInNormalWindow(),
				HucodeHostedShellOperationOutcome.Accepted
			);
			assert.strictEqual(
				await adapter.focusSelf(),
				HucodeHostedShellOperationOutcome.Accepted
			);
			assert.deepStrictEqual(calls, [
				'close:self',
				'reopen:self',
				'focusPath:/tmp/self',
				'focusWorkspace',
			]);

			assert.strictEqual(
				await adapter.triggerPasteInSelf(),
				HucodeHostedShellOperationOutcome.Unavailable
			);
			assert.strictEqual(await adapter.captureSelfScreenshot(), undefined);
		});
});

function createState(activeInstanceId: string): IHucodeHostedWorkspaceState {
	return {
		activeInstanceId,
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: true,
		instances: [{
			instanceId: 'self',
			projectId: 'project',
			worktreePath: '/tmp/self',
			state: activeInstanceId === 'self' ? 'active' : 'loaded',
			visible: activeInstanceId === 'self',
			focused: false,
		}, {
			instanceId: 'other',
			worktreePath: '/tmp/other',
			state: activeInstanceId === 'other' ? 'active' : 'loaded',
			visible: activeInstanceId === 'other',
			focused: false,
		}],
	};
}
