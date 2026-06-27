/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getWindowId } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { Event } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { ICommandService } from
	'../../../platform/commands/common/commands.js';
import {
	HucodeOmniWebChildMessageType,
} from '../../../platform/window/common/hucodeOmniWebMessages.js';
import { IBrowserWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/browser/environmentService.js';
import {
	IHucodeWebOmniHostSurfaceService,
} from '../../browser/webOmniHostSurfaceService.js';
import { WebHucodeShellService } from '../../browser/webShellService.js';

suite('WebHucodeShellService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(): WebHucodeShellService {
		return disposables.add(new WebHucodeShellService(
			{
				options: {
					hucodeOmniWorkbenchRoute: '/workbench',
					hucodeServerPathCaseSensitive: true,
				},
			} as unknown as IBrowserWorkbenchEnvironmentService,
			{
				async executeCommand() { },
			} as unknown as ICommandService,
			{
				onDidChangeSurface: Event.None,
				getSurface() {
					return undefined;
				},
				setSurface() { },
			} as unknown as IHucodeWebOmniHostSurfaceService
		));
	}

	function postMessage(instanceId: string, data: object): void {
		mainWindow.dispatchEvent(new MessageEvent('message', {
			origin: mainWindow.location.origin,
			data: { instanceId, ...data },
		}));
	}

	function markCrashed(instanceId: string): void {
		postMessage(instanceId, {
			type: HucodeOmniWebChildMessageType.CommandResult,
			requestId: 'load',
			ok: false,
		});
	}

	function markReady(instanceId: string): void {
		postMessage(instanceId, {
			type: HucodeOmniWebChildMessageType.Ready,
		});
	}

	function markFocused(instanceId: string): void {
		postMessage(instanceId, {
			type: HucodeOmniWebChildMessageType.Focus,
			focused: true,
		});
	}

	function markUnloadReady(instanceId: string): void {
		postMessage(instanceId, {
			type: HucodeOmniWebChildMessageType.UnloadReady,
		});
	}

	test('recreates a crashed iframe when reopening the same worktree', async () => {
		const service = createService();
		const windowId = getWindowId(mainWindow);

		const firstState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const firstInstanceId = firstState.instances[0].instanceId;

		markCrashed(firstInstanceId);

		const crashedState = await service.getWindowState(windowId);
		assert.strictEqual(crashedState.instances[0].state, 'crashed');

		const secondState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);

		assert.strictEqual(secondState.instances.length, 1);
		assert.notStrictEqual(
			secondState.instances[0].instanceId,
			firstInstanceId
		);
		assert.strictEqual(secondState.instances[0].state, 'loading');
	});

	test('does not surface or revive crashed iframe instances', async () => {
		const service = createService();
		const windowId = getWindowId(mainWindow);

		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;

		markCrashed(instanceId);

		assert.strictEqual(
			await service.findHostedWorkspaceByPath('/tmp/hucode-worktree'),
			undefined
		);
		assert.strictEqual(
			await service.focusHostedWorkspaceByPath('/tmp/hucode-worktree'),
			false
		);
		assert.strictEqual(
			await service.reopenWorkspaceInNormalWindow(windowId, instanceId),
			false
		);
		assert.strictEqual(
			await service.runActionInWorkspace(windowId, {
				id: 'test.command',
				from: 'menu',
			}),
			false
		);

		const activeState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree-two',
			'project'
		);
		const activeInstanceId = activeState.activeInstanceId;
		assert.ok(activeInstanceId);

		await service.notifyHostedWorkspaceReady(windowId, instanceId);
		markReady(instanceId);
		markFocused(instanceId);

		const nextState = await service.getWindowState(windowId);
		const crashedInstance = nextState.instances.find(
			instance => instance.instanceId === instanceId
		);
		assert.ok(crashedInstance);
		assert.strictEqual(nextState.activeInstanceId, activeInstanceId);
		assert.strictEqual(crashedInstance.state, 'crashed');
	});

	test('reopens hosted iframes as normal workbench URLs', async () => {
		const service = createService();
		const windowId = getWindowId(mainWindow);
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;
		let openedUrl: string | undefined;
		const originalOpen = mainWindow.open;
		try {
			mainWindow.open = ((url?: string | URL) => {
				openedUrl = url?.toString();
				return null;
			}) as typeof mainWindow.open;

			mainWindow.setTimeout(() => markUnloadReady(instanceId), 0);
			assert.strictEqual(
				await service.reopenWorkspaceInNormalWindow(windowId, instanceId),
				true
			);
		} finally {
			mainWindow.open = originalOpen;
		}

		assert.ok(openedUrl);
		const opened = new URL(openedUrl);
		assert.strictEqual(opened.pathname, '/workbench');
		assert.strictEqual(opened.searchParams.get('folder'), '/tmp/hucode-worktree');
		assert.strictEqual(opened.searchParams.has('payload'), false);
		assert.strictEqual(
			(await service.getWindowState(windowId)).instances.length,
			0
		);
	});
});
