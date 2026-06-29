/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../base/common/async.js';
import { Event } from '../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HucodeOmniWebChildMessageType,
} from '../../../platform/window/common/hucodeOmniWebMessages.js';
import {
	IWebHucodeShellBrowserAdapter,
	WebHucodeShellController,
} from '../../browser/webShellService.js';

suite('WebHucodeShellService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(): {
		readonly service: WebHucodeShellController;
		readonly surface: HTMLElement;
		readonly browser: FakeBrowserAdapter;
	} {
		const surface = document.createElement('div');
		document.body.append(surface);
		disposables.add(toDisposable(() => surface.remove()));

		const browser = new FakeBrowserAdapter();
		const service = disposables.add(new WebHucodeShellController(
			{
				workbenchRoute: '/workbench',
				serverPathCaseSensitive: true,
			},
			{
				async executeCommand() { },
			},
			{
				onDidChangeSurface: Event.None,
				getSurface() {
					return surface;
				},
			},
			browser
		));
		return { service, surface, browser };
	}

	function postMessage(
		browser: FakeBrowserAdapter,
		surface: HTMLElement,
		instanceId: string,
		data: object,
		source?: MessageEventSource | null
	): void {
		const iframe = getIframe(surface, instanceId);
		browser.emitMessage(
			{ instanceId, ...data },
			source === undefined ? iframe.contentWindow : source
		);
	}

	function markCrashed(
		browser: FakeBrowserAdapter,
		surface: HTMLElement,
		instanceId: string
	): void {
		postMessage(browser, surface, instanceId, {
			type: HucodeOmniWebChildMessageType.CommandResult,
			requestId: 'load',
			ok: false,
		});
	}

	function markReady(
		browser: FakeBrowserAdapter,
		surface: HTMLElement,
		instanceId: string
	): void {
		postMessage(browser, surface, instanceId, {
			type: HucodeOmniWebChildMessageType.Ready,
		});
	}

	function markFocused(
		browser: FakeBrowserAdapter,
		surface: HTMLElement,
		instanceId: string
	): void {
		postMessage(browser, surface, instanceId, {
			type: HucodeOmniWebChildMessageType.Focus,
			focused: true,
		});
	}

	function markUnloadReady(
		browser: FakeBrowserAdapter,
		surface: HTMLElement,
		instanceId: string
	): void {
		postMessage(browser, surface, instanceId, {
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
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;

		const firstState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const firstInstanceId = firstState.instances[0].instanceId;

		markCrashed(browser, surface, firstInstanceId);

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
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;

		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;

		markCrashed(browser, surface, instanceId);

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
		markReady(browser, surface, instanceId);
		markFocused(browser, surface, instanceId);

		const nextState = await service.getWindowState(windowId);
		const crashedInstance = nextState.instances.find(
			instance => instance.instanceId === instanceId
		);
		assert.ok(crashedInstance);
		assert.strictEqual(nextState.activeInstanceId, activeInstanceId);
		assert.strictEqual(crashedInstance.state, 'crashed');
	});

	test('reopens hosted iframes as normal workbench URLs', async () => {
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;
		browser.setTimeout(
			() => markUnloadReady(browser, surface, instanceId),
			0
		);
		assert.strictEqual(
			await service.reopenWorkspaceInNormalWindow(windowId, instanceId),
			true
		);

		const openedUrl = browser.openedUrls.at(-1);
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
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;

		postMessage(browser, surface, instanceId, {
			type: HucodeOmniWebChildMessageType.CommandResult,
			requestId: 'load',
			ok: false,
		}, null);

		assert.strictEqual(
			(await service.getWindowState(windowId)).instances[0].state,
			'loading'
		);
	});

	test('scopes iframe self requests to the sender instance', async () => {
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;
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

		browser.setTimeout(
			() => markUnloadReady(browser, surface, firstInstanceId),
			0
		);
		postMessage(browser, surface, firstInstanceId, {
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
		const { service, browser } = createService();
		const windowId = browser.windowId;
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		assert.ok(state.activeInstanceId);
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

		assert.strictEqual(browser.contentFocusCalls, 2);
	});

	test('does not expose desktop-only screenshot or devtools APIs', async () => {
		const { service, browser } = createService();
		const windowId = browser.windowId;

		assert.strictEqual(
			await service.captureWorkspaceScreenshot(windowId),
			undefined
		);
		assert.strictEqual(await service.toggleWorkspaceDevTools(windowId), false);
	});
});

class FakeBrowserAdapter implements IWebHucodeShellBrowserAdapter {
	readonly windowId = 1;
	readonly origin = location.origin;
	readonly openedUrls: string[] = [];
	contentFocusCalls = 0;

	private readonly listeners = new Set<(event: MessageEvent) => void>();

	createIframe(): HTMLIFrameElement {
		return document.createElement('iframe');
	}

	addMessageListener(listener: (event: MessageEvent) => void): IDisposable {
		this.listeners.add(listener);
		return toDisposable(() => this.listeners.delete(listener));
	}

	setTimeout(
		callback: () => void,
		timeout: number
	): ReturnType<typeof setTimeout> {
		return setTimeout(callback, timeout);
	}

	clearTimeout(handle: ReturnType<typeof setTimeout>): void {
		clearTimeout(handle);
	}

	open(url: string): void {
		this.openedUrls.push(url);
	}

	focusIframe(_iframe: HTMLIFrameElement): void { }

	focusIframeContent(_iframe: HTMLIFrameElement): void {
		this.contentFocusCalls++;
	}

	reloadIframe(_iframe: HTMLIFrameElement): void { }

	emitMessage(data: object, source?: MessageEventSource | null): void {
		const event = new MessageEvent('message', {
			origin: this.origin,
			source,
			data,
		});
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}
