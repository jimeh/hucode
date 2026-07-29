/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, raceTimeout } from '../../../base/common/async.js';
import { Event } from '../../../base/common/event.js';
import { basename } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import {
	DisposableStore,
	IDisposable,
	toDisposable,
} from '../../../base/common/lifecycle.js';
import { Client as MessagePortClient } from
	'../../../base/parts/ipc/browser/ipc.mp.js';
import {
	IChannel,
	ProxyChannel,
} from '../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	FileOperationError,
	FileOperationResult,
} from '../../../platform/files/common/files.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { InMemoryStorageService } from
	'../../../platform/storage/common/storage.js';
import { BrowserLifecycleService } from
	'../../../workbench/services/lifecycle/browser/lifecycleService.js';
import { HucodeHostedOmniWebUnloadCoordinator } from
	'../../browser/hostedOmniWebUnload.js';
import {
	HUCODE_OMNI_WEB_SHELL_CHANNEL,
	HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
	HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION,
	HucodeOmniWebChildMessageType,
	IHucodeOmniWebWorkbenchClient,
} from '../../../platform/window/common/hucodeOmniWebMessages.js';
import {
	FOCUS_PROJECT_PANE_COMMAND_ID,
	TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
} from '../../../platform/window/common/hucodeOmniCommandRouting.js';
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
import {
	IHostedWorkspaceContractState,
	IHostedWorkspaceLifecycleContractAdapter,
	registerHostedWorkspaceLifecycleContract,
} from '../common/hostedWorkspaceLifecycleContract.js';
import {
	ADD_PROJECT_COMMAND_ID,
	COLLAPSE_ALL_PROJECTS_COMMAND_ID,
	GO_BACK_WORKTREE_COMMAND_ID,
	GO_FORWARD_WORKTREE_COMMAND_ID,
	REFRESH_PROJECTS_COMMAND_ID,
} from '../../browser/projectSwitcher/projectSwitcherCommon.js';

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
		folderAccess?: IWebHucodeShellFolderAccess,
		logService: RecordingLogService = new RecordingLogService(),
		commandService: {
			executeCommand<T = unknown>(
				commandId: string,
				...args: unknown[]
			): Promise<T>;
		} = { async executeCommand<T>() { return undefined as T; } }
	): {
		readonly service: WebHucodeShellController;
		readonly surface: HTMLElement;
		readonly browser: FakeBrowserAdapter;
		readonly logService: RecordingLogService;
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
			commandService,
			{
				onDidChangeSurface: Event.None,
				getSurface() {
					return surface;
				},
			},
			browser,
			persistence,
			restorePolicy,
			folderAccess,
			logService
		));
		return { service, surface, browser, logService };
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

	/**
	 * `'none'` rather than `undefined` for a workbench that announces no
	 * version: passing `undefined` would silently take the default and
	 * announce the current protocol instead.
	 */
	function markReady(
		browser: FakeBrowserAdapter,
		surface: HTMLElement,
		instanceId: string,
		protocolVersion: number | 'none' =
			HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION
	): void {
		postMessage(browser, surface, instanceId, {
			type: HucodeOmniWebChildMessageType.Ready,
			...(protocolVersion === 'none' ? {} : { protocolVersion }),
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
		readonly shellChannel: IChannel;
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
		const shellChannel = client.getChannel(HUCODE_OMNI_WEB_SHELL_CHANNEL);
		const shell = ProxyChannel.toService<IHucodeShellService>(shellChannel);
		return {
			workbench,
			shell,
			shellChannel,
			shellWindowId: posted.windowId,
		};
	}

	/**
	 * Connects a child built before the unload handshake was split: it
	 * announces no protocol version and its `prepareUnload` is the whole
	 * shutdown, with no commit phase to call.
	 */
	function connectLegacyChild(
		browser: FakeBrowserAdapter,
		surface: HTMLElement,
		instanceId: string
	): { readonly workbench: LegacyHostedWorkbench } {
		markReady(browser, surface, instanceId, 'none');

		const posted = browser.portMessages.at(-1);
		assert.ok(posted, 'expected a transferred shell port');
		const client = disposables.add(new MessagePortClient(
			posted.port,
			`test-legacy-child-${instanceId}`
		));
		const workbench = new LegacyHostedWorkbench();
		client.registerChannel(
			HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
			ProxyChannel.fromService(
				workbench,
				disposables.add(new DisposableStore())
			)
		);
		return { workbench };
	}

	interface IChildLifecycleEvents {
		beforeShutdown: number;
		willShutdown: number;
		didShutdown: number;
	}

	interface ILifecycleBackedChild {
		readonly workbench: LifecycleBackedHostedWorkbench;
		readonly lifecycleService: BrowserLifecycleService;
		readonly events: IChildLifecycleEvents;
		readonly shellWindowId: number;
	}

	/**
	 * Connects a hosted child whose unload handshake runs the production
	 * coordinator against a real lifecycle service, so vetoes and shutdowns
	 * are produced rather than stubbed.
	 */
	function connectLifecycleBackedChild(
		browser: FakeBrowserAdapter,
		surface: HTMLElement,
		instanceId: string
	): ILifecycleBackedChild {
		markReady(browser, surface, instanceId);

		const posted = browser.portMessages.at(-1);
		assert.ok(posted, 'expected a transferred shell port');
		assert.strictEqual(posted.instanceId, instanceId);

		const client = disposables.add(new MessagePortClient(
			posted.port,
			`test-child-${instanceId}`
		));
		const storageService = disposables.add(new InMemoryStorageService());
		const lifecycleService = disposables.add(new BrowserLifecycleService(
			new NullLogService(),
			storageService
		));
		const events: IChildLifecycleEvents = {
			beforeShutdown: 0,
			willShutdown: 0,
			didShutdown: 0,
		};
		disposables.add(lifecycleService.onBeforeShutdown(() => {
			events.beforeShutdown++;
		}));
		disposables.add(lifecycleService.onWillShutdown(() => {
			events.willShutdown++;
		}));
		disposables.add(lifecycleService.onDidShutdown(() => {
			events.didShutdown++;
		}));
		const workbench = new LifecycleBackedHostedWorkbench(lifecycleService);
		client.registerChannel(
			HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
			ProxyChannel.fromService(
				workbench,
				disposables.add(new DisposableStore())
			)
		);
		return {
			workbench,
			lifecycleService,
			events,
			shellWindowId: posted.windowId,
		};
	}

	/**
	 * Waits for something that must happen, bounded so that a failure shows
	 * up as a failed assertion instead of a hung test.
	 */
	async function waitFor(
		predicate: () => boolean | Promise<boolean>,
		message: string
	): Promise<void> {
		for (let attempt = 0; attempt < 200 && !await predicate(); attempt++) {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
		assert.ok(await predicate(), message);
	}

	/**
	 * Gives MessagePort requests a bounded number of event-loop turns to
	 * arrive without making elapsed wall-clock time part of the assertion.
	 */
	async function observeWithinTurns(
		predicate: () => boolean,
		turns: number = 20
	): Promise<boolean> {
		for (let attempt = 0; attempt < turns && !predicate(); attempt++) {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
		return predicate();
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

	function findIframe(
		surface: HTMLElement,
		instanceId: string
	): HTMLIFrameElement | null {
		return surface.querySelector<HTMLIFrameElement>(
			`[data-hucode-hosted-instance-id="${instanceId}"]`
		);
	}

	function getIframe(
		surface: HTMLElement,
		instanceId: string
	): HTMLIFrameElement {
		const iframe = findIframe(surface, instanceId);
		assert.ok(iframe);
		return iframe;
	}

	/** Whether the hosted iframe is still attached to the shell surface. */
	function isIframeConnected(
		surface: HTMLElement,
		instanceId: string
	): boolean {
		return findIframe(surface, instanceId)?.isConnected === true;
	}

	function createLifecycleContractAdapter():
		IHostedWorkspaceLifecycleContractAdapter {
		const normalizeState = (
			state: IHucodeHostedWorkspaceState
		): IHostedWorkspaceContractState => {
			const active = state.instances.find(instance =>
				instance.instanceId === state.activeInstanceId
			);
			return {
				activePath: active && basename(active.worktreePath),
				instances: state.instances.map(instance => ({
					path: basename(instance.worktreePath),
					state: instance.state,
				})),
				retainedDesiredState:
					state.retainedWorkbenches?.[0]?.desiredState,
			};
		};
		const toContractState = async (
			service: WebHucodeShellController,
			browser: FakeBrowserAdapter
		): Promise<IHostedWorkspaceContractState> =>
			normalizeState(await service.getWindowState(browser.windowId));
		const readyChild = async (
			harness: ReturnType<typeof createService>,
			instanceId: string,
			expectedState: 'active' | 'loaded' = 'active'
		): Promise<FakeHostedWorkbench> => {
			const child = connectChild(
				harness.browser,
				harness.surface,
				instanceId
			);
			await waitForInstanceState(
				harness.service,
				harness.browser.windowId,
				instanceId,
				expectedState
			);
			return child.workbench;
		};

		return {
			async generationGuard() {
				const harness = createService();
				const alphaState = await harness.service.openWorkspace(
					harness.browser.windowId,
					'/tmp/alpha',
					'project-alpha'
				);
				const alphaId = alphaState.activeInstanceId;
				assert.ok(alphaId);
				const alphaChild = await readyChild(harness, alphaId);
				const betaState = await harness.service.openWorkspace(
					harness.browser.windowId,
					'/tmp/beta',
					'project-beta'
				);
				const betaId = betaState.activeInstanceId;
				assert.ok(betaId);
				await readyChild(harness, betaId);

				const prepareStarted = new DeferredPromise<void>();
				const prepareGate = new DeferredPromise<void>();
				alphaChild.onPrepareUnload = () => {
					if (!prepareStarted.isSettled) {
						void prepareStarted.complete();
					}
				};
				alphaChild.prepareUnloadResult =
					prepareGate.p.then(() => true);
				const closing = harness.service.closeWorkspace(
					harness.browser.windowId,
					alphaId
				);
				await prepareStarted.p;
				await harness.service.openWorkspace(
					harness.browser.windowId,
					'/tmp/alpha',
					'project-alpha'
				);
				await prepareGate.complete();
				await closing;

				return {
					state: await toContractState(
						harness.service,
						harness.browser
					),
					commitCount: alphaChild.commitUnloadCalls,
				};
			},
			async coherentRetainedClose() {
				const persistence = new FakePersistence();
				const harness = createService(
					new FakeBrowserAdapter(),
					persistence
				);
				const opened = await harness.service.retainAndOpenWorkbench(
					harness.browser.windowId,
					URI.file('/tmp/scratch').toJSON()
				);
				const instanceId = opened.activeInstanceId;
				assert.ok(instanceId);
				await readyChild(harness, instanceId);
				let emissionCount = 0;
				let emittedState: IHostedWorkspaceContractState | undefined;
				disposables.add(harness.service.onDidChangeWindowState(change => {
					emissionCount++;
					emittedState = normalizeState(change.state);
				}));

				await harness.service.closeWorkspace(
					harness.browser.windowId,
					instanceId
				);

				return {
					state: await toContractState(
						harness.service,
						harness.browser
					),
					emittedState,
					emissionCount,
				};
			},
			async restoreActiveOnly() {
				const persistence = new FakePersistence({
					retainedWorkbenches: [],
					residentWorkspaces: [{
						projectId: 'project-alpha',
						worktreePath: '/tmp/alpha',
						lastActiveAt: 20,
					}, {
						projectId: 'project-beta',
						worktreePath: '/tmp/beta',
						lastActiveAt: 10,
					}],
					activeWorktreePath: '/tmp/alpha',
				});
				const harness = createService(
					new FakeBrowserAdapter(),
					persistence,
					'active',
					{ exists: async () => true }
				);
				const beforeReady = await toContractState(
					harness.service,
					harness.browser
				);
				const state = await harness.service.getWindowState(
					harness.browser.windowId
				);
				const alpha = state.instances.find(instance =>
					instance.worktreePath === '/tmp/alpha'
				);
				assert.ok(alpha);
				await readyChild(harness, alpha.instanceId);

				return {
					beforeReady,
					afterReady: await toContractState(
						harness.service,
						harness.browser
					),
					createdHosts:
						harness.surface.querySelectorAll('iframe').length,
				};
			},
			async closeActiveAndPromoteNext() {
				const persistence = new FakePersistence({
					retainedWorkbenches: [],
					residentWorkspaces: [{
						projectId: 'project-alpha',
						worktreePath: '/tmp/alpha',
						lastActiveAt: 100,
					}, {
						projectId: 'project-beta',
						worktreePath: '/tmp/beta',
						lastActiveAt: 300,
					}, {
						projectId: 'project-gamma',
						worktreePath: '/tmp/gamma',
						lastActiveAt: 200,
					}],
					activeWorktreePath: '/tmp/gamma',
				});
				const harness = createService(
					new FakeBrowserAdapter(),
					persistence,
					'all',
					{ exists: async () => true }
				);
				const state = await harness.service.getWindowState(
					harness.browser.windowId
				);
				const gamma = state.instances.find(instance =>
					instance.worktreePath === '/tmp/gamma'
				);
				assert.ok(gamma);
				const children = new Map<string, FakeHostedWorkbench>();
				for (const instance of state.instances) {
					children.set(instance.worktreePath, await readyChild(
						harness,
						instance.instanceId,
						instance.instanceId === gamma.instanceId
							? 'active'
							: 'loaded'
					));
				}
				const gammaChild = children.get('/tmp/gamma');
				assert.ok(gammaChild);

				await harness.service.closeWorkspace(
					harness.browser.windowId,
					gamma.instanceId
				);

				return {
					state: await toContractState(
						harness.service,
						harness.browser
					),
					unloadPhases: gammaChild.unloadPhases,
				};
			},
			async vetoThenShutdown() {
				const persistence = new FakePersistence();
				const harness = createService(
					new FakeBrowserAdapter(),
					persistence
				);
				const opened = await harness.service.openWorkspace(
					harness.browser.windowId,
					'/tmp/alpha',
					'project-alpha'
				);
				const instanceId = opened.activeInstanceId;
				assert.ok(instanceId);
				const child = await readyChild(harness, instanceId);
				child.prepareUnloadResult = false;

				await harness.service.closeWorkspace(
					harness.browser.windowId,
					instanceId
				);
				const closeState = await toContractState(
					harness.service,
					harness.browser
				);
				const closePhases = [...child.unloadPhases];
				const restorePathsBeforeShutdown =
					persistence.state?.residentWorkspaces.map(entry =>
						basename(entry.worktreePath)
					) ?? [];
				child.prepareUnloadResult = true;
				child.unloadPhases.length = 0;

				await harness.service.shutdownWindowWorkspaces(
					harness.browser.windowId,
					1
				);

				return {
					closeState,
					closePhases,
					shutdownState: await toContractState(
						harness.service,
						harness.browser
					),
					shutdownPhases: child.unloadPhases,
					restorePathsBeforeShutdown,
					restorePathsAfterShutdown:
						persistence.state?.residentWorkspaces.map(entry =>
							basename(entry.worktreePath)
						) ?? [],
				};
			},
			async concurrentShutdown() {
				const persistence = new FakePersistence();
				const browser = new ManualTimeoutBrowserAdapter();
				const harness = createService(browser, persistence);
				const children = new Map<string, FakeHostedWorkbench>();
				for (const [path, projectId] of [
					['alpha', 'project-alpha'],
					['bravo', 'project-bravo'],
					['charlie', 'project-charlie'],
				] as const) {
					const opened = await harness.service.openWorkspace(
						browser.windowId,
						`/tmp/${path}`,
						projectId
					);
					const instanceId = opened.activeInstanceId;
					assert.ok(instanceId);
					children.set(path, await readyChild(
						harness,
						instanceId
					));
				}

				const alpha = children.get('alpha');
				const bravo = children.get('bravo');
				const charlie = children.get('charlie');
				assert.ok(alpha);
				assert.ok(bravo);
				assert.ok(charlie);
				const releaseAlphaPreparation =
					new DeferredPromise<boolean>();
				alpha.prepareUnloadResult = releaseAlphaPreparation.p;
				bravo.prepareUnloadResult = false;
				charlie.prepareUnloadResult = new Promise<boolean>(() => { });
				const saveCallsBeforeShutdown = persistence.saveCalls;

				const firstShutdown = harness.service.shutdownWindowWorkspaces(
					browser.windowId,
					1
				);
				const allPreparationsStarted = await observeWithinTurns(
					() => [...children.values()].every(
						child => child.prepareUnloadCalls === 1
					)
				);
				const preparationsStartedBeforeRelease = allPreparationsStarted
					? [...children.keys()]
					: [...children.entries()]
						.filter(([, child]) => child.prepareUnloadCalls === 1)
						.map(([path]) => path);
				let secondCallResolvedBeforeRelease = false;
				void harness.service.shutdownWindowWorkspaces(
					browser.windowId,
					1
				).then(() => {
					secondCallResolvedBeforeRelease = true;
				});
				await Promise.resolve();
				const resolvedBeforeRelease = secondCallResolvedBeforeRelease;

				await releaseAlphaPreparation.complete(true);
				await waitFor(
					() => alpha.commitUnloadCalls === 1,
					'expected the successful workbench to enter commit'
				);
				browser.expireTimeouts(5000);
				await firstShutdown;
				await new Promise<void>(resolve => setTimeout(resolve, 0));
				const secondCallResolvedAfterRelease =
					secondCallResolvedBeforeRelease;

				const shutdownState = await toContractState(
					harness.service,
					browser
				);
				const phasesByPath = Object.fromEntries(
					[...children].map(([path, child]) => [
						path,
						[...child.unloadPhases],
					])
				);
				const persistedPaths = persistence.state?.residentWorkspaces
					.map(entry => basename(entry.worktreePath));
				const persistenceSavesDuringIncompleteShutdown =
					persistence.saveCalls - saveCallsBeforeShutdown;

				bravo.prepareUnloadResult = true;
				charlie.prepareUnloadResult = true;
				bravo.unloadPhases.length = 0;
				charlie.unloadPhases.length = 0;
				await harness.service.shutdownWindowWorkspaces(
					browser.windowId,
					1
				);

				return {
					failurePolicy: 'retain',
					preparationsStartedBeforeRelease,
					secondCallResolvedAfterRelease,
					secondCallResolvedBeforeRelease: resolvedBeforeRelease,
					phasesByPath,
					shutdownState,
					persistenceSavesDuringIncompleteShutdown,
					persistedPaths,
					retryPhasesByPath: {
						bravo: [...bravo.unloadPhases],
						charlie: [...charlie.unloadPhases],
					},
					retryState: await toContractState(
						harness.service,
						browser
					),
				};
			},
		};
	}

	registerHostedWorkspaceLifecycleContract(
		'retain',
		createLifecycleContractAdapter
	);

	test('shutdown does not supersede a slow peer after active removal',
		async () => {
			const persistence = new FakePersistence();
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				persistence
			);
			const alphaState = await service.openWorkspace(
				browser.windowId,
				'/tmp/shutdown-slow-alpha',
				'project-alpha'
			);
			const alphaId = alphaState.activeInstanceId;
			assert.ok(alphaId);
			const alpha = connectChild(browser, surface, alphaId).workbench;
			await waitForInstanceState(
				service,
				browser.windowId,
				alphaId,
				'active'
			);
			const bravoState = await service.openWorkspace(
				browser.windowId,
				'/tmp/shutdown-active-bravo',
				'project-bravo'
			);
			const bravoId = bravoState.activeInstanceId;
			assert.ok(bravoId);
			const bravo = connectChild(browser, surface, bravoId).workbench;
			await waitForInstanceState(
				service,
				browser.windowId,
				bravoId,
				'active'
			);
			const alphaPreparationStarted = new DeferredPromise<void>();
			const releaseAlphaPreparation = new DeferredPromise<boolean>();
			alpha.onPrepareUnload = () => {
				if (!alphaPreparationStarted.isSettled) {
					void alphaPreparationStarted.complete();
				}
			};
			alpha.prepareUnloadResult = releaseAlphaPreparation.p;

			const shutdown = service.shutdownWindowWorkspaces(
				browser.windowId,
				1
			);
			await alphaPreparationStarted.p;
			await waitFor(
				() => bravo.commitUnloadCalls === 1 &&
					!isIframeConnected(surface, bravoId),
				'expected the active workbench to finish first'
			);
			await releaseAlphaPreparation.complete(true);
			await shutdown;

			assert.deepStrictEqual({
				instances: (await service.getWindowState(browser.windowId))
					.instances.length,
				alphaPhases: alpha.unloadPhases,
				bravoPhases: bravo.unloadPhases,
			}, {
				instances: 0,
				alphaPhases: ['prepare', 'commit'],
				bravoPhases: ['prepare', 'commit'],
			});
		}
	);

	test('incomplete shutdown unloads removed retained workbench identity',
		async () => {
			const persistence = new FakePersistence();
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				persistence
			);
			const scratchState = await service.retainAndOpenWorkbench(
				browser.windowId,
				URI.file('/tmp/shutdown-retained-scratch').toJSON()
			);
			const scratchId = scratchState.activeInstanceId;
			const retainedId = scratchState.retainedWorkbenches?.[0].id;
			assert.ok(scratchId);
			assert.ok(retainedId);
			const scratch = connectChild(
				browser,
				surface,
				scratchId
			).workbench;
			await waitForInstanceState(
				service,
				browser.windowId,
				scratchId,
				'active'
			);
			const projectState = await service.openWorkspace(
				browser.windowId,
				'/tmp/shutdown-project-survivor',
				'project-survivor'
			);
			const projectId = projectState.activeInstanceId;
			assert.ok(projectId);
			const project = connectChild(
				browser,
				surface,
				projectId
			).workbench;
			await waitForInstanceState(
				service,
				browser.windowId,
				projectId,
				'active'
			);
			project.prepareUnloadResult = false;
			const savesBeforeShutdown = persistence.saveCalls;
			let emissions = 0;
			disposables.add(service.onDidChangeWindowState(() => emissions++));

			await service.shutdownWindowWorkspaces(browser.windowId, 1);

			const state = await service.getWindowState(browser.windowId);
			assert.deepStrictEqual({
				instancePaths: state.instances.map(instance =>
					instance.worktreePath),
				scratchPhases: scratch.unloadPhases,
				projectPhases: project.unloadPhases,
				retainedState: state.retainedWorkbenches?.find(record =>
					record.id === retainedId
				)?.desiredState,
				persistedRetainedState:
					persistence.state?.retainedWorkbenches.find(record =>
						record.id === retainedId
					)?.desiredState,
				saves: persistence.saveCalls - savesBeforeShutdown,
				emissions,
			}, {
				instancePaths: ['/tmp/shutdown-project-survivor'],
				scratchPhases: ['prepare', 'commit'],
				projectPhases: ['prepare'],
				retainedState: 'unloaded',
				persistedRetainedState: 'unloaded',
				saves: 1,
				emissions: 1,
			});
		}
	);

	test('incomplete shutdown preserves a dormant retained replacement',
		async () => {
			const persistence = new FakePersistence();
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				persistence
			);
			const opened = await service.retainAndOpenWorkbench(
				browser.windowId,
				URI.file('/tmp/shutdown-retained-dormant').toJSON()
			);
			const instanceId = opened.activeInstanceId;
			const retainedId = opened.retainedWorkbenches?.[0].id;
			assert.ok(instanceId);
			assert.ok(retainedId);
			const child = connectChild(
				browser,
				surface,
				instanceId
			).workbench;
			await waitForInstanceState(
				service,
				browser.windowId,
				instanceId,
				'active'
			);
			const preparationStarted = new DeferredPromise<void>();
			const releasePreparation = new DeferredPromise<boolean>();
			child.onPrepareUnload = () => {
				if (!preparationStarted.isSettled) {
					void preparationStarted.complete();
				}
			};
			child.prepareUnloadResult = releasePreparation.p;

			const shutdown = service.shutdownWindowWorkspaces(
				browser.windowId,
				1
			);
			await preparationStarted.p;
			const suspend = service.suspendWorkspace(
				browser.windowId,
				instanceId
			);
			await releasePreparation.complete(true);
			await Promise.all([shutdown, suspend]);

			const state = await service.getWindowState(browser.windowId);
			assert.deepStrictEqual({
				instanceStates: state.instances.map(instance => instance.state),
				retainedState: state.retainedWorkbenches?.find(record =>
					record.id === retainedId
				)?.desiredState,
				persistedRetainedState:
					persistence.state?.retainedWorkbenches.find(record =>
						record.id === retainedId
					)?.desiredState,
			}, {
				instanceStates: ['dormant'],
				retainedState: 'loaded',
				persistedRetainedState: 'loaded',
			});
		}
	);

	test('completed shutdown ignores a stale failed batch result', async () => {
		const persistence = new FakePersistence();
		const { service, surface, browser } = createService(
			new FakeBrowserAdapter(),
			persistence
		);
		const alphaState = await service.openWorkspace(
			browser.windowId,
			'/tmp/shutdown-stale-alpha',
			'project-alpha'
		);
		const alphaId = alphaState.activeInstanceId;
		assert.ok(alphaId);
		const alpha = connectChild(browser, surface, alphaId).workbench;
		await waitForInstanceState(
			service,
			browser.windowId,
			alphaId,
			'active'
		);
		const bravoState = await service.openWorkspace(
			browser.windowId,
			'/tmp/shutdown-stale-bravo',
			'project-bravo'
		);
		const bravoId = bravoState.activeInstanceId;
		assert.ok(bravoId);
		const bravo = connectChild(browser, surface, bravoId).workbench;
		await waitForInstanceState(
			service,
			browser.windowId,
			bravoId,
			'active'
		);
		alpha.prepareUnloadResult = false;
		const bravoPreparationStarted = new DeferredPromise<void>();
		const releaseBravoPreparation = new DeferredPromise<boolean>();
		bravo.onPrepareUnload = () => {
			if (!bravoPreparationStarted.isSettled) {
				void bravoPreparationStarted.complete();
			}
		};
		bravo.prepareUnloadResult = releaseBravoPreparation.p;
		const persistedBeforeShutdown = structuredClone(persistence.state);
		const savesBeforeShutdown = persistence.saveCalls;

		const shutdown = service.shutdownWindowWorkspaces(
			browser.windowId,
			1
		);
		await bravoPreparationStarted.p;
		alpha.prepareUnloadResult = true;
		for (let attempt = 0; attempt < 5; attempt++) {
			await service.closeWorkspace(browser.windowId, alphaId);
			if (!(await service.getWindowState(browser.windowId)).instances
				.some(instance => instance.instanceId === alphaId)
			) {
				break;
			}
			await Promise.resolve();
		}
		assert.strictEqual(
			(await service.getWindowState(browser.windowId)).instances
				.some(instance => instance.instanceId === alphaId),
			false
		);
		await releaseBravoPreparation.complete(true);
		await shutdown;

		assert.strictEqual(
			(await service.getWindowState(browser.windowId)).instances.length,
			0
		);
		assert.strictEqual(persistence.saveCalls, savesBeforeShutdown);
		assert.deepStrictEqual(persistence.state, persistedBeforeShutdown);
	});

	test('recovery save failure leaves shutdown retryable', async () => {
		const persistence = new ThrowOncePersistence();
		const { service, surface, browser } = createService(
			new FakeBrowserAdapter(),
			persistence
		);
		const opened = await service.openWorkspace(
			browser.windowId,
			'/tmp/shutdown-save-retry',
			'project'
		);
		const instanceId = opened.activeInstanceId;
		assert.ok(instanceId);
		const child = connectChild(browser, surface, instanceId).workbench;
		await waitForInstanceState(
			service,
			browser.windowId,
			instanceId,
			'active'
		);
		child.prepareUnloadResult = false;
		persistence.throwNextSave = true;

		await assert.rejects(
			service.shutdownWindowWorkspaces(browser.windowId, 1),
			/recovery save failed/
		);

		child.prepareUnloadResult = true;
		child.unloadPhases.length = 0;
		await service.shutdownWindowWorkspaces(browser.windowId, 1);
		assert.deepStrictEqual({
			instances: (await service.getWindowState(browser.windowId))
				.instances.length,
			phases: child.unloadPhases,
		}, {
			instances: 0,
			phases: ['prepare', 'commit'],
		});
	});

	test('shutdown settles sibling tasks and retries after host removal throws',
		async () => {
			const { service, surface, browser } = createService();
			const alphaState = await service.openWorkspace(
				browser.windowId,
				'/tmp/shutdown-throw-alpha',
				'project-alpha'
			);
			const alphaId = alphaState.activeInstanceId;
			assert.ok(alphaId);
			const alpha = connectChild(browser, surface, alphaId).workbench;
			await waitForInstanceState(
				service,
				browser.windowId,
				alphaId,
				'active'
			);
			const alphaIframe = getIframe(surface, alphaId);
			const removeAlphaIframe = alphaIframe.remove.bind(alphaIframe);
			const bravoState = await service.openWorkspace(
				browser.windowId,
				'/tmp/shutdown-throw-bravo',
				'project-bravo'
			);
			const bravoId = bravoState.activeInstanceId;
			assert.ok(bravoId);
			const bravo = connectChild(browser, surface, bravoId).workbench;
			await waitForInstanceState(
				service,
				browser.windowId,
				bravoId,
				'active'
			);
			alphaIframe.remove = () => {
				throw new Error('host iframe removal failed');
			};

			try {
				await assert.rejects(
					service.shutdownWindowWorkspaces(browser.windowId, 1),
					/host iframe removal failed/
				);
			} finally {
				alphaIframe.remove = removeAlphaIframe;
			}
			assert.deepStrictEqual(bravo.unloadPhases, ['prepare', 'commit']);

			await service.shutdownWindowWorkspaces(browser.windowId, 1);
			assert.deepStrictEqual({
				instances: (await service.getWindowState(browser.windowId))
					.instances.length,
				alphaPhases: alpha.unloadPhases,
			}, {
				instances: 0,
				alphaPhases: ['prepare', 'commit'],
			});
		}
	);

	test('zero-survivor task failure leaves frozen shutdown retryable',
		async () => {
			const persistence = new FakePersistence();
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				persistence
			);
			const opened = await service.retainAndOpenWorkbench(
				browser.windowId,
				URI.file('/tmp/shutdown-zero-survivor-throw').toJSON()
			);
			const instanceId = opened.activeInstanceId;
			assert.ok(instanceId);
			const child = connectChild(
				browser,
				surface,
				instanceId
			).workbench;
			await waitForInstanceState(
				service,
				browser.windowId,
				instanceId,
				'active'
			);
			const preparationStarted = new DeferredPromise<void>();
			const releasePreparation = new DeferredPromise<boolean>();
			child.onPrepareUnload = () => {
				if (!preparationStarted.isSettled) {
					void preparationStarted.complete();
				}
			};
			child.prepareUnloadResult = releasePreparation.p;
			const frozenState = structuredClone(persistence.state);
			const frozenSaveCalls = persistence.saveCalls;
			const internals = service as unknown as {
				readonly hostedWorkspaces: {
					addInstance(instance: unknown): void;
					readonly instancesById: Map<string, {
						readonly pendingUnloadDisposition?: string;
					}>;
				};
			};
			const addInstance =
				internals.hostedWorkspaces.addInstance.bind(
					internals.hostedWorkspaces
				);

			const shutdown = service.shutdownWindowWorkspaces(
				browser.windowId,
				1
			);
			await preparationStarted.p;
			const suspend = service.suspendWorkspace(
				browser.windowId,
				instanceId
			);
			await waitFor(
				() => internals.hostedWorkspaces.instancesById.get(instanceId)
					?.pendingUnloadDisposition === 'suspend',
				'expected suspend to join the shutdown handshake'
			);
			internals.hostedWorkspaces.addInstance = () => {
				throw new Error('dormant replacement failed');
			};
			const shutdownRejected = assert.rejects(
				shutdown,
				/dormant replacement failed/
			);
			const suspendRejected = assert.rejects(
				suspend,
				/dormant replacement failed/
			);
			try {
				await releasePreparation.complete(true);
				await Promise.all([shutdownRejected, suspendRejected]);
			} finally {
				internals.hostedWorkspaces.addInstance = addInstance;
			}

			assert.strictEqual(
				(await service.getWindowState(browser.windowId))
					.instances.length,
				0
			);
			assert.strictEqual(persistence.saveCalls, frozenSaveCalls);
			assert.deepStrictEqual(persistence.state, frozenState);

			await service.shutdownWindowWorkspaces(browser.windowId, 1);
			assert.strictEqual(persistence.saveCalls, frozenSaveCalls);
			assert.deepStrictEqual(persistence.state, frozenState);
		}
	);

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

	test('binds the hosted shell channel to its window and instance', async () => {
		const { service, surface, browser } = createService();
		const firstState = await service.openWorkspace(
			browser.windowId,
			'/tmp/hucode-worktree-one',
			'project'
		);
		const firstInstanceId = firstState.activeInstanceId;
		assert.ok(firstInstanceId);
		const firstChild = connectChild(browser, surface, firstInstanceId);
		const secondState = await service.openWorkspace(
			browser.windowId,
			'/tmp/hucode-worktree-two',
			'project'
		);
		const secondInstanceId = secondState.activeInstanceId;
		assert.ok(secondInstanceId);

		const boundState = await firstChild.shell.getWindowState(999);
		assert.strictEqual(boundState.instances.length, 2);

		await firstChild.shell.closeWorkspace(
			firstChild.shellWindowId,
			secondInstanceId
		);

		const state = await service.getWindowState(browser.windowId);
		assert.deepStrictEqual(
			state.instances.map(instance => instance.instanceId),
			[secondInstanceId]
		);
	});

	test('rejects private methods on the hosted shell channel', async () => {
		const { service, surface, browser } = createService();
		const state = await service.openWorkspace(
			browser.windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.activeInstanceId;
		assert.ok(instanceId);
		const child = connectChild(browser, surface, instanceId);

		await assert.rejects(
			child.shellChannel.call('getState'),
			/Method not found|Unknown channel command|getState/
		);
	});

	test('rejects hosted catalog reconciliation while exposing window state',
		async () => {
			const { service, surface, browser } = createService();
			const state = await service.openWorkspace(
				browser.windowId,
				'/tmp/hucode-worktree'
			);
			const instanceId = state.activeInstanceId;
			assert.ok(instanceId);
			const child = connectChild(browser, surface, instanceId);

			await assert.rejects(
				child.shell
					.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
						999,
						[{
							projectId: 'project',
							folderUris: [
								URI.file('/tmp/hucode-worktree').toJSON(),
							],
						}]
					),
				/Method not found|Unknown channel command|reconcile/
			);
			const available = await child.shell.getWindowState(999);

			assert.deepStrictEqual(
				available.instances.map(instance => instance.instanceId),
				[instanceId]
			);
		});

	test('allows registered shell actions and rejects lookalike commands',
		async () => {
			const commandCalls: string[] = [];
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				undefined,
				'active',
				undefined,
				new RecordingLogService(),
				{
					async executeCommand<T = unknown>(commandId: string) {
						commandCalls.push(commandId);
						return undefined as T;
					},
				}
			);
			const state = await service.openWorkspace(
				browser.windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.activeInstanceId;
			assert.ok(instanceId);
			const child = connectChild(browser, surface, instanceId);

			assert.strictEqual(await child.shell.runActionInShell(999, {
				id: 'hucode.unregistered',
				from: 'menu',
			}), false);
			assert.strictEqual(await child.shell.runActionInShell(999, {
				id: 'hucode.projectSwitcher.dismissWorkbench',
				from: 'menu',
				args: [{ $treeItemHandle: 'workbench:unrelated' }],
			}), false);
			const allowedCommands = [
				FOCUS_PROJECT_PANE_COMMAND_ID,
				TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
				ADD_PROJECT_COMMAND_ID,
				REFRESH_PROJECTS_COMMAND_ID,
				COLLAPSE_ALL_PROJECTS_COMMAND_ID,
				GO_BACK_WORKTREE_COMMAND_ID,
				GO_FORWARD_WORKTREE_COMMAND_ID,
			];
			for (const id of allowedCommands) {
				assert.strictEqual(await child.shell.runActionInShell(999, {
					id,
					from: 'menu',
				}), true);
			}

			assert.deepStrictEqual(commandCalls, allowedCommands);
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

	test('keeps the hosted iframe when unload preparation times out',
		async () => {
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
			child.workbench.prepareUnloadResult = new Promise<boolean>(
				() => { }
			);

			const timedOutState = await service.closeWorkspace(
				windowId,
				instanceId
			);
			assert.deepStrictEqual({
				instanceIds: timedOutState.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				commitCalls: child.workbench.commitUnloadCalls,
			}, {
				instanceIds: [instanceId],
				iframeConnected: true,
				commitCalls: 0,
			});
		});

	test('removes the hosted iframe when the unload commit times out',
		async () => {
			const browser = new CollapsibleTimeoutBrowserAdapter();
			const { service, surface } = createService(browser);
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectLifecycleBackedChild(
				browser,
				surface,
				instanceId
			);
			// Preparation answers normally; only the commit runs out of time.
			child.workbench.onPrepareUnload = () => {
				browser.collapseTimeouts = true;
			};
			const commitGate = new DeferredPromise<void>();
			child.workbench.commitUnloadGate = commitGate.p;

			const timedOutState = await service.closeWorkspace(
				windowId,
				instanceId
			);
			// The workbench was mid-commit when the shell gave up on it.
			// Letting it finish shows what the shell would be wrapping in a
			// live-looking iframe if a commit timeout kept the instance.
			await commitGate.complete();
			const committed = await child.workbench.commitUnloadSettled.p;

			assert.deepStrictEqual({
				instanceIds: timedOutState.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				prepareCalls: child.workbench.prepareUnloadCalls,
				commitCalls: child.workbench.commitUnloadCalls,
				committed,
				didShutdown: child.events.didShutdown,
			}, {
				instanceIds: [],
				iframeConnected: false,
				prepareCalls: 1,
				commitCalls: 1,
				committed: true,
				didShutdown: 1,
			});
		});

	test('keeps the hosted iframe when the workbench refuses the commit',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectChild(browser, surface, instanceId);
			// An answered refusal is not a timeout: the workbench is still
			// running and said so, so the close must not proceed.
			child.workbench.commitUnloadResult = false;

			const refusedState = await service.closeWorkspace(
				windowId,
				instanceId
			);
			assert.deepStrictEqual({
				instanceIds: refusedState.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				prepareCalls: child.workbench.prepareUnloadCalls,
				commitCalls: child.workbench.commitUnloadCalls,
			}, {
				instanceIds: [instanceId],
				iframeConnected: true,
				prepareCalls: 1,
				commitCalls: 1,
			});
		});

	test('removes the hosted iframe when the unload commit connection fails',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectChild(browser, surface, instanceId);
			// A lost reply says nothing about whether the workbench shut
			// down, and the commit is irreversible and already sent.
			child.workbench.commitUnloadRejects = true;

			const closedState = await service.closeWorkspace(
				windowId,
				instanceId
			);
			assert.deepStrictEqual({
				instanceIds: closedState.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				commitCalls: child.workbench.commitUnloadCalls,
			}, {
				instanceIds: [],
				iframeConnected: false,
				commitCalls: 1,
			});
		});

	// Characterization, not regression: this held before the commit phase
	// learned to fail open, and its job is to fail if the two phases are ever
	// made to agree.
	test('keeps the hosted iframe when the unload preparation connection fails',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectChild(browser, surface, instanceId);
			// Nothing is committed yet, so an unknown answer must protect
			// the workbench rather than discard it.
			child.workbench.prepareUnloadRejects = true;

			const keptState = await service.closeWorkspace(
				windowId,
				instanceId
			);
			assert.deepStrictEqual({
				instanceIds: keptState.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				commitCalls: child.workbench.commitUnloadCalls,
			}, {
				instanceIds: [instanceId],
				iframeConnected: true,
				commitCalls: 0,
			});
		});

	test('does not park a dormant record over a live replacement workbench',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const opened = await service.openWorkspace(
				windowId,
				'/tmp/replaced-mid-unload',
				'project'
			);
			const instanceId = opened.instances[0].instanceId;
			const child = connectChild(browser, surface, instanceId);
			const commitGate = new DeferredPromise<boolean>();
			child.workbench.commitUnloadResult = commitGate.p;

			const suspending = service.suspendWorkspace(windowId, instanceId);
			await waitFor(
				() => child.workbench.commitUnloadCalls === 1,
				'expected the unload commit to be in flight'
			);

			// The workbench crashes and is reopened while its commit is
			// still outstanding, so a live replacement owns the path by the
			// time the suspend gets its answer.
			child.workbench.runCommandResult = false;
			await service.reloadWorkspace(windowId);
			await waitFor(
				async () => (await service.getWindowState(windowId)).instances
					.some(entry => entry.instanceId === instanceId &&
						entry.state === 'crashed'),
				'expected the workbench to crash'
			);
			const reopened = await service.openWorkspace(
				windowId,
				'/tmp/replaced-mid-unload',
				'project'
			);
			const replacementId = reopened.activeInstanceId;
			assert.ok(replacementId);
			assert.notStrictEqual(replacementId, instanceId);

			await commitGate.complete(true);
			await suspending;

			const finalState = await service.getWindowState(windowId);
			assert.deepStrictEqual({
				instanceIds: finalState.instances.map(
					instance => instance.instanceId
				),
				replacementConnected: isIframeConnected(surface, replacementId),
				iframes: surface.querySelectorAll('iframe').length,
			}, {
				instanceIds: [replacementId],
				replacementConnected: true,
				iframes: 1,
			});
		});

	test('removes a legacy hosted workbench that has no commit phase',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectLegacyChild(browser, surface, instanceId);

			const closedState = await service.closeWorkspace(
				windowId,
				instanceId
			);
			assert.deepStrictEqual({
				instanceIds: closedState.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				prepareCalls: child.workbench.prepareUnloadCalls,
				shutDown: child.workbench.shutDown,
			}, {
				instanceIds: [],
				iframeConnected: false,
				prepareCalls: 1,
				shutDown: true,
			});
		});

	test('routes current workbenches through distinct prepare and commit calls',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/current-protocol-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectChild(browser, surface, instanceId);

			const closedState = await service.closeWorkspace(
				windowId,
				instanceId
			);

			assert.deepStrictEqual({
				instanceIds: closedState.instances.map(
					instance => instance.instanceId
				),
				legacyPrepareCalls:
					child.workbench.legacyPrepareUnloadCalls,
				prepareForCommitCalls:
					child.workbench.prepareUnloadCalls,
				commitCalls: child.workbench.commitUnloadCalls,
				phases: child.workbench.unloadPhases,
			}, {
				instanceIds: [],
				legacyPrepareCalls: 0,
				prepareForCommitCalls: 1,
				commitCalls: 1,
				phases: ['prepare', 'commit'],
			});
		});

	test('keeps a workbench whose preparation lands after its timeout',
		async () => {
			const browser = new CollapsibleTimeoutBrowserAdapter();
			browser.collapseTimeouts = true;
			const { service, surface, logService } = createService(browser);
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectChild(browser, surface, instanceId);
			const preparation = new DeferredPromise<boolean>();
			child.workbench.prepareUnloadResult = preparation.p;

			const timedOutState = await service.closeWorkspace(
				windowId,
				instanceId
			);
			// The preparation cannot be cancelled, so it lands late having
			// already run the child's shutdown listeners. It must not read
			// as permission to remove a workbench the shell decided to keep.
			await preparation.complete(true);
			await waitFor(
				() => logService.warnings.some(
					warning => warning.includes('after the shell gave up')
				),
				'expected the late preparation to be reported'
			);
			const settledState = await service.getWindowState(windowId);

			assert.deepStrictEqual({
				timedOut: timedOutState.instances.map(
					instance => instance.instanceId
				),
				settled: settledState.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				commitCalls: child.workbench.commitUnloadCalls,
				lateWarnings: logService.warnings.filter(
					warning => warning.includes('after the shell gave up')
				).length,
			}, {
				timedOut: [instanceId],
				settled: [instanceId],
				iframeConnected: true,
				commitCalls: 0,
				lateWarnings: 1,
			});
		});

	test('removes a legacy workbench when its shutdown lands after timeout',
		async () => {
			const browser = new CollapsibleTimeoutBrowserAdapter();
			browser.collapseTimeouts = true;
			const { service, surface } = createService(browser);
			const windowId = browser.windowId;
			const opened = await service.openWorkspace(
				windowId,
				'/tmp/late-legacy-unload',
				'project'
			);
			const instanceId = opened.instances[0].instanceId;
			const child = connectLegacyChild(browser, surface, instanceId);
			const prepareGate = new DeferredPromise<void>();
			child.workbench.prepareUnloadGate = prepareGate.p;

			const timedOutState = await service.closeWorkspace(
				windowId,
				instanceId
			);
			assert.deepStrictEqual(
				timedOutState.instances.map(instance => instance.instanceId),
				[instanceId]
			);

			await prepareGate.complete();
			await waitFor(
				async () => !(await service.getWindowState(windowId))
					.instances.some(instance =>
						instance.instanceId === instanceId
					),
				'expected late legacy shutdown to remove its dead iframe'
			);

			assert.deepStrictEqual({
				instanceIds: (await service.getWindowState(windowId)).instances
					.map(instance => instance.instanceId),
				iframeConnected: isIframeConnected(surface, instanceId),
				shutDown: child.workbench.shutDown,
			}, {
				instanceIds: [],
				iframeConnected: false,
				shutDown: true,
			});
		});

	test('keeps a timed-out legacy close stronger than a later suspend',
		async () => {
			const browser = new CollapsibleTimeoutBrowserAdapter();
			browser.collapseTimeouts = true;
			const { service, surface } = createService(browser);
			const opened = await service.retainAndOpenWorkbench(
				browser.windowId,
				URI.file('/tmp/late-legacy-close-then-suspend').toJSON()
			);
			const instanceId = opened.activeInstanceId;
			assert.ok(instanceId);
			const child = connectLegacyChild(browser, surface, instanceId);
			const prepareGate = new DeferredPromise<void>();
			child.workbench.prepareUnloadGate = prepareGate.p;

			await service.closeWorkspace(browser.windowId, instanceId);
			await service.suspendWorkspace(browser.windowId, instanceId);
			await prepareGate.complete();
			await waitFor(
				async () => !(await service.getWindowState(browser.windowId))
					.instances.some(instance =>
						instance.instanceId === instanceId
					),
				'expected the earlier legacy close disposition to win'
			);
			const settled = await service.getWindowState(browser.windowId);

			assert.deepStrictEqual({
				instanceIds: settled.instances.map(
					instance => instance.instanceId
				),
				desiredState:
					settled.retainedWorkbenches?.[0].desiredState,
				iframeConnected: isIframeConnected(surface, instanceId),
			}, {
				instanceIds: [],
				desiredState: 'unloaded',
				iframeConnected: false,
			});
		});

	test('keeps a reconnected workbench after an old legacy shutdown reply',
		async () => {
			const browser = new ManualTimeoutBrowserAdapter();
			const { service, surface, logService } = createService(browser);
			const windowId = browser.windowId;
			const opened = await service.openWorkspace(
				windowId,
				'/tmp/reconnected-after-legacy-timeout',
				'project'
			);
			const instanceId = opened.instances[0].instanceId;
			const legacyChild = connectLegacyChild(
				browser,
				surface,
				instanceId
			);
			const prepareGate = new DeferredPromise<void>();
			legacyChild.workbench.prepareUnloadGate = prepareGate.p;

			const closing = service.closeWorkspace(windowId, instanceId);
			await legacyChild.workbench.prepareUnloadStarted.p;
			browser.expireTimeouts(5000);
			await closing;

			const reconnectedChild = connectChild(
				browser,
				surface,
				instanceId
			);
			await prepareGate.complete();
			await waitFor(
				() => logService.warnings.some(warning =>
					warning.includes('after the shell gave up')
				),
				'expected old legacy shutdown reply to settle'
			);
			const settledState = await service.getWindowState(windowId);
			browser.expireTimeouts(0);

			assert.deepStrictEqual({
				instanceIds: settledState.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				legacyShutDown: legacyChild.workbench.shutDown,
				reconnectedCommands:
					reconnectedChild.workbench.commands.length,
			}, {
				instanceIds: [instanceId],
				iframeConnected: true,
				legacyShutDown: true,
				reconnectedCommands: 0,
			});
		});

	test('does not leave a dormant record when a close joins a suspend',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const opened = await service.retainAndOpenWorkbench(
				windowId,
				URI.file('/tmp/race-suspend-first').toJSON()
			);
			const instanceId = opened.activeInstanceId;
			assert.ok(instanceId);
			const child = connectLifecycleBackedChild(
				browser,
				surface,
				instanceId
			);
			const prepareGate = new DeferredPromise<void>();
			child.workbench.prepareUnloadGate = prepareGate.p;

			// The suspend owns the handshake and the close joins it, so the
			// weaker request is the one holding the claim.
			const suspending = service.suspendWorkspace(windowId, instanceId);
			await child.workbench.prepareUnloadStarted.p;
			const closing = service.closeWorkspace(windowId, instanceId);
			await prepareGate.complete();
			await Promise.all([suspending, closing]);

			const finalState = await service.getWindowState(windowId);
			assert.deepStrictEqual({
				instanceStates: finalState.instances.map(
					instance => instance.state
				),
				desiredState: finalState.retainedWorkbenches?.[0].desiredState,
				beforeShutdown: child.events.beforeShutdown,
			}, {
				instanceStates: [],
				desiredState: 'unloaded',
				beforeShutdown: 1,
			});
		});

	test('does not leave a dormant record when a suspend joins a dismiss',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const opened = await service.retainAndOpenWorkbench(
				windowId,
				URI.file('/tmp/race-dismiss-first').toJSON()
			);
			const instanceId = opened.activeInstanceId;
			const workbenchId = opened.retainedWorkbenches?.[0].id;
			assert.ok(instanceId);
			assert.ok(workbenchId);
			const child = connectLifecycleBackedChild(
				browser,
				surface,
				instanceId
			);
			const prepareGate = new DeferredPromise<void>();
			child.workbench.prepareUnloadGate = prepareGate.p;

			const dismissing = service.dismissRetainedWorkbench(
				windowId,
				workbenchId
			);
			await child.workbench.prepareUnloadStarted.p;
			const suspending = service.suspendWorkspace(windowId, instanceId);
			await prepareGate.complete();
			await Promise.all([dismissing, suspending]);

			const finalState = await service.getWindowState(windowId);
			assert.deepStrictEqual({
				instanceStates: finalState.instances.map(
					instance => instance.state
				),
				retained: finalState.retainedWorkbenches?.length,
				beforeShutdown: child.events.beforeShutdown,
			}, {
				instanceStates: [],
				retained: 0,
				beforeShutdown: 1,
			});
		});

	test('removes a superseded legacy workbench that already shut itself down',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/legacy-superseded',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectLegacyChild(browser, surface, instanceId);
			const prepareGate = new DeferredPromise<void>();
			child.workbench.prepareUnloadGate = prepareGate.p;

			const closing = service.closeWorkspace(windowId, instanceId);
			await child.workbench.prepareUnloadStarted.p;
			// Reactivating a two-phase workbench here abandons the unload and
			// leaves it running. A workbench of this vintage has already shut
			// down inside its preparation and cannot be brought back, so the
			// same reactivation must not strand its dead iframe.
			await service.openWorkspace(
				windowId,
				'/tmp/legacy-superseded',
				'project'
			);
			await prepareGate.complete();
			await closing;

			const finalState = await service.getWindowState(windowId);
			assert.deepStrictEqual({
				instanceIds: finalState.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				shutDown: child.workbench.shutDown,
			}, {
				instanceIds: [],
				iframeConnected: false,
				shutDown: true,
			});
		});

	test('shares one unload handshake across concurrent close requests',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectLifecycleBackedChild(
				browser,
				surface,
				instanceId
			);
			const prepareGate = new DeferredPromise<void>();
			child.workbench.prepareUnloadGate = prepareGate.p;

			const first = service.closeWorkspace(windowId, instanceId);
			const second = service.closeWorkspace(windowId, instanceId);
			await child.workbench.prepareUnloadStarted.p;
			await prepareGate.complete();
			await Promise.all([first, second]);

			const finalState = await service.getWindowState(windowId);
			assert.deepStrictEqual({
				instances: finalState.instances.length,
				prepareCalls: child.workbench.prepareUnloadCalls,
				commitCalls: child.workbench.commitUnloadCalls,
				beforeShutdown: child.events.beforeShutdown,
				didShutdown: child.events.didShutdown,
			}, {
				instances: 0,
				prepareCalls: 1,
				commitCalls: 1,
				beforeShutdown: 1,
				didShutdown: 1,
			});
		});

	test('does not leave a dormant record for a concurrently closed workbench',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const opened = await service.retainAndOpenWorkbench(
				windowId,
				URI.file('/tmp/race-close-suspend').toJSON()
			);
			const instanceId = opened.activeInstanceId;
			assert.ok(instanceId);
			const child = connectLifecycleBackedChild(
				browser,
				surface,
				instanceId
			);
			const prepareGate = new DeferredPromise<void>();
			child.workbench.prepareUnloadGate = prepareGate.p;

			// The close owns the handshake and the suspend joins it while
			// the workbench is still registered.
			const closing = service.closeWorkspace(windowId, instanceId);
			await child.workbench.prepareUnloadStarted.p;
			const suspending = service.suspendWorkspace(windowId, instanceId);
			await prepareGate.complete();
			await Promise.all([closing, suspending]);

			const finalState = await service.getWindowState(windowId);
			assert.deepStrictEqual({
				instanceStates: finalState.instances.map(
					instance => instance.state
				),
				desiredState: finalState.retainedWorkbenches?.[0].desiredState,
				beforeShutdown: child.events.beforeShutdown,
			}, {
				instanceStates: [],
				desiredState: 'unloaded',
				beforeShutdown: 1,
			});
		});

	test('keeps the hosted workbench when a shutdown listener vetoes',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectLifecycleBackedChild(
				browser,
				surface,
				instanceId
			);
			disposables.add(child.lifecycleService.onBeforeShutdown(event => {
				event.veto(true, 'test.unsavedWorkingCopy');
			}));

			const vetoedState = await service.closeWorkspace(
				windowId,
				instanceId
			);

			assert.deepStrictEqual({
				instanceIds: vetoedState.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				prepareCalls: child.workbench.prepareUnloadCalls,
				commitCalls: child.workbench.commitUnloadCalls,
			}, {
				instanceIds: [instanceId],
				iframeConnected: true,
				prepareCalls: 1,
				commitCalls: 0,
			});
		});

	test('leaves a vetoing hosted workbench running and interactive',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectLifecycleBackedChild(
				browser,
				surface,
				instanceId
			);
			disposables.add(child.lifecycleService.onBeforeShutdown(event => {
				event.veto(true, 'test.unsavedWorkingCopy');
			}));

			await service.closeWorkspace(windowId, instanceId);
			const responded = await service.runActionInWorkspace(windowId, {
				id: 'test.command',
				from: 'menu',
			});

			assert.deepStrictEqual({
				responded,
				willShutdown: child.events.willShutdown,
				didShutdown: child.events.didShutdown,
				lifecycleWillShutdown: child.lifecycleService.willShutdown,
			}, {
				responded: true,
				willShutdown: 0,
				didShutdown: 0,
				lifecycleWillShutdown: false,
			});
		});

	test('does not shut down a workbench reactivated between unload phases',
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
			const child = connectLifecycleBackedChild(
				browser,
				surface,
				instanceId
			);
			const prepareGate = new DeferredPromise<void>();
			child.workbench.prepareUnloadGate = prepareGate.p;

			const unloading = service.unloadRetainedWorkbench(
				browser.windowId,
				workbenchId
			);
			await child.workbench.prepareUnloadStarted.p;
			await service.openWorkspace(browser.windowId, '/tmp/reactivated');
			await prepareGate.complete();
			await unloading;

			const responded = await service.runActionInWorkspace(
				browser.windowId,
				{ id: 'test.command', from: 'menu' }
			);
			const state = await service.getWindowState(browser.windowId);
			assert.deepStrictEqual({
				instanceIds: state.instances.map(
					instance => instance.instanceId
				),
				iframeConnected: isIframeConnected(surface, instanceId),
				commitCalls: child.workbench.commitUnloadCalls,
				willShutdown: child.events.willShutdown,
				responded,
			}, {
				instanceIds: [instanceId],
				iframeConnected: true,
				commitCalls: 0,
				willShutdown: 0,
				responded: true,
			});
		});

	test('does not supersede a prepared unload on routine active iframe focus',
		async () => {
			const { service, surface, browser } = createService();
			const opened = await service.openWorkspace(
				browser.windowId,
				'/tmp/routine-focus',
				'project'
			);
			const instanceId = opened.activeInstanceId;
			assert.ok(instanceId);
			const child = connectChild(browser, surface, instanceId);
			const prepareStarted = new DeferredPromise<void>();
			const releasePreparation = new DeferredPromise<boolean>();
			child.workbench.onPrepareUnload = () => {
				if (!prepareStarted.isSettled) {
					void prepareStarted.complete();
				}
			};
			child.workbench.prepareUnloadResult = releasePreparation.p;

			const closing = service.closeWorkspace(
				browser.windowId,
				instanceId
			);
			await prepareStarted.p;
			markFocused(browser, surface, instanceId);
			await releasePreparation.complete(true);
			await closing;

			const state = await service.getWindowState(browser.windowId);
			assert.deepStrictEqual({
				instanceIds: state.instances.map(instance =>
					instance.instanceId
				),
				commitCalls: child.workbench.commitUnloadCalls,
			}, {
				instanceIds: [],
				commitCalls: 1,
			});
		});

	test('shuts a hosted workbench down exactly once on a successful unload',
		async () => {
			const { service, surface, browser } = createService();
			const windowId = browser.windowId;
			const state = await service.openWorkspace(
				windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.instances[0].instanceId;
			const child = connectLifecycleBackedChild(
				browser,
				surface,
				instanceId
			);

			const closedState = await service.closeWorkspace(
				windowId,
				instanceId
			);

			assert.deepStrictEqual({
				instances: closedState.instances.length,
				prepareCalls: child.workbench.prepareUnloadCalls,
				commitCalls: child.workbench.commitUnloadCalls,
				beforeShutdown: child.events.beforeShutdown,
				willShutdown: child.events.willShutdown,
				didShutdown: child.events.didShutdown,
			}, {
				instances: 0,
				prepareCalls: 1,
				commitCalls: 1,
				beforeShutdown: 1,
				willShutdown: 1,
				didShutdown: 1,
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

	test('does not carry a vetoed close disposition into a later suspend',
		async () => {
			const { service, surface, browser } = createService();
			const opened = await service.retainAndOpenWorkbench(
				browser.windowId,
				URI.file('/tmp/suspend-after-vetoed-close').toJSON()
			);
			const instanceId = opened.activeInstanceId;
			assert.ok(instanceId);
			const child = connectChild(browser, surface, instanceId);
			child.workbench.prepareUnloadResult = false;

			await service.closeWorkspace(browser.windowId, instanceId);
			child.workbench.prepareUnloadResult = true;
			const suspended = await service.suspendWorkspace(
				browser.windowId,
				instanceId
			);

			assert.deepStrictEqual({
				instanceState: suspended.instances.find(instance =>
					instance.worktreePath ===
					'/tmp/suspend-after-vetoed-close'
				)?.state,
				desiredState:
					suspended.retainedWorkbenches?.[0].desiredState,
				iframeConnected: isIframeConnected(surface, instanceId),
			}, {
				instanceState: 'dormant',
				desiredState: 'loaded',
				iframeConnected: false,
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

	test('does not retry clipboard commands after ambiguous delivery timeout',
		async () => {
			const browser = new ManualTimeoutBrowserAdapter();
			const logService = new RecordingLogService();
			const { service, surface } = createService(
				browser,
				undefined,
				'active',
				undefined,
				logService
			);
			const state = await service.openWorkspace(
				browser.windowId,
				'/tmp/hucode-worktree',
				'project'
			);
			const instanceId = state.activeInstanceId;
			assert.ok(instanceId);
			const child = connectChild(browser, surface, instanceId);
			const commandResult = new DeferredPromise<boolean>();
			child.workbench.runCommandResult = commandResult.p;

			const forwarding = service.runActionInWorkspace(browser.windowId, {
				id: 'editor.action.clipboardCutAction',
				from: 'menu',
			});
			await waitFor(
				() => child.workbench.commands.length === 1,
				'expected clipboard command delivery to start'
			);
			browser.expireTimeouts(5000);

			assert.strictEqual(await forwarding, true);
			assert.ok(logService.warnings.some(message =>
				message.includes('delivery is unconfirmed')
			));
			await commandResult.complete(false);
		});

	test('declines clipboard forwarding on definitive failure', async () => {
		const { service, surface, browser } = createService();
		const state = await service.openWorkspace(
			browser.windowId,
			'/tmp/hucode-worktree',
			'project'
		);
		const instanceId = state.activeInstanceId;
		assert.ok(instanceId);
		const child = connectChild(browser, surface, instanceId);
		child.workbench.runCommandResult = false;

		assert.strictEqual(await service.runActionInWorkspace(
			browser.windowId,
			{
				id: 'editor.action.clipboardCopyAction',
				from: 'menu',
			}
		), false);

		child.workbench.runCommandRejects = true;
		assert.strictEqual(await service.runActionInWorkspace(
			browser.windowId,
			{
				id: 'editor.action.clipboardCutAction',
				from: 'menu',
			}
		), false);
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

	test('reconciles a project open after folder preflight against the latest catalog',
		async () => {
			const folderStatStarted = new DeferredPromise<void>();
			const folderStat = new DeferredPromise<boolean>();
			const persistence = new FakePersistence();
			const { service, browser } = createService(
				new FakeBrowserAdapter(),
				persistence,
				'active',
				{
					exists: () => {
						folderStatStarted.complete();
						return folderStat.p;
					},
				}
			);
			const opening = service.openWorkspace(
				browser.windowId,
				'/tmp/project-removed-during-stat',
				'removed-project'
			);
			await folderStatStarted.p;

			await service
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
					browser.windowId,
					[]
				);
			folderStat.complete(true);
			const state = await opening;

			assert.strictEqual(state.instances.length, 1);
			assert.strictEqual(state.instances[0].projectId, undefined);
			assert.strictEqual(state.retainedWorkbenches?.length, 1);
			assert.deepStrictEqual(persistence.state?.residentWorkspaces, []);
			assert.deepStrictEqual(
				persistence.state?.retainedWorkbenches.map(record =>
					URI.revive(record.folderUri).fsPath
				),
				['/tmp/project-removed-during-stat']
			);
		}
	);

	test('focus does not restore ownership removed from the latest catalog',
		async () => {
			const persistence = new FakePersistence({
				retainedWorkbenches: [],
				residentWorkspaces: [{
					projectId: 'removed-project',
					worktreePath: '/tmp/focus-removed-project',
				}],
			});
			const { service, browser } = createService(
				new FakeBrowserAdapter(),
				persistence,
				'none'
			);
			await service.getWindowState(browser.windowId);
			await service
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
					browser.windowId,
					[]
				);

			assert.strictEqual(
				await service.focusHostedWorkspaceByPath(
					'/tmp/focus-removed-project',
					'removed-project'
				),
				true
			);
			const state = await service.getWindowState(browser.windowId);

			assert.strictEqual(state.instances[0].projectId, undefined);
			assert.strictEqual(state.retainedWorkbenches?.length, 1);
			assert.deepStrictEqual(persistence.state?.residentWorkspaces, []);
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

		const state = await service
			.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
				browser.windowId + 1,
				[{
					projectId: 'project',
					folderUris: [URI.file('/tmp/promoted').toJSON()],
				}]
			);

		assert.strictEqual(state.retainedWorkbenches?.length, 1);
		assert.strictEqual(state.instances[0].projectId, undefined);
	});

	test('promotes a live retained workbench and persists project ownership',
		async () => {
			const persistence = new FakePersistence();
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				persistence
			);
			const opened = await service.retainAndOpenWorkbench(
				browser.windowId,
				URI.file('/tmp/promoted-live').toJSON()
			);
			assert.ok(opened.activeInstanceId);
			connectChild(browser, surface, opened.activeInstanceId);
			await service
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
					browser.windowId,
					[]
				);

			const promoted = await service
				.promoteRetainedWorkbenchProjectFolders(
					browser.windowId,
					[{
						projectId: 'project',
						folderUri: URI.file('/tmp/promoted-live').toJSON(),
					}]
				);

			assert.strictEqual(promoted.instances[0].projectId, 'project');
			assert.deepStrictEqual(promoted.retainedWorkbenches, []);
			assert.deepStrictEqual(persistence.state?.retainedWorkbenches, []);
			assert.deepStrictEqual(
				persistence.state?.residentWorkspaces.map(entry => ({
					projectId: entry.projectId,
					worktreePath: entry.worktreePath,
				})),
				[{
					projectId: 'project',
					worktreePath: '/tmp/promoted-live',
				}]
			);

			const suspended = await service.suspendWorkspace(
				browser.windowId,
				opened.activeInstanceId
			);
			assert.strictEqual(suspended.instances[0].state, 'dormant');
			assert.strictEqual(suspended.instances[0].projectId, 'project');
			assert.deepStrictEqual(suspended.retainedWorkbenches, []);

			const reopened = await service.openWorkspace(
				browser.windowId,
				'/tmp/promoted-live',
				'project'
			);
			assert.strictEqual(reopened.instances[0].projectId, 'project');
			assert.deepStrictEqual(reopened.retainedWorkbenches, []);
		}
	);

	test('ignores retained promotion for another window', async () => {
		const persistence = new FakePersistence();
		const { service, browser } = createService(
			new FakeBrowserAdapter(),
			persistence
		);
		const opened = await service.retainAndOpenWorkbench(
			browser.windowId,
			URI.file('/tmp/wrong-window-promotion').toJSON()
		);
		const savesBeforePromotion = persistence.saveCalls;

		const state = await service.promoteRetainedWorkbenchProjectFolders(
			browser.windowId + 1,
			[{
				projectId: 'project',
				folderUri: URI.file('/tmp/wrong-window-promotion').toJSON(),
			}]
		);

		assert.strictEqual(state.instances[0].projectId, undefined);
		assert.deepStrictEqual(
			state.retainedWorkbenches?.map(record => record.id),
			opened.retainedWorkbenches?.map(record => record.id)
		);
		assert.strictEqual(persistence.saveCalls, savesBeforePromotion);
	});

	test('adopts active, loaded, and dormant orphaned project workbenches',
		async () => {
			const persistence = new FakePersistence({
				retainedWorkbenches: [],
				residentWorkspaces: [{
					projectId: 'removed-dormant',
					worktreePath: '/tmp/dormant',
					lastActiveAt: 10,
				}],
			});
			const { service, surface, browser } = createService(
				new FakeBrowserAdapter(),
				persistence,
				'none'
			);
			await service.getWindowState(browser.windowId);

			const alpha = await service.openWorkspace(
				browser.windowId,
				'/tmp/alpha',
				'removed-alpha'
			);
			assert.ok(alpha.activeInstanceId);
			connectChild(browser, surface, alpha.activeInstanceId);
			await waitForInstanceState(
				service,
				browser.windowId,
				alpha.activeInstanceId,
				'active'
			);

			const bravo = await service.openWorkspace(
				browser.windowId,
				'/tmp/bravo',
				'removed-bravo'
			);
			assert.ok(bravo.activeInstanceId);
			connectChild(browser, surface, bravo.activeInstanceId);
			await waitForInstanceState(
				service,
				browser.windowId,
				bravo.activeInstanceId,
				'active'
			);

			const state = await service
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
					browser.windowId,
					[]
				);

			assert.deepStrictEqual(
				state.instances.map(instance => ({
					path: instance.worktreePath,
					state: instance.state,
					projectId: instance.projectId,
				})).toSorted((a, b) => a.path.localeCompare(b.path)),
				[
					{
						path: '/tmp/alpha',
						state: 'loaded',
						projectId: undefined,
					},
					{
						path: '/tmp/bravo',
						state: 'active',
						projectId: undefined,
					},
					{
						path: '/tmp/dormant',
						state: 'dormant',
						projectId: undefined,
					},
				]
			);
			assert.strictEqual(state.retainedWorkbenches?.length, 3);
			assert.deepStrictEqual(persistence.state?.residentWorkspaces, []);
			assert.deepStrictEqual(
				persistence.state?.retainedWorkbenches.map(record =>
					URI.revive(record.folderUri).fsPath
				).toSorted(),
				['/tmp/alpha', '/tmp/bravo', '/tmp/dormant']
			);
		}
	);

	test('adopts a pre-fix project snapshot during initial reconciliation',
		async () => {
			const persistence = new FakePersistence({
				retainedWorkbenches: [],
				residentWorkspaces: [{
					projectId: 'removed-project',
					worktreePath: '/tmp/restored-orphan',
				}],
			});
			const { service, browser } = createService(
				new FakeBrowserAdapter(),
				persistence,
				'none'
			);

			const state = await service
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
					browser.windowId,
					[]
				);

			assert.strictEqual(state.instances.length, 1);
			assert.strictEqual(state.instances[0].state, 'dormant');
			assert.strictEqual(state.instances[0].projectId, undefined);
			assert.deepStrictEqual(persistence.state?.residentWorkspaces, []);
			const persistedRetained =
				persistence.state?.retainedWorkbenches[0];
			assert.ok(persistedRetained);
			assert.strictEqual(
				URI.revive(persistedRetained.folderUri).fsPath,
				'/tmp/restored-orphan'
			);
		}
	);

	test('uses complete project identity and keeps partial promotion safe',
		async () => {
			const persistence = new FakePersistence({
				retainedWorkbenches: [],
				residentWorkspaces: [{
					projectId: 'old-owner',
					worktreePath: '/tmp/readded',
				}, {
					projectId: 'still-live',
					worktreePath: '/tmp/live-without-worktrees',
				}, {
					projectId: 'removed-owner',
					worktreePath: '/tmp/orphan',
				}],
			});
			const { service, browser } = createService(
				new FakeBrowserAdapter(),
				persistence,
				'none'
			);

			const afterPartial = await service
				.promoteRetainedWorkbenchProjectFolders(
					browser.windowId,
					[{
						projectId: 'unrelated',
						folderUri: URI.file('/tmp/unrelated').toJSON(),
					}]
				);
			assert.deepStrictEqual(
				afterPartial.instances.map(instance => instance.projectId),
				['old-owner', 'still-live', 'removed-owner']
			);

			const state = await service
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
					browser.windowId,
					[{
						projectId: 'replacement-owner',
						folderUris: [URI.file('/tmp/readded').toJSON()],
					}, {
						projectId: 'still-live',
						folderUris: [],
					}]
				);

			assert.deepStrictEqual(
				state.instances.map(instance => ({
					path: instance.worktreePath,
					projectId: instance.projectId,
				})).toSorted((a, b) => a.path.localeCompare(b.path)),
				[
					{
						path: '/tmp/live-without-worktrees',
						projectId: 'still-live'
					},
					{ path: '/tmp/orphan', projectId: undefined },
					{
						path: '/tmp/readded',
						projectId: 'replacement-owner'
					},
				]
			);
			assert.deepStrictEqual(
				state.retainedWorkbenches?.map(record =>
					URI.revive(record.folderUri).fsPath
				),
				['/tmp/orphan']
			);
		}
	);

	test('adopts a loading orphan before it becomes ready', async () => {
		const { service, browser } = createService();
		const opened = await service.openWorkspace(
			browser.windowId,
			'/tmp/loading-orphan',
			'removed-owner'
		);
		assert.strictEqual(opened.instances[0].state, 'loading');

		const state = await service
			.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
				browser.windowId,
				[]
			);

		assert.strictEqual(state.instances[0].projectId, undefined);
		const retained = state.retainedWorkbenches?.[0];
		assert.ok(retained);
		assert.strictEqual(
			URI.revive(retained.folderUri).fsPath,
			'/tmp/loading-orphan'
		);
	});

	test('leaves existing retained workbenches out of orphan adoption',
		async () => {
			const persistence = new FakePersistence();
			const { service, browser } = createService(
				new FakeBrowserAdapter(),
				persistence
			);
			await service.retainAndOpenWorkbench(
				browser.windowId,
				URI.file('/tmp/already-retained').toJSON()
			);
			const savesBeforeReconcile = persistence.saveCalls;

			const state = await service
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
					browser.windowId,
					[]
				);

			assert.strictEqual(state.instances[0].projectId, undefined);
			assert.strictEqual(state.retainedWorkbenches?.length, 1);
			assert.strictEqual(persistence.saveCalls, savesBeforeReconcile);
		}
	);

	test('leaves crashed project workbenches out of orphan adoption', async () => {
		const persistence = new FakePersistence();
		const { service, surface, browser } = createService(
			new FakeBrowserAdapter(),
			persistence
		);
		const opened = await service.openWorkspace(
			browser.windowId,
			'/tmp/crashed-orphan',
			'removed-project'
		);
		assert.ok(opened.activeInstanceId);
		await crashInstance(
			service,
			browser,
			surface,
			browser.windowId,
			opened.activeInstanceId
		);
		const savesBeforeReconcile = persistence.saveCalls;

		const state = await service
			.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
				browser.windowId,
				[]
			);

		assert.strictEqual(state.instances[0].state, 'crashed');
		assert.strictEqual(state.instances[0].projectId, 'removed-project');
		assert.deepStrictEqual(state.retainedWorkbenches, []);
		assert.strictEqual(persistence.saveCalls, savesBeforeReconcile);
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

	test('page shutdown cancels a stalled restore before its teardown batch',
		async () => {
			const persistence = new FakePersistence({
				retainedWorkbenches: [],
				residentWorkspaces: [{
					projectId: 'project',
					worktreePath: '/tmp/stalled-restore',
				}],
				activeWorktreePath: '/tmp/stalled-restore',
			});
			const restoreStarted = new DeferredPromise<void>();
			const releaseRestore = new DeferredPromise<boolean>();
			const { service, browser } = createService(
				new FakeBrowserAdapter(),
				persistence,
				'active',
				{
					async exists() {
						if (!restoreStarted.isSettled) {
							await restoreStarted.complete();
						}
						return releaseRestore.p;
					},
				}
			);
			await restoreStarted.p;

			const shutdown = service.shutdownWindowWorkspaces(
				browser.windowId,
				1
			);
			const settledBeforeRestore = await raceTimeout(
				shutdown.then(() => true),
				100
			);
			if (!settledBeforeRestore) {
				await releaseRestore.complete(true);
				await shutdown;
			}
			assert.strictEqual(settledBeforeRestore, true);

			await releaseRestore.complete(true);
			const state = await service.getWindowState(browser.windowId);
			assert.deepStrictEqual(state.instances, []);
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

class ThrowOncePersistence extends FakePersistence {
	throwNextSave = false;

	override save(state: IWebHucodeShellPersistedState): void {
		if (this.throwNextSave) {
			this.throwNextSave = false;
			throw new Error('recovery save failed');
		}
		super.save(state);
	}
}

class FakeHostedWorkbench implements IHucodeOmniWebWorkbenchClient {
	runCommandResult: boolean | Promise<boolean> = true;
	runCommandRejects = false;
	openFilesResult = true;
	prepareUnloadResult: boolean | Promise<boolean> = true;
	prepareUnloadCalls = 0;
	legacyPrepareUnloadCalls = 0;
	prepareUnloadRejects = false;
	onPrepareUnload: (() => void) | undefined;
	commitUnloadResult: boolean | Promise<boolean> = true;
	commitUnloadCalls = 0;
	commitUnloadRejects = false;
	readonly unloadPhases: string[] = [];
	readonly commands: {
		readonly commandId: string;
		readonly args: readonly unknown[];
	}[] = [];

	async runCommand(
		commandId: string,
		args: readonly unknown[]
	): Promise<boolean> {
		this.commands.push({ commandId, args });
		if (this.runCommandRejects) {
			throw new Error('hosted workbench connection lost');
		}
		return this.runCommandResult;
	}

	async openFiles(_request: INativeOpenFileRequest): Promise<boolean> {
		return this.openFilesResult;
	}

	async prepareUnload(): Promise<boolean> {
		this.legacyPrepareUnloadCalls++;
		this.unloadPhases.push('legacy-prepare');
		if (this.prepareUnloadRejects) {
			throw new Error('hosted workbench connection lost');
		}
		return this.prepareUnloadResult;
	}

	async prepareUnloadForCommit(): Promise<boolean> {
		this.prepareUnloadCalls++;
		this.unloadPhases.push('prepare');
		this.onPrepareUnload?.();
		if (this.prepareUnloadRejects) {
			throw new Error('hosted workbench connection lost');
		}
		return this.prepareUnloadResult;
	}

	async commitUnload(): Promise<boolean> {
		this.commitUnloadCalls++;
		this.unloadPhases.push('commit');
		if (this.commitUnloadRejects) {
			throw new Error('hosted workbench connection lost');
		}
		return this.commitUnloadResult;
	}
}

/**
 * Workbench as it existed before the unload handshake was split in two:
 * `prepareUnload` shuts the workbench down and there is no commit phase, so
 * calling one rejects the way any unknown channel command does.
 */
class LegacyHostedWorkbench {
	prepareUnloadCalls = 0;
	shutDown = false;
	prepareUnloadGate: Promise<unknown> | undefined;
	readonly prepareUnloadStarted = new DeferredPromise<void>();

	async runCommand(): Promise<boolean> {
		return !this.shutDown;
	}

	async openFiles(): Promise<boolean> {
		return true;
	}

	async prepareUnload(): Promise<boolean> {
		this.prepareUnloadCalls++;
		if (!this.prepareUnloadStarted.isSettled) {
			await this.prepareUnloadStarted.complete();
		}
		await this.prepareUnloadGate;
		// A workbench of this vintage shuts down inside its preparation:
		// there is no second call and no way back from this point.
		this.shutDown = true;
		return true;
	}
}

/** Records what the shell logged, so lossy paths can be asserted on. */
class RecordingLogService {
	readonly infos: string[] = [];
	readonly warnings: string[] = [];

	info(message: string): void {
		this.infos.push(message);
	}

	warn(message: string): void {
		this.warnings.push(message);
	}
}

/**
 * Hosted workbench that answers the unload handshake through the production
 * coordinator running against a real `BrowserLifecycleService`, so a veto has
 * to come from an actual `onBeforeShutdown` listener and a commit has to be a
 * real lifecycle shutdown.
 */
class LifecycleBackedHostedWorkbench implements IHucodeOmniWebWorkbenchClient {
	prepareUnloadCalls = 0;
	legacyPrepareUnloadCalls = 0;
	commitUnloadCalls = 0;
	prepareUnloadGate: Promise<unknown> | undefined;
	commitUnloadGate: Promise<unknown> | undefined;
	onPrepareUnload: (() => void) | undefined;
	readonly prepareUnloadStarted = new DeferredPromise<void>();
	readonly repeatPrepareUnloadStarted = new DeferredPromise<void>();
	readonly commitUnloadStarted = new DeferredPromise<void>();
	readonly commitUnloadSettled = new DeferredPromise<boolean>();
	readonly commands: {
		readonly commandId: string;
		readonly args: readonly unknown[];
	}[] = [];

	private readonly coordinator: HucodeHostedOmniWebUnloadCoordinator;

	constructor(
		private readonly lifecycleService: BrowserLifecycleService
	) {
		this.coordinator = new HucodeHostedOmniWebUnloadCoordinator(
			lifecycleService,
			new NullLogService()
		);
	}

	async runCommand(
		commandId: string,
		args: readonly unknown[]
	): Promise<boolean> {
		this.commands.push({ commandId, args });
		// A workbench whose lifecycle has shut down can no longer service
		// commands, so this doubles as the "still interactive" answer.
		return !this.lifecycleService.willShutdown;
	}

	async openFiles(_request: INativeOpenFileRequest): Promise<boolean> {
		return true;
	}

	async prepareUnload(): Promise<boolean> {
		this.legacyPrepareUnloadCalls++;
		await this.beginPreparation();
		return this.coordinator.prepareUnload();
	}

	async prepareUnloadForCommit(): Promise<boolean> {
		this.prepareUnloadCalls++;
		this.onPrepareUnload?.();
		await this.beginPreparation();
		return this.coordinator.prepareUnloadForCommit();
	}

	private async beginPreparation(): Promise<void> {
		if (this.prepareUnloadStarted.isSettled) {
			if (!this.repeatPrepareUnloadStarted.isSettled) {
				await this.repeatPrepareUnloadStarted.complete();
			}
		} else {
			await this.prepareUnloadStarted.complete();
		}
		await this.prepareUnloadGate;
	}

	async commitUnload(): Promise<boolean> {
		this.commitUnloadCalls++;
		if (!this.commitUnloadStarted.isSettled) {
			await this.commitUnloadStarted.complete();
		}
		await this.commitUnloadGate;
		const committed = await this.coordinator.commitUnload();
		if (!this.commitUnloadSettled.isSettled) {
			await this.commitUnloadSettled.complete(committed);
		}
		return committed;
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

class ManualTimeoutBrowserAdapter extends FakeBrowserAdapter {
	private nextHandle = 0;
	private readonly timeouts = new Map<
		number,
		{ readonly callback: () => void; readonly timeout: number }
	>();

	override setTimeout(
		callback: () => void,
		timeout: number
	): ReturnType<typeof setTimeout> {
		const handle = ++this.nextHandle;
		this.timeouts.set(handle, { callback, timeout });
		return handle as unknown as ReturnType<typeof setTimeout>;
	}

	override clearTimeout(handle: ReturnType<typeof setTimeout>): void {
		this.timeouts.delete(handle as unknown as number);
	}

	expireTimeouts(timeout: number): void {
		for (const [handle, pending] of [...this.timeouts]) {
			if (pending.timeout === timeout) {
				this.timeouts.delete(handle);
				pending.callback();
			}
		}
	}
}

/**
 * Adapter whose timers can be collapsed to zero part-way through a test, so a
 * later protocol phase times out while the earlier ones complete normally.
 */
class CollapsibleTimeoutBrowserAdapter extends FakeBrowserAdapter {
	collapseTimeouts = false;

	override setTimeout(
		callback: () => void,
		timeout: number
	): ReturnType<typeof setTimeout> {
		return super.setTimeout(callback, this.collapseTimeouts ? 0 : timeout);
	}
}
