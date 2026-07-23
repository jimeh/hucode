/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, raceTimeout } from '../../../base/common/async.js';
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
	FileOperationError,
	FileOperationResult,
} from '../../../platform/files/common/files.js';
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
	createWebHucodeShellFolderAccess,
	getWebHucodeShellFolderResource,
	IWebHucodeShellBrowserAdapter,
	IWebHucodeShellFolderAccess,
	IWebHucodeShellPersistedState,
	IWebHucodeShellPersistenceAdapter,
	WebHucodeShellController,
} from '../../browser/webShellService.js';

suite('WebHucodeShellService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('stats server folders through the remote file-system resource',
		async () => {
			const resources: URI[] = [];
			const access = createWebHucodeShellFolderAccess(
				'server-authority',
				async resource => {
					resources.push(resource);
					return { isDirectory: true };
				}
			);

			assert.strictEqual(await access.exists('/srv/project'), true);
			assert.deepStrictEqual({
				scheme: resources[0].scheme,
				authority: resources[0].authority,
				path: resources[0].path,
			}, {
				scheme: 'vscode-remote',
				authority: 'server-authority',
				path: '/srv/project',
			});
			assert.strictEqual(
				getWebHucodeShellFolderResource('/tmp/local', undefined).scheme,
				'file'
			);
			const windowsPath = 'C:\\Users\\test\\project';
			const windowsResource = getWebHucodeShellFolderResource(
				windowsPath,
				'server-authority'
			);
			assert.deepStrictEqual({
				scheme: windowsResource.scheme,
				authority: windowsResource.authority,
				path: windowsResource.path,
			}, {
				scheme: 'vscode-remote',
				authority: 'server-authority',
				path: URI.file(windowsPath).path,
			});
			assert.strictEqual(await createWebHucodeShellFolderAccess(
				'server-authority',
				async () => ({ isDirectory: false })
			).exists('/srv/file'), false);
			assert.strictEqual(await createWebHucodeShellFolderAccess(
				'server-authority',
				async () => {
					throw new FileOperationError(
						'missing',
						FileOperationResult.FILE_NOT_FOUND
					);
				}
			).exists('/srv/missing'), false);
			await assert.rejects(
				createWebHucodeShellFolderAccess(
					'server-authority',
					async () => { throw new Error('provider unavailable'); }
				).exists('/srv/transient'),
				/provider unavailable/
			);
		}
	);

	function createService(
		browser: FakeBrowserAdapter = new FakeBrowserAdapter(),
		persistence?: IWebHucodeShellPersistenceAdapter,
		restorePolicy: 'active' | 'all' | 'none' = 'active',
		folderAccess?: IWebHucodeShellFolderAccess
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
			restorePolicy,
			folderAccess
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

	test('suspends active project workspace and activates next MRU', async () => {
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;
		const first = await service.openWorkspace(
			windowId,
			'/tmp/suspend-project-one',
			'project-one'
		);
		const firstInstanceId = first.activeInstanceId;
		assert.ok(firstInstanceId);
		connectChild(browser, surface, firstInstanceId);
		const second = await service.openWorkspace(
			windowId,
			'/tmp/suspend-project-two',
			'project-two'
		);
		const secondInstanceId = second.activeInstanceId;
		assert.ok(secondInstanceId);
		const secondChild = connectChild(browser, surface, secondInstanceId);
		const secondIframe = getIframe(surface, secondInstanceId);
		const emitted: IHucodeHostedWorkspaceState[] = [];
		const listener = service.onDidChangeWindowState(change => {
			emitted.push(change.state);
		});

		const suspended = await service.suspendWorkspace(
			windowId,
			secondInstanceId
		);
		listener.dispose();

		assert.deepStrictEqual({
			activePath: suspended.instances.find(instance =>
				instance.instanceId === suspended.activeInstanceId
			)?.worktreePath,
			states: suspended.instances.map(instance => ({
				path: instance.worktreePath,
				state: instance.state,
			})),
			unloads: secondChild.workbench.prepareUnloadCalls,
			oldIframeConnected: secondIframe.isConnected,
		}, {
			activePath: '/tmp/suspend-project-one',
			states: [
				{ path: '/tmp/suspend-project-one', state: 'active' },
				{ path: '/tmp/suspend-project-two', state: 'dormant' },
			],
			unloads: 1,
			oldIframeConnected: false,
		});
		assert.ok(emitted.every(state =>
			state.instances.every(instance => instance.state !== 'unloaded')
		));
	});

	test('suspends loaded retained workbench without unloading its record',
		async () => {
			const { service, surface, browser } = createService();
			const retained = await service.retainAndOpenWorkbench(
				browser.windowId,
				URI.file('/tmp/suspend-retained').toJSON()
			);
			const retainedInstanceId = retained.activeInstanceId;
			assert.ok(retainedInstanceId);
			connectChild(browser, surface, retainedInstanceId);
			const project = await service.openWorkspace(
				browser.windowId,
				'/tmp/suspend-retained-project',
				'project'
			);
			assert.ok(project.activeInstanceId);
			connectChild(browser, surface, project.activeInstanceId);

			const suspended = await service.suspendWorkspace(
				browser.windowId,
				retainedInstanceId
			);

			assert.deepStrictEqual({
				activePath: suspended.instances.find(instance =>
					instance.instanceId === suspended.activeInstanceId
				)?.worktreePath,
				retainedState: suspended.instances.find(instance =>
					instance.worktreePath === '/tmp/suspend-retained'
				)?.state,
				desiredState:
					suspended.retainedWorkbenches?.[0].desiredState,
			}, {
				activePath: '/tmp/suspend-retained-project',
				retainedState: 'dormant',
				desiredState: 'loaded',
			});
		}
	);

	test('preserves active workbench when suspension is vetoed', async () => {
		const { service, surface, browser } = createService();
		const opened = await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/suspend-veto').toJSON()
		);
		const instanceId = opened.activeInstanceId;
		assert.ok(instanceId);
		const child = connectChild(browser, surface, instanceId);
		child.workbench.prepareUnloadResult = false;

		const state = await service.suspendWorkspace(
			browser.windowId,
			instanceId
		);

		assert.deepStrictEqual({
			activeInstanceId: state.activeInstanceId,
			state: state.instances[0].state,
			desiredState: state.retainedWorkbenches?.[0].desiredState,
			iframeConnected: getIframe(surface, instanceId).isConnected,
		}, {
			activeInstanceId: instanceId,
			state: 'active',
			desiredState: 'loaded',
			iframeConnected: true,
		});
	});

	test('ignores unknown, loading, and dormant suspension targets', async () => {
		const { service, surface, browser } = createService();
		const opened = await service.openWorkspace(
			browser.windowId,
			'/tmp/suspend-guards',
			'project'
		);
		const instanceId = opened.activeInstanceId;
		assert.ok(instanceId);
		const emitted: IHucodeHostedWorkspaceState[] = [];
		const listener = service.onDidChangeWindowState(change => {
			emitted.push(change.state);
		});

		await service.suspendWorkspace(browser.windowId, 'unknown-instance');
		const loadingGuard = await service.suspendWorkspace(
			browser.windowId,
			instanceId
		);

		assert.deepStrictEqual(loadingGuard, opened);
		assert.deepStrictEqual(emitted, []);

		const child = connectChild(browser, surface, instanceId);
		const dormantState = await service.suspendWorkspace(
			browser.windowId,
			instanceId
		);
		const dormantInstanceId = dormantState.instances[0].instanceId;
		const emissionsBeforeDormantGuard = emitted.length;

		const guardedState = await service.suspendWorkspace(
			browser.windowId,
			dormantInstanceId
		);
		listener.dispose();

		assert.deepStrictEqual(guardedState, dormantState);
		assert.strictEqual(
			emitted.length,
			emissionsBeforeDormantGuard
		);
		assert.strictEqual(child.workbench.prepareUnloadCalls, 1);
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

	test('ignores delayed focus from a hidden workbench', async () => {
		const { service, surface, browser } = createService();
		const windowId = browser.windowId;
		const first = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree-one',
			'project-one'
		);
		const firstInstanceId = first.instances[0].instanceId;
		markReady(browser, surface, firstInstanceId);

		const second = await service.openWorkspace(
			windowId,
			'/tmp/hucode-worktree-two',
			'project-two'
		);
		const secondInstanceId = second.activeInstanceId;
		assert.ok(secondInstanceId);

		markFocused(browser, surface, firstInstanceId);

		const state = await service.getWindowState(windowId);
		assert.strictEqual(state.activeInstanceId, secondInstanceId);
		assert.strictEqual(
			state.instances.find(instance =>
				instance.instanceId === firstInstanceId
			)?.focused,
			false
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

	test('preserves retained state when unload and dismiss are vetoed', async () => {
		const { service, surface, browser } = createService();
		const opened = await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/scratch-veto').toJSON()
		);
		const instanceId = opened.activeInstanceId;
		const workbenchId = opened.retainedWorkbenches?.[0].id;
		assert.ok(instanceId);
		assert.ok(workbenchId);
		const child = connectChild(browser, surface, instanceId);
		child.workbench.prepareUnloadResult = false;

		const unloaded = await service.unloadRetainedWorkbench(
			browser.windowId,
			workbenchId
		);
		const dismissed = await service.dismissRetainedWorkbench(
			browser.windowId,
			workbenchId
		);

		assert.deepStrictEqual({
			unloadedDesiredState:
				unloaded.retainedWorkbenches?.[0].desiredState,
			dismissedDesiredState:
				dismissed.retainedWorkbenches?.[0].desiredState,
			instanceIds: dismissed.instances.map(instance => instance.instanceId),
			iframeConnected: getIframe(surface, instanceId).isConnected,
			prepareUnloadCalls: child.workbench.prepareUnloadCalls,
		}, {
			unloadedDesiredState: 'loaded',
			dismissedDesiredState: 'loaded',
			instanceIds: [instanceId],
			iframeConnected: true,
			prepareUnloadCalls: 2,
		});
	});

	test('preserves retained state when unload times out', async () => {
		const browser = new ZeroDelayBrowserAdapter();
		const { service, surface } = createService(browser);
		const opened = await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/scratch-timeout').toJSON()
		);
		const instanceId = opened.activeInstanceId;
		const workbenchId = opened.retainedWorkbenches?.[0].id;
		assert.ok(instanceId);
		assert.ok(workbenchId);
		const child = connectChild(browser, surface, instanceId);
		child.workbench.prepareUnloadResult = new Promise<boolean>(() => { });

		const state = await service.unloadRetainedWorkbench(
			browser.windowId,
			workbenchId
		);

		assert.deepStrictEqual({
			desiredState: state.retainedWorkbenches?.[0].desiredState,
			instanceIds: state.instances.map(instance => instance.instanceId),
			iframeConnected: getIframe(surface, instanceId).isConnected,
		}, {
			desiredState: 'loaded',
			instanceIds: [instanceId],
			iframeConnected: true,
		});
	});

	test('persists retained workbench reorder', async () => {
		const persistence = new FakePersistence();
		const { service, browser } = createService(
			new FakeBrowserAdapter(),
			persistence
		);
		await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/scratch-one').toJSON()
		);
		const opened = await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/scratch-two').toJSON()
		);
		const ids = opened.retainedWorkbenches?.map(record => record.id);
		assert.ok(ids);

		await service.reorderRetainedWorkbenches(
			browser.windowId,
			[ids[1], ids[0]]
		);

		assert.deepStrictEqual(
			persistence.state?.retainedWorkbenches.map(record => [
				record.id,
				record.order,
			]),
			[[ids[1], 0], [ids[0], 1]]
		);
	});

	test('persists retained workbench label changes', async () => {
		const persistence = new FakePersistence();
		const { service, browser } = createService(
			new FakeBrowserAdapter(),
			persistence
		);
		const opened = await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/scratch-label').toJSON()
		);
		const workbenchId = opened.retainedWorkbenches?.[0].id;
		assert.ok(workbenchId);
		const beforeRenameSaves = persistence.saveCalls;

		const renamed = await service.setRetainedWorkbenchLabel(
			browser.windowId,
			workbenchId,
			'  Notes  '
		);
		const reset = await service.setRetainedWorkbenchLabel(
			browser.windowId,
			workbenchId,
			undefined
		);

		assert.deepStrictEqual({
			renamed: renamed.retainedWorkbenches?.[0].label,
			reset: reset.retainedWorkbenches?.[0].label,
			persisted: persistence.state?.retainedWorkbenches[0].label,
			saves: persistence.saveCalls - beforeRenameSaves,
		}, {
			renamed: 'Notes',
			reset: undefined,
			persisted: undefined,
			saves: 2,
		});
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

		const unloaded = await service.unloadRetainedWorkbench(
			browser.windowId,
			'two'
		);
		assert.strictEqual(
			unloaded.instances.some(instance =>
				instance.worktreePath === '/tmp/two'
			),
			false
		);
		assert.strictEqual(
			unloaded.retainedWorkbenches?.find(record => record.id === 'two')
				?.desiredState,
			'unloaded'
		);
	});

	test('removes a dormant workbench when its folder becomes missing',
		async () => {
			let folderExists = true;
			const persistence = new FakePersistence({
				retainedWorkbenches: [{
					id: 'dormant',
					folderUri: URI.file('/tmp/dormant').toJSON(),
					desiredState: 'loaded',
					order: 0,
				}],
				residentWorkspaces: [],
			});
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				persistence,
				'none',
				{ exists: async () => folderExists }
			);
			const restored = await service.getWindowState(browser.windowId);
			assert.strictEqual(restored.instances[0].state, 'dormant');
			const beforeOpenSaves = persistence.saveCalls;

			folderExists = false;
			const missing = await service.openWorkspace(
				browser.windowId,
				'/tmp/dormant'
			);

			assert.deepStrictEqual({
				instances: missing.instances,
				folderStatus: missing.retainedWorkbenches?.[0].folderStatus,
				iframes: surface.querySelectorAll('iframe').length,
				saves: persistence.saveCalls - beforeOpenSaves,
			}, {
				instances: [],
				folderStatus: 'missing',
				iframes: 0,
				saves: 1,
			});
		}
	);

	test('coalesces concurrent workbench opens after folder preflight',
		async () => {
			const folderStat = new DeferredPromise<boolean>();
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				undefined,
				'active',
				{ exists: () => folderStat.p }
			);
			const first = service.openWorkspace(
				browser.windowId,
				'/tmp/concurrent'
			);
			const second = service.openWorkspace(
				browser.windowId,
				'/tmp/concurrent'
			);
			await Promise.resolve();

			folderStat.complete(true);
			await Promise.all([first, second]);
			const state = await service.getWindowState(browser.windowId);

			assert.deepStrictEqual({
				instances: state.instances.length,
				iframes: surface.querySelectorAll('iframe').length,
			}, {
				instances: 1,
				iframes: 1,
			});
		}
	);

	test('latest workspace open wins across different folder preflights',
		async () => {
			const alphaStat = new DeferredPromise<boolean>();
			const bravoStat = new DeferredPromise<boolean>();
			const { service, browser } = createService(
				new FakeBrowserAdapter(),
				undefined,
				'active',
				{
					exists: path => path.endsWith('alpha')
						? alphaStat.p
						: bravoStat.p,
				}
			);

			const alpha = service.openWorkspace(
				browser.windowId,
				'/tmp/alpha'
			);
			const bravo = service.openWorkspace(
				browser.windowId,
				'/tmp/bravo'
			);
			bravoStat.complete(true);
			await bravo;
			alphaStat.complete(true);
			await alpha;

			const state = await service.getWindowState(browser.windowId);
			assert.strictEqual(
				state.instances.find(instance =>
					instance.instanceId === state.activeInstanceId
				)?.worktreePath,
				'/tmp/bravo'
			);
			assert.strictEqual(
				state.instances.find(instance =>
					instance.worktreePath === '/tmp/alpha'
				)?.lastActiveAt,
				undefined
			);
			assert.strictEqual(
				state.retainedWorkbenches?.find(record =>
					URI.revive(record.folderUri).fsPath === '/tmp/alpha'
				)?.lastActiveAt,
				undefined
			);
		});

	test('project ownership wins an overlapping arbitrary preflight',
		async () => {
			const projectStat = new DeferredPromise<boolean>();
			const arbitraryStat = new DeferredPromise<boolean>();
			let statCalls = 0;
			const { service, browser } = createService(
				new FakeBrowserAdapter(),
				undefined,
				'active',
				{
					exists: async () => ++statCalls === 1
						? projectStat.p
						: arbitraryStat.p,
				}
			);

			const projectOpen = service.openWorkspace(
				browser.windowId,
				'/tmp/promoted',
				'project'
			);
			await Promise.resolve();
			const arbitraryOpen = service.openWorkspace(
				browser.windowId,
				'/tmp/promoted'
			);
			projectStat.complete(true);
			await projectOpen;
			arbitraryStat.complete(true);
			const state = await arbitraryOpen;

			assert.deepStrictEqual({
				instances: state.instances.map(instance => ({
					projectId: instance.projectId,
					worktreePath: instance.worktreePath,
				})),
				retainedWorkbenches: state.retainedWorkbenches,
			}, {
				instances: [{
					projectId: 'project',
					worktreePath: '/tmp/promoted',
				}],
				retainedWorkbenches: [],
			});
		}
	);

	test('does not unload a workbench reactivated during its handshake',
		async () => {
			const { service, surface, browser } = createService();
			const opened = await service.retainAndOpenWorkbench(
				browser.windowId,
				URI.file('/tmp/reactivated').toJSON()
			);
			const instanceId = opened.activeInstanceId;
			const workbenchId = opened.retainedWorkbenches?.[0].id;
			assert.ok(instanceId);
			assert.ok(workbenchId);
			const child = connectChild(browser, surface, instanceId);
			const unloadReady = new DeferredPromise<boolean>();
			child.workbench.prepareUnloadResult = unloadReady.p;

			const unloading = service.unloadRetainedWorkbench(
				browser.windowId,
				workbenchId
			);
			await Promise.resolve();
			await service.openWorkspace(browser.windowId, '/tmp/reactivated');
			unloadReady.complete(true);
			await unloading;

			const state = await service.getWindowState(browser.windowId);
			assert.deepStrictEqual({
				instanceIds: state.instances.map(instance => instance.instanceId),
				desiredState: state.retainedWorkbenches?.[0].desiredState,
				iframeConnected: getIframe(surface, instanceId).isConnected,
			}, {
				instanceIds: [instanceId],
				desiredState: 'loaded',
				iframeConnected: true,
			});
		});

	test('does not resurrect a workbench dismissed during folder preflight',
		async () => {
			const folderStat = new DeferredPromise<boolean>();
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				undefined,
				'active',
				{ exists: () => folderStat.p }
			);
			const opening = service.openWorkspace(
				browser.windowId,
				'/tmp/dismissed'
			);
			await Promise.resolve();
			const pending = await service.getWindowState(browser.windowId);
			const workbenchId = pending.retainedWorkbenches?.[0].id;
			assert.ok(workbenchId);

			await service.dismissRetainedWorkbench(
				browser.windowId,
				workbenchId
			);
			folderStat.complete(true);
			await opening;

			const state = await service.getWindowState(browser.windowId);
			assert.deepStrictEqual({
				instances: state.instances,
				retained: state.retainedWorkbenches,
				iframes: surface.querySelectorAll('iframe').length,
			}, {
				instances: [],
				retained: [],
				iframes: 0,
			});
		}
	);

	test('does not resurrect a workbench unloaded during folder preflight',
		async () => {
			const folderStat = new DeferredPromise<boolean>();
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				undefined,
				'active',
				{ exists: () => folderStat.p }
			);
			const opening = service.openWorkspace(
				browser.windowId,
				'/tmp/unloaded'
			);
			await Promise.resolve();
			const pending = await service.getWindowState(browser.windowId);
			const workbenchId = pending.retainedWorkbenches?.[0].id;
			assert.ok(workbenchId);

			await service.unloadRetainedWorkbench(
				browser.windowId,
				workbenchId
			);
			folderStat.complete(true);
			await opening;

			const state = await service.getWindowState(browser.windowId);
			assert.deepStrictEqual({
				instances: state.instances,
				desiredState: state.retainedWorkbenches?.[0].desiredState,
				iframes: surface.querySelectorAll('iframe').length,
			}, {
				instances: [],
				desiredState: 'unloaded',
				iframes: 0,
			});
		}
	);

	test('retains missing folders without creating restored iframes', async () => {
		let existsCalls = 0;
		const persistence = new FakePersistence({
			retainedWorkbenches: [{
				id: 'missing',
				folderUri: URI.file('/tmp/missing').toJSON(),
				desiredState: 'loaded',
				order: 0,
			}],
			residentWorkspaces: [],
			activeWorktreePath: '/tmp/missing',
		});
		const { service, surface, browser } = createService(
			new FakeBrowserAdapter(),
			persistence,
			'active',
			{
				exists: async () => {
					existsCalls++;
					return false;
				}
			}
		);

		const state = await service.getWindowState(browser.windowId);
		assert.deepStrictEqual({
			instances: state.instances,
			desiredState: state.retainedWorkbenches?.[0].desiredState,
			folderStatus: state.retainedWorkbenches?.[0].folderStatus,
			iframes: surface.querySelectorAll('iframe').length,
		}, {
			instances: [],
			desiredState: 'unloaded',
			folderStatus: 'missing',
			iframes: 0,
		});

		const restored = createService(
			new FakeBrowserAdapter(),
			persistence,
			'active',
			{
				exists: async () => {
					existsCalls++;
					return false;
				}
			}
		);
		await restored.service.getWindowState(restored.browser.windowId);
		assert.strictEqual(existsCalls, 1);
	});

	test('falls back to an available workbench when active restore is missing',
		async () => {
			const persistence = new FakePersistence({
				retainedWorkbenches: [{
					id: 'missing',
					folderUri: URI.file('/tmp/missing').toJSON(),
					desiredState: 'loaded',
					order: 0,
				}, {
					id: 'available',
					folderUri: URI.file('/tmp/available').toJSON(),
					desiredState: 'loaded',
					order: 1,
					lastActiveAt: 20,
				}],
				residentWorkspaces: [],
				activeWorktreePath: '/tmp/missing',
			});
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				persistence,
				'active',
				{ exists: async path => path === '/tmp/available' }
			);

			const state = await service.getWindowState(browser.windowId);
			assert.deepStrictEqual({
				instances: state.instances.map(instance => [
					instance.worktreePath,
					instance.state,
				]),
				missingStatus: state.retainedWorkbenches?.[0].folderStatus,
				iframes: surface.querySelectorAll('iframe').length,
			}, {
				instances: [['/tmp/available', 'loading']],
				missingStatus: 'missing',
				iframes: 1,
			});
		}
	);

	test('project restore metadata wins retained path overlap', async () => {
		const persistence = new FakePersistence({
			retainedWorkbenches: [{
				id: 'retained-project',
				folderUri: URI.file('/tmp/project').toJSON(),
				desiredState: 'loaded',
				order: 0,
			}],
			residentWorkspaces: [{
				projectId: 'project',
				worktreePath: '/tmp/project',
			}],
			activeWorktreePath: '/tmp/project',
		});
		const { service, surface, browser } = createService(
			new FakeBrowserAdapter(),
			persistence,
			'active',
			{ exists: async () => true }
		);

		const state = await service.getWindowState(browser.windowId);

		assert.strictEqual(state.instances[0].projectId, 'project');
		const instanceId = state.instances[0].instanceId;
		const child = connectChild(browser, surface, instanceId);
		child.workbench.runCommandResult = false;
		await service.reloadWorkspace(browser.windowId);
		const crashed = await waitForInstanceState(
			service,
			browser.windowId,
			instanceId,
			'crashed'
		);
		assert.strictEqual(
			crashed.retainedWorkbenches?.[0].desiredState,
			'unloaded'
		);
	});

	test('rejects an explicit missing folder before iframe creation', async () => {
		const { service, surface, browser } = createService(
			new FakeBrowserAdapter(),
			undefined,
			'active',
			{ exists: async () => false }
		);

		const state = await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/missing').toJSON()
		);
		assert.deepStrictEqual({
			instances: state.instances,
			folderStatus: state.retainedWorkbenches?.[0].folderStatus,
			iframes: surface.querySelectorAll('iframe').length,
		}, {
			instances: [],
			folderStatus: 'missing',
			iframes: 0,
		});
	});

	test('preserves retained restore intent after a transient stat failure',
		async () => {
			const persistence = new FakePersistence({
				retainedWorkbenches: [{
					id: 'scratch',
					folderUri: URI.file('/tmp/scratch').toJSON(),
					desiredState: 'loaded',
					order: 0,
				}],
				residentWorkspaces: [],
				activeWorktreePath: '/tmp/scratch',
			});
			const { service, browser } = createService(
				new FakeBrowserAdapter(),
				persistence,
				'active',
				{ exists: async () => { throw new Error('offline'); } }
			);

			const state = await service.getWindowState(browser.windowId);

			assert.deepStrictEqual({
				instances: state.instances,
				desiredState: state.retainedWorkbenches?.[0].desiredState,
				folderStatus: state.retainedWorkbenches?.[0].folderStatus,
			}, {
				instances: [],
				desiredState: 'loaded',
				folderStatus: undefined,
			});
		}
	);

	test('reuses an available workbench without repeating folder preflight',
		async () => {
			let folderExists = true;
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				undefined,
				'active',
				{ exists: async () => folderExists }
			);
			const opened = await service.retainAndOpenWorkbench(
				browser.windowId,
				URI.file('/tmp/loading').toJSON()
			);
			const instanceId = opened.activeInstanceId;
			assert.ok(instanceId);

			folderExists = false;
			const reused = await service.openWorkspace(
				browser.windowId,
				'/tmp/loading'
			);

			assert.deepStrictEqual({
				instanceIds: reused.instances.map(instance => instance.instanceId),
				folderStatus: reused.retainedWorkbenches?.[0].folderStatus,
				iframes: surface.querySelectorAll('iframe').length,
			}, {
				instanceIds: [instanceId],
				folderStatus: undefined,
				iframes: 1,
			});
		}
	);

	test('persists one complete snapshot after restoring all workbenches',
		async () => {
			const persistence = new FakePersistence({
				retainedWorkbenches: [],
				residentWorkspaces: [{
					projectId: 'one',
					worktreePath: '/tmp/one',
					lastActiveAt: 20,
				}, {
					projectId: 'two',
					worktreePath: '/tmp/two',
					lastActiveAt: 10,
				}],
				activeWorktreePath: '/tmp/one',
			});
			const { service, browser } = createService(
				new FakeBrowserAdapter(),
				persistence,
				'all'
			);

			const state = await service.getWindowState(browser.windowId);
			assert.deepStrictEqual(
				state.instances.map(instance => instance.worktreePath),
				['/tmp/one', '/tmp/two']
			);
			assert.strictEqual(persistence.saveCalls, 1);
			assert.deepStrictEqual(
				persistence.state?.residentWorkspaces.map(
					entry => entry.worktreePath
				),
				['/tmp/one', '/tmp/two']
			);
		}
	);

	test('ignores retained reconciliation for another window', async () => {
		const persistence = new FakePersistence({
			retainedWorkbenches: [{
				id: 'retained',
				folderUri: URI.file('/tmp/promoted').toJSON(),
				desiredState: 'loaded',
				order: 0,
			}],
			residentWorkspaces: [],
		});
		const { service, browser } = createService(
			new FakeBrowserAdapter(),
			persistence,
			'none'
		);

		const state = await service.reconcileRetainedWorkbenches(
			browser.windowId + 1,
			[{
				projectId: 'project',
				folderUri: URI.file('/tmp/promoted').toJSON(),
			}]
		);

		assert.strictEqual(state.retainedWorkbenches?.length, 1);
		assert.strictEqual(state.instances[0].projectId, undefined);
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
		const beforeShutdown = structuredClone(persistence.state);

		await service.shutdownWindowWorkspaces(browser.windowId, 1);

		assert.deepStrictEqual(
			structuredClone(persistence.load()),
			beforeShutdown
		);
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
