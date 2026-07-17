/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { raceTimeout } from '../../../base/common/async.js';
import { Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import {
	DisposableStore,
	IDisposable,
	toDisposable,
} from '../../../base/common/lifecycle.js';
import { Client as MessagePortClient } from
	'../../../base/parts/ipc/browser/ipc.mp.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HUCODE_OMNI_WEB_SHELL_CHANNEL,
	HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
	HucodeOmniWebChildMessageType,
	IHucodeOmniWebWorkbenchClient,
} from '../../../platform/window/common/hucodeOmniWebMessages.js';
import { INativeOpenFileRequest } from
	'../../../platform/window/common/window.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../../common/omniWindow.js';
import {
	IWebHucodeShellBrowserAdapter,
	IWebHucodeShellPersistedState,
	IWebHucodeShellPersistenceAdapter,
	WebHucodeShellController,
} from '../../browser/webShellService.js';

suite('WebHucodeShellService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(
		browser: FakeBrowserAdapter = new FakeBrowserAdapter(),
		persistence?: IWebHucodeShellPersistenceAdapter,
		restorePolicy: 'active' | 'all' | 'none' = 'active'
	): {
		readonly service: WebHucodeShellController;
		readonly surface: HTMLElement;
		readonly browser: FakeBrowserAdapter;
	} {
		const surface = document.createElement('div');
		document.body.append(surface);
		disposables.add(toDisposable(() => surface.remove()));

		const service = disposables.add(new WebHucodeShellController(
			{
				workbenchRoute: '/workbench',
				hostedWorkbenchRoute: '/omni/workbench',
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
			browser,
			persistence,
			restorePolicy
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

	interface IConnectedChild {
		readonly workbench: FakeHostedWorkbench;
		readonly shell: IHucodeShellService;
		readonly shellWindowId: number;
	}

	function connectChild(
		browser: FakeBrowserAdapter,
		surface: HTMLElement,
		instanceId: string
	): IConnectedChild {
		markReady(browser, surface, instanceId);

		const posted = browser.portMessages.at(-1);
		assert.ok(posted, 'expected a transferred shell port');
		assert.strictEqual(posted.instanceId, instanceId);

		const client = disposables.add(new MessagePortClient(
			posted.port,
			`test-child-${instanceId}`
		));
		const workbench = new FakeHostedWorkbench();
		client.registerChannel(
			HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
			ProxyChannel.fromService(
				workbench,
				disposables.add(new DisposableStore())
			)
		);
		const shell = ProxyChannel.toService<IHucodeShellService>(
			client.getChannel(HUCODE_OMNI_WEB_SHELL_CHANNEL)
		);
		return { workbench, shell, shellWindowId: posted.windowId };
	}

	async function waitForInstanceState(
		service: WebHucodeShellController,
		windowId: number,
		instanceId: string,
		state: string
	): Promise<IHucodeHostedWorkspaceState> {
		const matches = async () => {
			const current = await service.getWindowState(windowId);
			return current.instances.find(
				instance => instance.instanceId === instanceId
			)?.state === state ? current : undefined;
		};

		const immediate = await matches();
		if (immediate) {
			return immediate;
		}

		const result = await raceTimeout((async () => {
			for await (const _ of toAsyncIterable(
				service.onDidChangeWindowState
			)) {
				const current = await matches();
				if (current) {
					return current;
				}
			}
			return undefined;
		})(), 2000);
		assert.ok(result, `expected instance to reach state '${state}'`);
		return result;
	}

	async function* toAsyncIterable<T>(event: Event<T>): AsyncIterable<T> {
		const buffer: T[] = [];
		let notify: (() => void) | undefined;
		const listener = event(value => {
			buffer.push(value);
			notify?.();
		});
		try {
			while (true) {
				if (buffer.length) {
					yield buffer.shift()!;
				} else {
					await new Promise<void>(resolve => { notify = resolve; });
					notify = undefined;
				}
			}
		} finally {
			listener.dispose();
		}
	}

	async function crashInstance(
		service: WebHucodeShellController,
		browser: FakeBrowserAdapter,
		surface: HTMLElement,
		windowId: number,
		instanceId: string
	): Promise<void> {
		const child = connectChild(browser, surface, instanceId);
		child.workbench.runCommandResult = false;
		await service.reloadWorkspace(windowId);
		await waitForInstanceState(service, windowId, instanceId, 'crashed');
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

	test('loads hosted iframes through the hosted workbench route', async () => {
		const { service, surface, browser } = createService();

		const state = await service.openWorkspace(
			browser.windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const iframe = getIframe(surface, state.instances[0].instanceId);
		const src = new URL(iframe.src);
		const payload = new Map<string, string>(
			JSON.parse(src.searchParams.get('payload') ?? '[]')
		);

		assert.deepStrictEqual({
			pathname: src.pathname,
			folder: src.searchParams.get('folder'),
			isHostedOmniWorkspace: payload.get('isHostedOmniWorkspace'),
			hostedInstanceId: payload.get('hostedInstanceId'),
		}, {
			pathname: '/omni/workbench',
			folder: '/tmp/hucode-worktree',
			isHostedOmniWorkspace: 'true',
			hostedInstanceId: state.instances[0].instanceId,
		});
	});

	test('serves the shell service over the transferred message port', async () => {
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;
		const child = connectChild(browser, surface, instanceId);

		assert.strictEqual(child.shellWindowId, windowId);

		const remoteState = await child.shell.getWindowState(
			child.shellWindowId
		);
		assert.deepStrictEqual({
			activeInstanceId: remoteState.activeInstanceId,
			state: remoteState.instances[0].state,
		}, {
			activeInstanceId: instanceId,
			state: 'active',
		});

		const stateChange = Event.toPromise(Event.filter(
			child.shell.onDidChangeWindowState,
			change => change.state.projectSwitcherCanGoBack
		));
		await service.setProjectSwitcherNavigationState(windowId, true, false);
		const change = await raceTimeout(stateChange, 2000);
		assert.strictEqual(change?.state.projectSwitcherCanGoBack, true);
	});

	test('closes the requested instance through the shell channel', async () => {
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;
		const firstState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree-one',
			'project'
		);
		const firstInstanceId = firstState.instances[0].instanceId;
		const firstChild = connectChild(browser, surface, firstInstanceId);
		await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree-two',
			'project'
		);

		await firstChild.shell.closeWorkspace(
			firstChild.shellWindowId,
			firstInstanceId
		);

		const state = await service.getWindowState(windowId);
		assert.deepStrictEqual({
			remaining: state.instances.map(instance => instance.worktreePath),
			unloads: firstChild.workbench.prepareUnloadCalls,
		}, {
			remaining: ['/tmp/hucode-worktree-two'],
			unloads: 1,
		});
	});

	test('keeps the hosted iframe when the workbench vetoes unload', async () => {
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;
		const child = connectChild(browser, surface, instanceId);
		child.workbench.prepareUnloadResult = false;

		const vetoedState = await service.closeWorkspace(windowId, instanceId);
		assert.deepStrictEqual({
			instanceIds: vetoedState.instances.map(
				instance => instance.instanceId
			),
			iframeConnected: getIframe(surface, instanceId).isConnected,
		}, {
			instanceIds: [instanceId],
			iframeConnected: true,
		});

		child.workbench.prepareUnloadResult = true;
		const closedState = await service.closeWorkspace(windowId, instanceId);
		assert.strictEqual(closedState.instances.length, 0);
	});

	test('keeps the hosted iframe when unload times out', async () => {
		const browser = new ZeroDelayBrowserAdapter();
		const { service, surface } = createService(browser);
		const windowId = browser.windowId;
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;
		const child = connectChild(browser, surface, instanceId);
		child.workbench.prepareUnloadResult = new Promise<boolean>(() => { });

		const timedOutState = await service.closeWorkspace(windowId, instanceId);
		assert.deepStrictEqual({
			instanceIds: timedOutState.instances.map(
				instance => instance.instanceId
			),
			iframeConnected: getIframe(surface, instanceId).isConnected,
		}, {
			instanceIds: [instanceId],
			iframeConnected: true,
		});
	});

	test('closes never-ready workbenches without an unload handshake', async () => {
		const { service, browser } = createService();
		const windowId = browser.windowId;
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;
		assert.strictEqual(state.instances[0].state, 'loading');

		const closedState = await service.closeWorkspace(windowId, instanceId);
		assert.strictEqual(closedState.instances.length, 0);
	});

	test('forwards workspace actions to the hosted workbench channel', async () => {
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;
		const child = connectChild(browser, surface, instanceId);

		const ran = await service.runActionInWorkspace(windowId, {
			id: 'test.command',
			from: 'menu',
			args: ['payload'],
		});

		assert.deepStrictEqual({
			ran,
			commands: child.workbench.commands,
		}, {
			ran: true,
			commands: [{ commandId: 'test.command', args: ['payload'] }],
		});
	});

	test('recreates a crashed iframe when reopening the same worktree', async () => {
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;

		const firstState = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const firstInstanceId = firstState.instances[0].instanceId;
		await crashInstance(
			service,
			browser,
			surface,
			windowId,
			firstInstanceId
		);

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

	test('restores the active state after a successful reload command', async () => {
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;
		const state = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.instances[0].instanceId;
		const child = connectChild(browser, surface, instanceId);
		child.workbench.runCommandResult = true;

		await service.reloadWorkspace(windowId);
		const reloaded = await waitForInstanceState(
			service,
			windowId,
			instanceId,
			'active'
		);

		assert.strictEqual(reloaded.instances[0].state, 'active');
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
		await crashInstance(service, browser, surface, windowId, instanceId);

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
		const child = connectChild(browser, surface, instanceId);

		assert.strictEqual(
			await service.reopenWorkspaceInNormalWindow(windowId, instanceId),
			true
		);

		const openedUrl = browser.openedUrls.at(-1);
		assert.ok(openedUrl);
		const opened = new URL(openedUrl);
		assert.deepStrictEqual({
			pathname: opened.pathname,
			folder: opened.searchParams.get('folder'),
			hasPayload: opened.searchParams.has('payload'),
			unloads: child.workbench.prepareUnloadCalls,
			instances: (await service.getWindowState(windowId)).instances.length,
		}, {
			pathname: '/workbench',
			folder: '/tmp/hucode-worktree',
			hasPayload: false,
			unloads: 1,
			instances: 0,
		});
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
			type: HucodeOmniWebChildMessageType.Ready,
		}, null);

		assert.deepStrictEqual({
			state: (await service.getWindowState(windowId)).instances[0].state,
			ports: browser.portMessages.length,
		}, {
			state: 'loading',
			ports: 0,
		});
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

	test('unloads retained workbenches without dismissing them', async () => {
		const persistence = new FakePersistence();
		const { service, browser } = createService(
			new FakeBrowserAdapter(),
			persistence
		);
		const opened = await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/scratch').toJSON()
		);
		const workbenchId = opened.retainedWorkbenches?.[0].id;
		assert.ok(workbenchId);

		const beforeUnloadSaves = persistence.saveCalls;
		const unloaded = await service.unloadRetainedWorkbench(
			browser.windowId,
			workbenchId
		);
		assert.deepStrictEqual({
			instances: unloaded.instances.length,
			desiredState: unloaded.retainedWorkbenches?.[0].desiredState,
		}, {
			instances: 0,
			desiredState: 'unloaded',
		});
		assert.strictEqual(persistence.saveCalls, beforeUnloadSaves + 1);

		const beforeDismissSaves = persistence.saveCalls;
		const dismissed = await service.dismissRetainedWorkbench(
			browser.windowId,
			workbenchId
		);
		assert.deepStrictEqual(dismissed.retainedWorkbenches, []);
		assert.deepStrictEqual(persistence.state?.retainedWorkbenches, []);
		assert.strictEqual(persistence.saveCalls, beforeDismissSaves + 1);
	});

	test('generic close persists one coherent retained unload state', async () => {
		const persistence = new FakePersistence();
		const { service, browser } = createService(
			new FakeBrowserAdapter(),
			persistence
		);
		const opened = await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/scratch-close').toJSON()
		);
		const beforeCloseSaves = persistence.saveCalls;

		const closed = await service.closeWorkspace(
			browser.windowId,
			opened.activeInstanceId
		);

		assert.strictEqual(persistence.saveCalls, beforeCloseSaves + 1);
		assert.strictEqual(
			closed.retainedWorkbenches?.[0].desiredState,
			'unloaded'
		);
	});

	test('restores the active retained workbench and keeps others dormant', async () => {
		const persistence = new FakePersistence({
			retainedWorkbenches: [{
				id: 'one',
				folderUri: URI.file('/tmp/one').toJSON(),
				desiredState: 'loaded',
				order: 0,
				lastActiveAt: 10,
			}, {
				id: 'two',
				folderUri: URI.file('/tmp/two').toJSON(),
				desiredState: 'loaded',
				order: 1,
				lastActiveAt: 20,
			}],
			residentWorkspaces: [],
			activeWorktreePath: '/tmp/one',
		});
		const { service, surface, browser } = createService(
			new FakeBrowserAdapter(),
			persistence,
			'active'
		);

		const state = await service.getWindowState(browser.windowId);
		assert.deepStrictEqual(
			state.instances.map(instance => [
				instance.worktreePath,
				instance.state,
			]),
			[['/tmp/one', 'loading'], ['/tmp/two', 'dormant']]
		);
		assert.strictEqual(surface.querySelectorAll('iframe').length, 1);
	});

	test('drops malformed resident persistence entries during startup', async () => {
		const persistence = new FakePersistence({
			retainedWorkbenches: [],
			residentWorkspaces: [{
				projectId: 'invalid',
			} as unknown as IWebHucodeShellPersistedState[
			'residentWorkspaces'
			][number], {
				projectId: 'valid',
				worktreePath: '/tmp/valid',
			}],
			activeWorktreePath: 42 as unknown as string,
		});
		const { service, browser } = createService(
			new FakeBrowserAdapter(),
			persistence,
			'none'
		);

		const state = await service.getWindowState(browser.windowId);
		assert.deepStrictEqual(
			state.instances.map(instance => instance.worktreePath),
			['/tmp/valid']
		);
		assert.strictEqual(state.instances[0].state, 'dormant');
	});

	test('page shutdown preserves the desired restore snapshot', async () => {
		const persistence = new FakePersistence();
		const { service, browser } = createService(
			new FakeBrowserAdapter(),
			persistence
		);
		await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/scratch').toJSON()
		);
		const beforeShutdown = persistence.state;

		await service.shutdownWindowWorkspaces(browser.windowId, 1);

		assert.deepStrictEqual(persistence.state, beforeShutdown);
	});
});

class FakePersistence implements IWebHucodeShellPersistenceAdapter {
	saveCalls = 0;
	constructor(public state?: IWebHucodeShellPersistedState) { }

	load(): IWebHucodeShellPersistedState | undefined {
		return this.state;
	}

	save(state: IWebHucodeShellPersistedState): void {
		this.saveCalls++;
		this.state = structuredClone(state);
	}
}

class FakeHostedWorkbench implements IHucodeOmniWebWorkbenchClient {
	runCommandResult = true;
	openFilesResult = true;
	prepareUnloadResult: boolean | Promise<boolean> = true;
	prepareUnloadCalls = 0;
	readonly commands: {
		readonly commandId: string;
		readonly args: readonly unknown[];
	}[] = [];

	async runCommand(
		commandId: string,
		args: readonly unknown[]
	): Promise<boolean> {
		this.commands.push({ commandId, args });
		return this.runCommandResult;
	}

	async openFiles(_request: INativeOpenFileRequest): Promise<boolean> {
		return this.openFilesResult;
	}

	async prepareUnload(): Promise<boolean> {
		this.prepareUnloadCalls++;
		return this.prepareUnloadResult;
	}
}

interface IPostedPortMessage {
	readonly instanceId: string;
	readonly windowId: number;
	readonly port: MessagePort;
}

class FakeBrowserAdapter implements IWebHucodeShellBrowserAdapter {
	readonly windowId = 1;
	readonly origin = location.origin;
	readonly openedUrls: string[] = [];
	readonly portMessages: IPostedPortMessage[] = [];
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

	createMessageChannel(): MessageChannel {
		return new MessageChannel();
	}

	postPortMessage(
		_iframe: HTMLIFrameElement,
		message: object,
		port: MessagePort
	): void {
		const portMessage = message as {
			readonly instanceId: string;
			readonly windowId: number;
		};
		this.portMessages.push({
			instanceId: portMessage.instanceId,
			windowId: portMessage.windowId,
			port,
		});
	}

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

class ZeroDelayBrowserAdapter extends FakeBrowserAdapter {
	override setTimeout(
		callback: () => void,
		_timeout: number
	): ReturnType<typeof setTimeout> {
		return setTimeout(callback, 0);
	}
}
