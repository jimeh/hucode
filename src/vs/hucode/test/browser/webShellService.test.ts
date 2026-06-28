/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getWindowId } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { timeout } from '../../../base/common/async.js';
import { Event } from '../../../base/common/event.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
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

	function createService(): {
		readonly service: WebHucodeShellService;
		readonly surface: HTMLElement;
	} {
		const surface = document.createElement('div');
		mainWindow.document.body.append(surface);
		disposables.add(toDisposable(() => surface.remove()));

		const service = disposables.add(new WebHucodeShellService(
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
					return surface;
				},
				setSurface() { },
			} as unknown as IHucodeWebOmniHostSurfaceService
		));
		return { service, surface };
	}

	function postMessage(
		surface: HTMLElement,
		instanceId: string,
		data: object,
		source?: MessageEventSource | null
	): void {
		const iframe = getIframe(surface, instanceId);
		mainWindow.dispatchEvent(new MessageEvent('message', {
			origin: mainWindow.location.origin,
			source: source ?? iframe.contentWindow,
			data: { instanceId, ...data },
		}));
	}

	function markCrashed(surface: HTMLElement, instanceId: string): void {
		postMessage(surface, instanceId, {
			type: HucodeOmniWebChildMessageType.CommandResult,
			requestId: 'load',
			ok: false,
		});
	}

	function markReady(surface: HTMLElement, instanceId: string): void {
		postMessage(surface, instanceId, {
			type: HucodeOmniWebChildMessageType.Ready,
		});
	}

	function markFocused(surface: HTMLElement, instanceId: string): void {
		postMessage(surface, instanceId, {
			type: HucodeOmniWebChildMessageType.Focus,
			focused: true,
		});
	}

	function markUnloadReady(surface: HTMLElement, instanceId: string): void {
		postMessage(surface, instanceId, {
			type: HucodeOmniWebChildMessageType.UnloadReady,
		});
	}

	function getIframe(
		surface: HTMLElement,
		instanceId: string
	): HTMLIFrameElement {
		const iframe = surface.querySelector<HTMLIFrameElement>(
			`[data-hucode-hosted-instance-id="${instanceId}"]`
		);
		assert.ok(iframe);
		return iframe;
	}

	test('recreates a crashed iframe when reopening the same worktree', async () => {
		const { service, surface } = createService();
		const windowId = getWindowId(mainWindow);

		const firstState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const firstInstanceId = firstState.instances[0].instanceId;

		markCrashed(surface, firstInstanceId);

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
		const { service, surface } = createService();
		const windowId = getWindowId(mainWindow);

		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;

		markCrashed(surface, instanceId);

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
		markReady(surface, instanceId);
		markFocused(surface, instanceId);

		const nextState = await service.getWindowState(windowId);
		const crashedInstance = nextState.instances.find(
			instance => instance.instanceId === instanceId
		);
		assert.ok(crashedInstance);
		assert.strictEqual(nextState.activeInstanceId, activeInstanceId);
		assert.strictEqual(crashedInstance.state, 'crashed');
	});

	test('reopens hosted iframes as normal workbench URLs', async () => {
		const { service, surface } = createService();
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

			mainWindow.setTimeout(() => markUnloadReady(surface, instanceId), 0);
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

	test('ignores child messages from the wrong iframe source', async () => {
		const { service, surface } = createService();
		const windowId = getWindowId(mainWindow);
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;

		postMessage(surface, instanceId, {
			type: HucodeOmniWebChildMessageType.CommandResult,
			requestId: 'load',
			ok: false,
		}, mainWindow);

		assert.strictEqual(
			(await service.getWindowState(windowId)).instances[0].state,
			'loading'
		);
	});

	test('scopes iframe self requests to the sender instance', async () => {
		const { service, surface } = createService();
		const windowId = getWindowId(mainWindow);
		const firstState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree-one',
			'project'
		);
		const firstInstanceId = firstState.instances[0].instanceId;
		const secondState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree-two',
			'project'
		);
		const secondInstanceId = secondState.activeInstanceId;
		assert.ok(secondInstanceId);

		mainWindow.setTimeout(
			() => markUnloadReady(surface, firstInstanceId),
			0
		);
		postMessage(surface, firstInstanceId, {
			type: HucodeOmniWebChildMessageType.ShellRequest,
			requestId: 'close-self',
			method: 'closeWorkspace',
			args: [windowId, secondInstanceId],
		});
		await timeout(0);

		const state = await service.getWindowState(windowId);
		assert.strictEqual(
			state.instances.some(
				instance => instance.instanceId === firstInstanceId
			),
			false
		);
		assert.strictEqual(
			state.instances.some(
				instance => instance.instanceId === secondInstanceId
			),
			true
		);
	});

	test('uses browser-limited native keybinding and paste behavior', async () => {
		const { service, surface } = createService();
		const windowId = getWindowId(mainWindow);
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const iframe = getIframe(surface, state.instances[0].instanceId);
		assert.ok(iframe.contentWindow);

		let focusCalls = 0;
		const originalFocus = iframe.contentWindow.focus;
		try {
			iframe.contentWindow.focus = () => {
				focusCalls++;
			};

			assert.strictEqual(
				await service.runKeybindingInWorkspace(windowId, {
					userSettingsLabel: 'Ctrl+A',
				}),
				false
			);
			assert.strictEqual(
				await service.triggerPasteInWorkspace(windowId),
				false
			);
		} finally {
			iframe.contentWindow.focus = originalFocus;
		}

		assert.strictEqual(focusCalls, 2);
	});

	test('does not expose desktop-only screenshot or devtools APIs', async () => {
		const { service } = createService();
		const windowId = getWindowId(mainWindow);

		assert.strictEqual(
			await service.captureWorkspaceScreenshot(windowId),
			undefined
		);
		assert.strictEqual(await service.toggleWorkspaceDevTools(windowId), false);
	});
});
