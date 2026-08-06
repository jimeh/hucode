/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { DeferredPromise } from '../../../base/common/async.js';
import { basename, join } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IEnvironmentMainService } from '../../../platform/environment/electron-main/environmentMainService.js';
import { IBrowserViewMainService } from '../../../platform/browserView/electron-main/browserViewMainService.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { IIPCObjectUrl, IProtocolMainService } from '../../../platform/protocol/electron-main/protocol.js';
import { IThemeMainService } from '../../../platform/theme/electron-main/themeMainService.js';
import { UnloadReason, ICodeWindow } from '../../../platform/window/electron-main/window.js';
import { INativeWindowConfiguration, IRectangle } from '../../../platform/window/common/window.js';
import {
	ADD_PROJECT_COMMAND_ID,
	COLLAPSE_ALL_PROJECTS_COMMAND_ID,
	GO_BACK_WORKTREE_COMMAND_ID,
	GO_FORWARD_WORKTREE_COMMAND_ID,
	HucodeHostedShellAction,
	REFRESH_PROJECTS_COMMAND_ID,
} from '../../../platform/window/common/hucodeHostedShellActions.js';
import { HucodeHostedShellOperationOutcome } from
	'../../../platform/window/common/hucodeHostedShellService.js';
import {
	FOCUS_PROJECT_PANE_COMMAND_ID,
	TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
} from '../../../platform/window/common/hucodeOmniCommandRouting.js';
import {
	IHostedWorkbenchView,
	IHostedWorkbenchViewFactory,
	IHostedWorkspaceIpcMain,
	isHostedWorkspaceFolderUnavailableError,
	ResidentHostedWorkspacesController,
} from '../../electron-main/hostedWorkspacesController.js';
import {
	IHostedWorkspaceContractState,
	IHostedWorkspaceLifecycleContractAdapter,
	registerHostedWorkspaceLifecycleContract,
} from '../common/hostedWorkspaceLifecycleContract.js';

class RecordingLogService extends NullLogService {
	readonly warnings: string[] = [];

	override warn(message: string, ..._args: unknown[]): void {
		this.warnings.push(message);
	}
}

class TestWebContents extends EventEmitter {
	readonly id: number;
	private destroyed = false;
	private focused = false;
	private processId: number;
	readonly sent: { channel: string; request: unknown }[] = [];
	readonly loadedUrls: string[] = [];
	readonly closeCalls: Electron.CloseOpts[] = [];
	readonly pasteCalls: number[] = [];
	readonly reloadCalls: number[] = [];
	readonly devToolsCalls: number[] = [];
	readonly invalidateCalls: number[] = [];
	loadUrlError: Error | undefined = undefined;
	loadUrlPromise: Promise<void> | undefined;
	autoBeforeUnloadReply = true;
	autoPreparationRollbackReply = true;
	sendHook: ((channel: string, request: unknown) => boolean) | undefined;
	closeHook: (() => void) | undefined;
	deferDestroyedEvent = false;

	constructor(
		id: number,
		private readonly ipcMain: TestHostedWorkspaceIpcMain
	) {
		super();
		this.id = id;
		this.processId = id + 1000;
	}

	getProcessId(): number {
		return this.processId;
	}

	setProcessId(processId: number): void {
		this.processId = processId;
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	isFocused(): boolean {
		return this.focused;
	}

	getZoomFactor(): number {
		return 1;
	}

	focus(): void {
		this.focused = true;
		this.emit('focus');
	}

	blur(): void {
		this.focused = false;
		this.emit('blur');
	}

	async loadURL(url: string): Promise<void> {
		this.loadedUrls.push(url);
		await this.loadUrlPromise;
		if (this.loadUrlError) {
			throw this.loadUrlError;
		}
	}

	send(channel: string, request: unknown): void {
		this.sent.push({ channel, request });
		if (this.sendHook?.(channel, request)) {
			return;
		}
		if (channel === 'vscode:onBeforeUnload' && this.autoBeforeUnloadReply) {
			const { okChannel } = request as { okChannel: string };
			setTimeout(() => this.ipcMain.emitReply(okChannel), 0);
		}
		if (channel === 'vscode:onWillUnload') {
			const { replyChannel } = request as { replyChannel: string };
			setTimeout(() => this.ipcMain.emitReply(replyChannel), 0);
		}
		if (
			channel === 'vscode:onShutdownPreparationAbandoned' &&
			this.autoPreparationRollbackReply
		) {
			const { preparationId, replyChannel } = request as {
				preparationId: string;
				replyChannel?: string;
			};
			if (replyChannel) {
				setTimeout(() => this.ipcMain.emitReply(replyChannel, {
					preparationId,
					disposition: 'applied',
				}), 0);
			}
		}
	}

	close(options: Electron.CloseOpts): void {
		this.closeCalls.push(options);
		this.closeHook?.();
		this.destroyed = true;
		if (this.deferDestroyedEvent) {
			setTimeout(() => this.emit('destroyed'), 0);
		} else {
			this.emit('destroyed');
		}
	}

	reload(): void {
		this.reloadCalls.push(Date.now());
	}

	toggleDevTools(): void {
		this.devToolsCalls.push(Date.now());
	}

	invalidate(): void {
		this.invalidateCalls.push(Date.now());
	}

	paste(): void {
		this.pasteCalls.push(Date.now());
	}

	async capturePage(): Promise<{ toJPEG(quality: number): Buffer }> {
		return { toJPEG: () => Buffer.from('test') };
	}

	asElectronWebContents(): Electron.WebContents {
		return this as unknown as Electron.WebContents;
	}
}

class TestHostedWorkspaceIpcMain extends EventEmitter
	implements IHostedWorkspaceIpcMain {
	private onceRegistrationFailure: Error | undefined;

	override once(
		channel: string,
		listener: (event: Electron.IpcMainEvent, ...args: unknown[]) => void
	): this {
		if (this.onceRegistrationFailure) {
			const failure = this.onceRegistrationFailure;
			this.onceRegistrationFailure = undefined;
			throw failure;
		}
		super.once(channel, listener);
		return this;
	}

	override removeListener(
		channel: string,
		listener: (event: Electron.IpcMainEvent, ...args: unknown[]) => void
	): this {
		super.removeListener(channel, listener);
		return this;
	}

	emitReply(channel: string, ...args: unknown[]): void {
		this.emit(
			channel,
			{ senderFrame: undefined } as unknown as Electron.IpcMainEvent,
			...args
		);
	}

	failNextOnceRegistration(error: Error): void {
		this.onceRegistrationFailure = error;
	}
}

class TestHostedWorkbenchView {
	readonly webContents: Electron.WebContents;
	readonly rawWebContents: TestWebContents;
	readonly visibleCalls: boolean[] = [];
	readonly boundsCalls: IRectangle[] = [];
	readonly backgroundColors: string[] = [];
	blurWhenHidden = false;

	constructor(webContents: TestWebContents) {
		this.rawWebContents = webContents;
		this.webContents = webContents.asElectronWebContents();
	}

	setBackgroundColor(color: string): void {
		this.backgroundColors.push(color);
	}

	setBounds(bounds: IRectangle): void {
		this.boundsCalls.push(bounds);
	}

	setVisible(visible: boolean): void {
		this.visibleCalls.push(visible);
		if (!visible && this.blurWhenHidden &&
			this.rawWebContents.isFocused()) {
			this.rawWebContents.blur();
		}
	}
}

class TestHostedWorkbenchViewFactory implements IHostedWorkbenchViewFactory {
	readonly views: TestHostedWorkbenchView[] = [];
	private nextWebContentsId = 1;

	constructor(
		private readonly ipcMain: TestHostedWorkspaceIpcMain,
		private readonly loadUrlErrors: Error[] = [],
		private readonly loadUrlPromises: Promise<void>[] = [],
		private readonly deferDestroyedEvents: boolean[] = []
	) { }

	createView(): IHostedWorkbenchView {
		const view = new TestHostedWorkbenchView(
			new TestWebContents(this.nextWebContentsId++, this.ipcMain)
		);
		view.rawWebContents.loadUrlError = this.loadUrlErrors.shift();
		view.rawWebContents.loadUrlPromise = this.loadUrlPromises.shift();
		view.rawWebContents.deferDestroyedEvent =
			this.deferDestroyedEvents.shift() ?? false;
		this.views.push(view);
		return view as unknown as IHostedWorkbenchView;
	}
}

class TestIPCObjectUrl<T> implements IIPCObjectUrl<T> {
	readonly resource = URI.parse('vscode-file://test/window-config');
	value: T | undefined;
	disposed = false;
	disposeCalls = 0;
	private disposeFailure: Error | undefined;

	update(obj: T): void {
		this.value = obj;
	}

	dispose(): void {
		this.disposeCalls++;
		if (this.disposeFailure) {
			const failure = this.disposeFailure;
			this.disposeFailure = undefined;
			throw failure;
		}
		this.disposed = true;
	}

	failNextDispose(error: Error): void {
		this.disposeFailure = error;
	}
}

class TestProtocolMainService implements IProtocolMainService {
	declare readonly _serviceBrand: undefined;

	readonly objectUrls: TestIPCObjectUrl<unknown>[] = [];

	createIPCObjectUrl<T>(): IIPCObjectUrl<T> {
		const objectUrl = new TestIPCObjectUrl<T>();
		this.objectUrls.push(objectUrl as TestIPCObjectUrl<unknown>);
		return objectUrl;
	}

	addValidFileRoot() {
		return { dispose() { } };
	}
}

class TestBrowserWindow extends EventEmitter {
	readonly webContents = new TestWebContents(
		900,
		new TestHostedWorkspaceIpcMain()
	).asElectronWebContents();
	readonly contentView = {
		children: [] as IHostedWorkbenchView[],
		added: [] as IHostedWorkbenchView[],
		removed: [] as IHostedWorkbenchView[],
		addChildView: (view: IHostedWorkbenchView) => {
			this.contentView.children = this.contentView.children
				.filter(child => child !== view);
			this.contentView.children.push(view);
			this.contentView.added.push(view);
		},
		removeChildView: (view: IHostedWorkbenchView) => {
			this.contentView.children = this.contentView.children
				.filter(child => child !== view);
			this.contentView.removed.push(view);
		},
	};

	getContentBounds(): Electron.Rectangle {
		return { x: 0, y: 0, width: 1200, height: 800 };
	}

	getZoomFactor(): number {
		return 1;
	}
}

class TestBrowserViewMainService {
	readonly visibleCalls: { id: number; visible: boolean }[] = [];
	readonly frontCalls: number[] = [];
	readonly destroyHostedWebContentsAttempts: number[] = [];
	readonly destroyedHostedWebContentsIds: number[] = [];
	private readonly destroyHostedWebContentsFailures =
		new Map<number, Error>();

	setHostedWebContentsVisible(id: number, visible: boolean): void {
		this.visibleCalls.push({ id, visible });
	}

	bringHostedBrowserViewsToFront(id: number): void {
		this.frontCalls.push(id);
	}

	destroyBrowserViewsForHostedWebContents(id: number): void {
		this.destroyHostedWebContentsAttempts.push(id);
		const failure = this.destroyHostedWebContentsFailures.get(id);
		if (failure) {
			this.destroyHostedWebContentsFailures.delete(id);
			throw failure;
		}
		this.destroyedHostedWebContentsIds.push(id);
	}

	failNextDestroyHostedWebContents(id: number, error: Error): void {
		this.destroyHostedWebContentsFailures.set(id, error);
	}
}

suite('ResidentHostedWorkspacesController', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let tempRoot: string;
	let now: number;

	setup(() => {
		tempRoot = join(tmpdir(), `hucode-hosted-workspaces-${Date.now()}`);
		mkdirSync(tempRoot, { recursive: true });
		now = 1000;
	});

	teardown(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	function createWorktree(name: string): string {
		const worktreePath = join(tempRoot, name);
		mkdirSync(worktreePath, { recursive: true });
		return worktreePath;
	}

	function createController(options: {
		readonly restoreEntries?: INativeWindowConfiguration['omniResidentWorkspaces'];
		readonly retainedWorkbenches?: INativeWindowConfiguration['omniRetainedWorkbenches'];
		readonly activeWorktreePath?: string;
		readonly ids?: string[];
		readonly ipcMain?: TestHostedWorkspaceIpcMain;
		readonly loadUrlErrors?: Error[];
		readonly loadUrlPromises?: Promise<void>[];
		readonly deferDestroyedEvents?: boolean[];
		readonly beforeUnloadTimeoutMs?: number;
		readonly readyTimeoutMs?: number;
		readonly restorePolicy?: 'active' | 'all' | 'none';
		readonly willUnloadTimeoutMs?: number;
		readonly windowId?: number;
		readonly hostedWindowPaths?: readonly string[];
		readonly hostedWindowFocusOutcome?: HucodeHostedShellOperationOutcome;
		readonly normalWindowPaths?: readonly string[];
	} = {}) {
		const protocolMainService = new TestProtocolMainService();
		const ipcMain = options.ipcMain ?? new TestHostedWorkspaceIpcMain();
		const viewFactory = new TestHostedWorkbenchViewFactory(
			ipcMain,
			[...(options.loadUrlErrors ?? [])],
			[...(options.loadUrlPromises ?? [])],
			[...(options.deferDestroyedEvents ?? [])]
		);
		const browserViewMainService = new TestBrowserViewMainService();
		const trustedProcessIds: number[] = [];
		const untrustedProcessIds: number[] = [];
		const trustedWebContentsIds: number[] = [];
		const untrustedWebContentsIds: number[] = [];
		const invalidatedHostedShellWebContentsIds: number[] = [];
		const focusHostedWorkspaceByPathCalls: string[] = [];
		const focusNormalWindowByPathCalls: string[] = [];
		const lastActiveWorktreePathCalls: string[] = [];
		const logService = new RecordingLogService();
		const stateChanges: ReturnType<
			ResidentHostedWorkspacesController['getState']
		>[] = [];
		const idQueue = [...(options.ids ?? [
			'instance-1',
			'instance-2',
			'instance-3',
			'instance-4',
		])];
		const window = {
			id: options.windowId ?? 1,
			win: new TestBrowserWindow() as unknown as Electron.BrowserWindow,
			config: {
				windowId: options.windowId ?? 1,
				partsSplash: {},
				perfMarks: [],
				workspace: undefined,
				remoteAuthority: undefined,
				zoomLevel: 0,
				accessibilitySupport: 'auto',
				isInitialStartup: false,
				filesToOpenOrCreate: undefined,
				filesToDiff: undefined,
				filesToMerge: undefined,
				backupPath: undefined,
				isOmniWindow: true,
				omniActiveWorktreePath: options.activeWorktreePath,
				omniResidentWorkspaces: options.restoreEntries,
				omniRetainedWorkbenches: options.retainedWorkbenches,
			} as unknown as INativeWindowConfiguration,
		} as ICodeWindow;
		const controller = disposables.add(new ResidentHostedWorkspacesController(
			protocolMainService as unknown as IProtocolMainService,
			{ useCodeCache: false } as unknown as IEnvironmentMainService,
			{ getBackgroundColor: () => '#111111' } as IThemeMainService,
			logService,
			browserViewMainService as unknown as IBrowserViewMainService,
			window,
			id => trustedProcessIds.push(id),
			id => untrustedProcessIds.push(id),
			id => trustedWebContentsIds.push(id),
			id => untrustedWebContentsIds.push(id),
			id => invalidatedHostedShellWebContentsIds.push(id),
			async (path, canApply) => {
				focusHostedWorkspaceByPathCalls.push(path);
				if (!canApply()) {
					return HucodeHostedShellOperationOutcome.Superseded;
				}
				return options.hostedWindowPaths?.includes(path)
					? options.hostedWindowFocusOutcome ??
					HucodeHostedShellOperationOutcome.Accepted
					: HucodeHostedShellOperationOutcome.Unavailable;
			},
			async path => {
				focusNormalWindowByPathCalls.push(path);
				return options.normalWindowPaths?.includes(path) ?? false;
			},
			async path => {
				lastActiveWorktreePathCalls.push(path);
			},
			state => stateChanges.push(state),
			{
				restorePolicy: options.restorePolicy,
				beforeUnloadTimeoutMs:
					options.beforeUnloadTimeoutMs ?? 100,
				willUnloadTimeoutMs:
					options.willUnloadTimeoutMs ?? 100,
				readyTimeoutMs: options.readyTimeoutMs ?? 100,
				createInstanceId: () => idQueue.shift() ?? 'extra-instance',
				now: () => now,
				viewFactory,
				ipcMain,
			}
		));

		return {
			browserViewMainService,
			controller,
			focusHostedWorkspaceByPathCalls,
			focusNormalWindowByPathCalls,
			ipcMain,
			invalidatedHostedShellWebContentsIds,
			lastActiveWorktreePathCalls,
			logService,
			protocolMainService,
			stateChanges,
			trustedProcessIds,
			trustedWebContentsIds,
			untrustedProcessIds,
			untrustedWebContentsIds,
			viewFactory,
			window,
		};
	}

	function createLifecycleContractAdapter():
		IHostedWorkspaceLifecycleContractAdapter {
		const normalizeState = (
			state: ReturnType<ResidentHostedWorkspacesController['getState']>
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
		const toContractState = (
			controller: ResidentHostedWorkspacesController
		): IHostedWorkspaceContractState =>
			normalizeState(controller.getState());
		const configureUnload = (
			harness: ReturnType<typeof createController>,
			viewIndex: number,
			phases: string[],
			reply: 'ready' | 'veto',
			prepareStarted?: DeferredPromise<void>,
			prepareGate?: DeferredPromise<void>
		): void => {
			harness.viewFactory.views[viewIndex].rawWebContents.sendHook =
				(channel, request) => {
					if (channel === 'vscode:onBeforeUnload') {
						phases.push('prepare');
						if (prepareStarted && !prepareStarted.isSettled) {
							void prepareStarted.complete();
						}
						const replyToPreparation = () => {
							const { okChannel, cancelChannel } = request as {
								okChannel: string;
								cancelChannel: string;
							};
							harness.ipcMain.emitReply(
								reply === 'ready' ? okChannel : cancelChannel
							);
						};
						if (prepareGate) {
							void prepareGate.p.then(replyToPreparation);
						} else {
							setTimeout(replyToPreparation, 0);
						}
						return true;
					}
					if (channel === 'vscode:onWillUnload') {
						phases.push('commit');
						const { replyChannel } = request as {
							replyChannel: string;
						};
						setTimeout(() =>
							harness.ipcMain.emitReply(replyChannel), 0
						);
						return true;
					}
					return false;
				};
		};

		return {
			async generationGuard() {
				const alpha = createWorktree('alpha');
				const beta = createWorktree('beta');
				const harness = createController();
				await harness.controller.openWorkspace(alpha, 'project-alpha');
				harness.controller.notifyHostedWorkspaceReady('instance-1');
				await harness.controller.openWorkspace(beta, 'project-beta');
				harness.controller.notifyHostedWorkspaceReady('instance-2');

				const phases: string[] = [];
				const prepareStarted = new DeferredPromise<void>();
				const prepareGate = new DeferredPromise<void>();
				configureUnload(
					harness,
					0,
					phases,
					'ready',
					prepareStarted,
					prepareGate
				);
				const closing = harness.controller.closeWorkspace('instance-1');
				await prepareStarted.p;
				await harness.controller.openWorkspace(alpha, 'project-alpha');
				await prepareGate.complete();
				await closing;

				return {
					state: toContractState(harness.controller),
					commitCount: phases.filter(phase => phase === 'commit').length,
				};
			},
			async coherentRetainedClose() {
				const scratch = createWorktree('scratch');
				const harness = createController();
				await harness.controller.retainAndOpenWorkbench(URI.file(scratch));
				harness.controller.notifyHostedWorkspaceReady('instance-1');
				const beforeClose = harness.stateChanges.length;

				await harness.controller.closeWorkspace();

				return {
					state: toContractState(harness.controller),
					emittedState: harness.stateChanges[beforeClose] &&
						normalizeState(harness.stateChanges[beforeClose]),
					emissionCount: harness.stateChanges.length - beforeClose,
				};
			},
			async restoreActiveOnly() {
				const alpha = createWorktree('alpha');
				const beta = createWorktree('beta');
				const harness = createController({
					activeWorktreePath: alpha,
					restoreEntries: [{
						projectId: 'project-alpha',
						worktreePath: alpha,
						state: 'active',
					}, {
						projectId: 'project-beta',
						worktreePath: beta,
						state: 'loaded',
					}],
				});

				await harness.controller.ensureRestored();
				const beforeReady = toContractState(harness.controller);
				const alphaInstance = harness.controller.getState().instances.find(
					instance => instance.worktreePath === alpha
				);
				assert.ok(alphaInstance);
				harness.controller.notifyHostedWorkspaceReady(
					alphaInstance.instanceId
				);

				return {
					beforeReady,
					afterReady: toContractState(harness.controller),
					createdHosts: harness.viewFactory.views.length,
				};
			},
			async closeActiveAndPromoteNext() {
				const alpha = createWorktree('alpha');
				const beta = createWorktree('beta');
				const gamma = createWorktree('gamma');
				const harness = createController({
					activeWorktreePath: gamma,
					restoreEntries: [{
						projectId: 'project-alpha',
						worktreePath: alpha,
						state: 'loaded',
						lastActiveAt: 100,
					}, {
						projectId: 'project-beta',
						worktreePath: beta,
						state: 'loaded',
						lastActiveAt: 300,
					}, {
						projectId: 'project-gamma',
						worktreePath: gamma,
						state: 'active',
						lastActiveAt: 200,
					}],
					restorePolicy: 'all',
				});
				await harness.controller.ensureRestored();
				for (const instance of harness.controller.getState().instances) {
					harness.controller.notifyHostedWorkspaceReady(
						instance.instanceId
					);
				}
				const gammaInstance = harness.controller.getState().instances.find(
					instance => instance.worktreePath === gamma
				);
				assert.ok(gammaInstance);
				const gammaViewIndex = harness.viewFactory.views.findIndex(view =>
					view.rawWebContents.id === gammaInstance.webContentsId
				);
				assert.notStrictEqual(gammaViewIndex, -1);
				const phases: string[] = [];
				configureUnload(harness, gammaViewIndex, phases, 'ready');

				await harness.controller.closeWorkspace(
					gammaInstance.instanceId
				);

				return {
					state: toContractState(harness.controller),
					unloadPhases: phases,
				};
			},
			async vetoThenShutdown() {
				const alpha = createWorktree('alpha');
				const harness = createController();
				await harness.controller.openWorkspace(alpha, 'project-alpha');
				harness.controller.notifyHostedWorkspaceReady('instance-1');
				const closePhases: string[] = [];
				configureUnload(harness, 0, closePhases, 'veto');

				await harness.controller.closeWorkspace('instance-1');
				const closeState = toContractState(harness.controller);
				const restorePathsBeforeShutdown =
					harness.window.config?.omniResidentWorkspaces?.map(
						entry => basename(entry.worktreePath)
					) ?? [];
				const shutdownPhases: string[] = [];
				configureUnload(harness, 0, shutdownPhases, 'ready');

				await harness.controller.shutdownAllWorkspaces(
					UnloadReason.QUIT
				);

				return {
					closeState,
					closePhases,
					shutdownState: toContractState(harness.controller),
					shutdownPhases,
					restorePathsBeforeShutdown,
					restorePathsAfterShutdown:
						harness.window.config?.omniResidentWorkspaces?.map(
							entry => basename(entry.worktreePath)
						) ?? [],
				};
			},
			async concurrentShutdown() {
				const alpha = createWorktree('alpha');
				const bravo = createWorktree('bravo');
				const charlie = createWorktree('charlie');
				const harness = createController();
				for (const [path, projectId, instanceId] of [
					[alpha, 'project-alpha', 'instance-1'],
					[bravo, 'project-bravo', 'instance-2'],
					[charlie, 'project-charlie', 'instance-3'],
				] as const) {
					await harness.controller.openWorkspace(path, projectId);
					harness.controller.notifyHostedWorkspaceReady(instanceId);
				}

				const phasesByPath: Record<string, string[]> = {
					alpha: [],
					bravo: [],
					charlie: [],
				};
				let releaseAlphaPreparation: (() => void) | undefined;
				let releaseCharlieCommit: (() => void) | undefined;
				const charlieCommitStarted = new DeferredPromise<void>();
				for (const [
					viewIndex,
					path,
					preparation,
				] of [
					[0, 'alpha', 'gated'],
					[1, 'bravo', 'veto'],
					[2, 'charlie', 'ready'],
				] as const) {
					harness.viewFactory.views[viewIndex].rawWebContents.sendHook =
						(channel, request) => {
							if (channel === 'vscode:onBeforeUnload') {
								phasesByPath[path].push('prepare');
								const {
									okChannel,
									cancelChannel,
								} = request as {
									okChannel: string;
									cancelChannel: string;
								};
								if (preparation === 'gated') {
									releaseAlphaPreparation = () =>
										harness.ipcMain.emitReply(okChannel);
								} else if (preparation === 'veto') {
									harness.ipcMain.emitReply(cancelChannel);
								} else {
									harness.ipcMain.emitReply(okChannel);
								}
								return true;
							}
							if (channel === 'vscode:onWillUnload') {
								phasesByPath[path].push('commit');
								const { replyChannel } = request as {
									replyChannel: string;
								};
								if (path === 'charlie') {
									releaseCharlieCommit = () =>
										harness.ipcMain.emitReply(replyChannel);
									if (!charlieCommitStarted.isSettled) {
										void charlieCommitStarted.complete();
									}
								} else {
									harness.ipcMain.emitReply(replyChannel);
								}
								return true;
							}
							return false;
						};
				}

				const firstShutdown = harness.controller.shutdownAllWorkspaces(
					UnloadReason.QUIT
				);
				await Promise.resolve();
				const preparationsStartedBeforeRelease = Object.entries(
					phasesByPath
				).filter(([, phases]) => phases[0] === 'prepare')
					.map(([path]) => path);
				let secondCallResolvedBeforeRelease = false;
				void harness.controller.shutdownAllWorkspaces(
					UnloadReason.QUIT
				).then(() => {
					secondCallResolvedBeforeRelease = true;
				});
				await Promise.resolve();
				const resolvedBeforeRelease = secondCallResolvedBeforeRelease;
				assert.ok(releaseAlphaPreparation);
				releaseAlphaPreparation();
				await charlieCommitStarted.p;
				await new Promise<void>(resolve => setTimeout(resolve, 0));
				const nativeDestructionBeforeFinalHandshake =
					[...harness.browserViewMainService
						.destroyedHostedWebContentsIds];
				assert.ok(releaseCharlieCommit);
				releaseCharlieCommit();
				await firstShutdown;
				await new Promise<void>(resolve => setTimeout(resolve, 0));
				const secondCallResolvedAfterRelease =
					secondCallResolvedBeforeRelease;
				const pathByWebContentsId = new Map([
					[1, 'alpha'],
					[2, 'bravo'],
					[3, 'charlie'],
				]);
				const nativeDestructionOrder =
					harness.browserViewMainService
						.destroyedHostedWebContentsIds.map(id => {
							const path = pathByWebContentsId.get(id);
							assert.ok(path);
							return path;
						});

				return {
					failurePolicy: 'force',
					preparationsStartedBeforeRelease,
					secondCallResolvedAfterRelease,
					secondCallResolvedBeforeRelease: resolvedBeforeRelease,
					phasesByPath,
					shutdownState: toContractState(harness.controller),
					ignoredVetoWarnings: harness.logService.warnings.map(
						warning => warning.replace(bravo, 'bravo')
					),
					nativeDestructionBeforeFinalHandshake,
					nativeDestructionOrder,
				};
			},
		};
	}

	registerHostedWorkspaceLifecycleContract(
		'force',
		createLifecycleContractAdapter
	);

	test('unload retains arbitrary workbench until explicit dismissal', async () => {
		const scratch = createWorktree('scratch');
		const { controller, stateChanges } = createController();

		await controller.retainAndOpenWorkbench(URI.file(scratch));
		const workbenchId = controller.getState().retainedWorkbenches?.[0].id;
		assert.ok(workbenchId);

		const beforeUnloadChanges = stateChanges.length;
		await controller.unloadRetainedWorkbench(workbenchId);
		assert.deepStrictEqual({
			instances: controller.getState().instances.length,
			desiredState: controller.getState()
				.retainedWorkbenches?.[0].desiredState,
		}, {
			instances: 0,
			desiredState: 'unloaded',
		});
		assert.strictEqual(stateChanges.length, beforeUnloadChanges + 1);

		const beforeDismissChanges = stateChanges.length;
		await controller.dismissRetainedWorkbench(workbenchId);
		assert.deepStrictEqual(controller.getState().retainedWorkbenches, []);
		assert.strictEqual(stateChanges.length, beforeDismissChanges + 1);
	});

	test('generic close emits one coherent retained unload state', async () => {
		const scratch = createWorktree('scratch-close');
		const { controller, stateChanges } = createController();
		await controller.retainAndOpenWorkbench(URI.file(scratch));
		const beforeCloseChanges = stateChanges.length;

		await controller.closeWorkspace();

		assert.strictEqual(stateChanges.length, beforeCloseChanges + 1);
		assert.strictEqual(
			controller.getState().retainedWorkbenches?.[0].desiredState,
			'unloaded'
		);
	});

	test('active restore policy leaves other desired workbenches dormant',
		async () => {
			const active = createWorktree('active');
			const inactive = createWorktree('inactive');
			const { controller, viewFactory } = createController({
				activeWorktreePath: active,
				retainedWorkbenches: [{
					id: 'active',
					folderUri: URI.file(active).toJSON(),
					desiredState: 'loaded',
					order: 0,
				}, {
					id: 'inactive',
					folderUri: URI.file(inactive).toJSON(),
					desiredState: 'loaded',
					order: 1,
				}],
			});

			await controller.ensureRestored();

			assert.deepStrictEqual(
				controller.getState().instances.map(instance => [
					instance.worktreePath,
					instance.state,
				]),
				[[active, 'loading'], [inactive, 'dormant']]
			);
			assert.strictEqual(viewFactory.views.length, 1);

			await controller.unloadRetainedWorkbench('inactive');
			assert.strictEqual(
				controller.getState().instances.some(instance =>
					instance.worktreePath === inactive
				),
				false
			);
			assert.strictEqual(
				controller.getState().retainedWorkbenches?.find(record =>
					record.id === 'inactive'
				)?.desiredState,
				'unloaded'
			);
		});

	test('controller applies all and none policy before main-side restore',
		async () => {
			const alpha = createWorktree('policy-alpha');
			const beta = createWorktree('policy-beta');
			const restoreEntries = [{
				projectId: 'alpha',
				worktreePath: alpha,
				state: 'active' as const,
			}, {
				projectId: 'beta',
				worktreePath: beta,
				state: 'loaded' as const,
			}];
			const all = createController({
				restoreEntries,
				activeWorktreePath: alpha,
				restorePolicy: 'all',
			});
			const none = createController({
				restoreEntries,
				activeWorktreePath: alpha,
				restorePolicy: 'none',
				windowId: 2,
			});

			await all.controller.ensureRestored();
			await none.controller.ensureRestored();

			assert.deepStrictEqual(
				all.controller.getState().instances.map(instance => instance.state),
				['loading', 'loading']
			);
			assert.strictEqual(all.viewFactory.views.length, 2);
			assert.deepStrictEqual(
				none.controller.getState().instances.map(instance => instance.state),
				['dormant', 'dormant']
			);
			assert.strictEqual(none.viewFactory.views.length, 0);
		});

	test('adopts legacy project-less resident entries into the catalog',
		async () => {
			const scratch = createWorktree('legacy-scratch');
			const { controller } = createController({
				restoreEntries: [{
					worktreePath: scratch,
					state: 'active',
				}],
				activeWorktreePath: scratch,
			});

			await controller.ensureRestored();

			assert.deepStrictEqual(
				controller.getState().retainedWorkbenches?.map(record => ({
					path: URI.revive(record.folderUri).fsPath,
					desiredState: record.desiredState,
				})),
				[{ path: scratch, desiredState: 'loaded' }]
			);
		});

	test('persists retained workbench reorder in window state', async () => {
		const first = createWorktree('reorder-first');
		const second = createWorktree('reorder-second');
		const { controller, window } = createController();
		await controller.retainAndOpenWorkbench(URI.file(first));
		await controller.retainAndOpenWorkbench(URI.file(second));
		const ids = controller.getState().retainedWorkbenches?.map(record =>
			record.id
		) ?? [];

		controller.reorderRetainedWorkbenches([...ids].reverse());

		assert.deepStrictEqual(
			window.config?.omniRetainedWorkbenches?.map(record => [
				record.id,
				record.order,
			]),
			[[ids[1], 0], [ids[0], 1]]
		);
	});

	test('persists and emits retained workbench label changes', async () => {
		const scratch = createWorktree('renamed-scratch');
		const { controller, stateChanges, window } = createController();
		await controller.retainAndOpenWorkbench(URI.file(scratch));
		const workbenchId = controller.getState().retainedWorkbenches?.[0].id;
		assert.ok(workbenchId);
		const beforeRenameChanges = stateChanges.length;

		controller.setRetainedWorkbenchLabel(workbenchId, '  Notes  ');
		const renamed = window.config?.omniRetainedWorkbenches?.[0].label;
		controller.setRetainedWorkbenchLabel(workbenchId, undefined);

		assert.deepStrictEqual({
			renamed,
			reset: window.config?.omniRetainedWorkbenches?.[0].label,
			changes: stateChanges.length - beforeRenameChanges,
		}, {
			renamed: 'Notes',
			reset: undefined,
			changes: 2,
		});
	});

	test('reconciles project promotion after restoring resident state', async () => {
		const alpha = createWorktree('alpha');
		const folderUri = URI.file(alpha);
		const { controller, window } = createController({
			restoreEntries: [{
				worktreePath: alpha,
				state: 'active',
				lastActiveAt: 100,
			}],
			activeWorktreePath: alpha,
			retainedWorkbenches: [{
				id: 'retained-alpha',
				folderUri: folderUri.toJSON(),
				desiredState: 'loaded',
				order: 0,
			}],
		});

		await controller.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([{
			projectId: 'project-alpha',
			folderUris: [folderUri],
		}]);

		assert.deepStrictEqual(controller.getState().retainedWorkbenches, []);
		assert.strictEqual(controller.getState().instances.length, 1);
		assert.strictEqual(controller.getState().instances[0].projectId,
			'project-alpha');
		assert.strictEqual(window.config?.omniResidentWorkspaces?.length, 1);
	});

	test('keeps adopted ownership when reopened with a stale project ID',
		async () => {
			const adoptedPath = createWorktree('stale-reopen');
			const { controller, window } = createController();
			await controller.openWorkspace(adoptedPath, 'removed-project');
			await controller
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([]);

			await controller.openWorkspace(adoptedPath, 'removed-project');

			const state = controller.getState();
			assert.strictEqual(state.instances[0].projectId, undefined);
			assert.deepStrictEqual(
				state.retainedWorkbenches?.map(record =>
					URI.revive(record.folderUri).fsPath
				),
				[adoptedPath]
			);
			assert.deepStrictEqual(window.config?.omniResidentWorkspaces, []);
			assert.deepStrictEqual(
				window.config?.omniRetainedWorkbenches?.map(record =>
					URI.revive(record.folderUri).fsPath
				),
				[adoptedPath]
			);
		}
	);

	test('reconciles stale ownership while reopening a crashed workbench',
		async () => {
			const adoptedPath = createWorktree('crashed-stale-reopen');
			const teardownStarted = new DeferredPromise<void>();
			const { controller, viewFactory, window } = createController();
			await controller.openWorkspace(adoptedPath, 'removed-project');
			controller.notifyHostedWorkspaceReady('instance-1');
			viewFactory.views[0].rawWebContents.emit('render-process-gone');

			let catalogUpdate: Promise<void> | undefined;
			viewFactory.views[0].rawWebContents.closeHook = () => {
				teardownStarted.complete();
				catalogUpdate = controller
					.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([]);
			};
			const reopening = controller.openWorkspace(
				adoptedPath,
				'removed-project'
			);
			await teardownStarted.p;
			assert.ok(catalogUpdate);
			await catalogUpdate;
			await reopening;

			const state = controller.getState();
			assert.strictEqual(state.instances[0].projectId, undefined);
			assert.deepStrictEqual(
				state.retainedWorkbenches?.map(record =>
					URI.revive(record.folderUri).fsPath
				),
				[adoptedPath]
			);
			assert.deepStrictEqual(window.config?.omniResidentWorkspaces, []);
			assert.deepStrictEqual(
				window.config?.omniRetainedWorkbenches?.map(record =>
					URI.revive(record.folderUri).fsPath
				),
				[adoptedPath]
			);
		}
	);

	test('keeps newer ownership when crashed reopen installs a replacement',
		async () => {
			const replacedPath = createWorktree('crashed-replacement');
			const teardownStarted = new DeferredPromise<void>();
			const { controller, viewFactory, window } = createController();
			await controller.openWorkspace(replacedPath, 'project-old');
			controller.notifyHostedWorkspaceReady('instance-1');
			viewFactory.views[0].rawWebContents.emit('render-process-gone');

			let replacementOpen: Promise<void> | undefined;
			viewFactory.views[0].rawWebContents.closeHook = () => {
				teardownStarted.complete();
				replacementOpen = controller.openWorkspace(
					replacedPath,
					'project-new'
				);
			};
			const staleReopen = controller.openWorkspace(
				replacedPath,
				'project-old'
			);
			await teardownStarted.p;
			assert.ok(replacementOpen);
			await Promise.all([replacementOpen, staleReopen]);

			const state = controller.getState();
			assert.strictEqual(state.instances.length, 1);
			assert.strictEqual(state.instances[0].instanceId, 'instance-2');
			assert.strictEqual(state.instances[0].projectId, 'project-new');
			assert.strictEqual(state.activeInstanceId, 'instance-2');
			assert.strictEqual(state.instances[0].state, 'loading');
			assert.deepStrictEqual(state.retainedWorkbenches, []);
			assert.deepStrictEqual(window.config?.omniRetainedWorkbenches, []);
			assert.deepStrictEqual(
				window.config?.omniResidentWorkspaces?.map(entry => ({
					projectId: entry.projectId,
					worktreePath: entry.worktreePath,
				})),
				[{ projectId: 'project-new', worktreePath: replacedPath }]
			);
		}
	);

	test('promotes a live retained workbench and persists project ownership',
		async () => {
			const promotedPath = createWorktree('promoted-live');
			const { controller, window } = createController();
			await controller.retainAndOpenWorkbench(URI.file(promotedPath));
			await controller
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([]);

			await controller.promoteRetainedWorkbenchProjectFolders([{
				projectId: 'project',
				folderUri: URI.file(promotedPath),
			}]);
			await controller.openWorkspace(promotedPath, 'project');

			const state = controller.getState();
			assert.strictEqual(state.instances[0].projectId, 'project');
			assert.deepStrictEqual(state.retainedWorkbenches, []);
			assert.deepStrictEqual(window.config?.omniRetainedWorkbenches, []);
			assert.deepStrictEqual(
				window.config?.omniResidentWorkspaces?.map(entry => ({
					projectId: entry.projectId,
					worktreePath: entry.worktreePath,
				})),
				[{ projectId: 'project', worktreePath: promotedPath }]
			);
		}
	);

	test('applies promotion while reopening a crashed retained workbench',
		async () => {
			const promotedPath = createWorktree('crashed-promotion');
			const teardownStarted = new DeferredPromise<void>();
			const { controller, viewFactory, window } = createController();
			await controller.retainAndOpenWorkbench(URI.file(promotedPath));
			controller.notifyHostedWorkspaceReady('instance-1');
			await controller
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([]);
			viewFactory.views[0].rawWebContents.emit('render-process-gone');

			let catalogUpdate: Promise<void> | undefined;
			viewFactory.views[0].rawWebContents.closeHook = () => {
				teardownStarted.complete();
				catalogUpdate = controller
					.promoteRetainedWorkbenchProjectFolders([{
						projectId: 'project',
						folderUri: URI.file(promotedPath),
					}]);
			};
			const reopening = controller.openWorkspace(promotedPath);
			await teardownStarted.p;
			assert.ok(catalogUpdate);
			await catalogUpdate;
			await reopening;

			const state = controller.getState();
			assert.strictEqual(state.instances[0].projectId, 'project');
			assert.deepStrictEqual(state.retainedWorkbenches, []);
			assert.deepStrictEqual(window.config?.omniRetainedWorkbenches, []);
			assert.deepStrictEqual(
				window.config?.omniResidentWorkspaces?.map(entry => ({
					projectId: entry.projectId,
					worktreePath: entry.worktreePath,
				})),
				[{ projectId: 'project', worktreePath: promotedPath }]
			);
		}
	);

	test('adopts active, loaded, and dormant orphaned project workbenches',
		async () => {
			const alpha = createWorktree('alpha');
			const bravo = createWorktree('bravo');
			const dormant = createWorktree('dormant');
			const { controller, window } = createController({
				restoreEntries: [{
					projectId: 'removed-dormant',
					worktreePath: dormant,
					state: 'loaded',
					lastActiveAt: 10,
				}],
				restorePolicy: 'none',
			});
			await controller.ensureRestored();
			await controller.openWorkspace(alpha, 'removed-alpha');
			controller.notifyHostedWorkspaceReady('instance-2');
			await controller.openWorkspace(bravo, 'removed-bravo');
			controller.notifyHostedWorkspaceReady('instance-3');

			await controller
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([]);

			const state = controller.getState();
			assert.deepStrictEqual(
				state.instances.map(instance => ({
					path: instance.worktreePath,
					state: instance.state,
					projectId: instance.projectId,
				})).toSorted((a, b) => a.path.localeCompare(b.path)),
				[
					{ path: alpha, state: 'loaded', projectId: undefined },
					{ path: bravo, state: 'active', projectId: undefined },
					{ path: dormant, state: 'dormant', projectId: undefined },
				]
			);
			assert.deepStrictEqual(
				state.retainedWorkbenches?.map(record =>
					URI.revive(record.folderUri).fsPath
				).toSorted(),
				[alpha, bravo, dormant].toSorted()
			);
			assert.deepStrictEqual(window.config?.omniResidentWorkspaces, []);
			assert.deepStrictEqual(
				window.config?.omniRetainedWorkbenches?.map(record =>
					URI.revive(record.folderUri).fsPath
				).toSorted(),
				[alpha, bravo, dormant].toSorted()
			);
		}
	);

	test('adopts a pre-fix project snapshot during initial reconciliation',
		async () => {
			const orphan = createWorktree('restored-orphan');
			const { controller, window } = createController({
				restoreEntries: [{
					projectId: 'removed-project',
					worktreePath: orphan,
					state: 'loaded',
				}],
				restorePolicy: 'none',
			});

			await controller
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([]);

			const state = controller.getState();
			assert.strictEqual(state.instances.length, 1);
			assert.strictEqual(state.instances[0].state, 'dormant');
			assert.strictEqual(state.instances[0].projectId, undefined);
			assert.deepStrictEqual(window.config?.omniResidentWorkspaces, []);
			const persistedRetained =
				window.config?.omniRetainedWorkbenches?.[0];
			assert.ok(persistedRetained);
			assert.strictEqual(
				URI.revive(persistedRetained.folderUri).fsPath,
				orphan
			);
		}
	);

	test('uses complete project identity and keeps partial promotion safe',
		async () => {
			const readded = createWorktree('readded');
			const liveWithoutWorktrees = createWorktree(
				'live-without-worktrees'
			);
			const orphan = createWorktree('orphan');
			const { controller } = createController({
				restoreEntries: [{
					projectId: 'old-owner',
					worktreePath: readded,
					state: 'loaded',
				}, {
					projectId: 'still-live',
					worktreePath: liveWithoutWorktrees,
					state: 'loaded',
				}, {
					projectId: 'removed-owner',
					worktreePath: orphan,
					state: 'loaded',
				}],
				restorePolicy: 'none',
			});

			await controller.promoteRetainedWorkbenchProjectFolders([{
				projectId: 'unrelated',
				folderUri: URI.file(createWorktree('unrelated')),
			}]);
			assert.deepStrictEqual(
				controller.getState().instances.map(instance =>
					instance.projectId
				),
				['old-owner', 'still-live', 'removed-owner']
			);

			await controller
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([{
					projectId: 'replacement-owner',
					folderUris: [URI.file(readded)],
				}, {
					projectId: 'still-live',
					folderUris: [],
				}]);

			const state = controller.getState();
			assert.deepStrictEqual(
				state.instances.map(instance => ({
					path: instance.worktreePath,
					projectId: instance.projectId,
				})).toSorted((a, b) => a.path.localeCompare(b.path)),
				[
					{ path: liveWithoutWorktrees, projectId: 'still-live' },
					{ path: orphan, projectId: undefined },
					{ path: readded, projectId: 'replacement-owner' },
				].toSorted((a, b) => a.path.localeCompare(b.path))
			);
			assert.deepStrictEqual(
				state.retainedWorkbenches?.map(record =>
					URI.revive(record.folderUri).fsPath
				),
				[orphan]
			);
		}
	);

	test('adopts a loading orphan before it becomes ready', async () => {
		const loading = createWorktree('loading-orphan');
		const { controller } = createController();
		await controller.openWorkspace(loading, 'removed-owner');
		assert.strictEqual(controller.getState().instances[0].state, 'loading');

		await controller
			.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([]);

		const state = controller.getState();
		assert.strictEqual(state.instances[0].projectId, undefined);
		const retained = state.retainedWorkbenches?.[0];
		assert.ok(retained);
		assert.strictEqual(
			URI.revive(retained.folderUri).fsPath,
			loading
		);
	});

	test('leaves existing retained workbenches out of orphan adoption',
		async () => {
			const retained = createWorktree('already-retained');
			const { controller, stateChanges } = createController();
			await controller.openWorkspace(retained);
			const changesBeforeReconcile = stateChanges.length;

			await controller
				.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([]);

			const state = controller.getState();
			assert.strictEqual(state.instances[0].projectId, undefined);
			assert.strictEqual(state.retainedWorkbenches?.length, 1);
			assert.strictEqual(stateChanges.length, changesBeforeReconcile);
		}
	);

	test('leaves crashed project workbenches out of orphan adoption', async () => {
		const crashed = createWorktree('crashed-orphan');
		const { controller, stateChanges, viewFactory } = createController();
		await controller.openWorkspace(crashed, 'removed-project');
		controller.notifyHostedWorkspaceReady('instance-1');
		viewFactory.views[0].rawWebContents.emit('render-process-gone');
		const changesBeforeReconcile = stateChanges.length;

		await controller
			.reconcileRetainedWorkbenchesWithCompleteProjectCatalog([]);

		const state = controller.getState();
		assert.strictEqual(state.instances[0].state, 'crashed');
		assert.strictEqual(state.instances[0].projectId, 'removed-project');
		assert.deepStrictEqual(state.retainedWorkbenches, []);
		assert.strictEqual(stateChanges.length, changesBeforeReconcile);
	});

	test('missing retained restore is kept unloaded without a retry loop',
		async () => {
			const missing = join(tempRoot, 'missing');
			const { controller } = createController({
				activeWorktreePath: missing,
				retainedWorkbenches: [{
					id: 'missing',
					folderUri: URI.file(missing).toJSON(),
					desiredState: 'loaded',
					order: 0,
				}],
			});

			await controller.ensureRestored();

			assert.strictEqual(controller.getState().instances.length, 0);
			assert.strictEqual(
				controller.getState().retainedWorkbenches?.[0].desiredState,
				'unloaded'
			);
			assert.strictEqual(
				controller.getState().retainedWorkbenches?.[0].folderStatus,
				'missing'
			);
		});

	test('restore without resident workspaces emits an empty shell state', async () => {
		const { controller, stateChanges } = createController();

		await controller.ensureRestored();

		assert.deepStrictEqual(controller.getState(), {
			activeInstanceId: undefined,
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			projectSwitcherSectionOrder: ['workbenches', 'projects'],
			instances: [],
			retainedWorkbenches: [],
		});
		assert.strictEqual(stateChanges.length, 1);
	});

	test('projects sidebar cannot be hidden without loaded workspaces', () => {
		const { controller } = createController();

		controller.setProjectsSidebarVisible(false);

		assert.strictEqual(controller.getState().projectsSidebarVisible, true);
	});

	test('restore chooses configured active workspace and waits for ready', async () => {
		const alpha = createWorktree('alpha');
		const bravo = createWorktree('bravo');
		const { controller, viewFactory, stateChanges } = createController({
			activeWorktreePath: bravo,
			restoreEntries: [
				{
					projectId: 'project-alpha',
					worktreePath: alpha,
					state: 'loaded',
					lastActiveAt: 100,
				},
				{
					projectId: 'project-bravo',
					worktreePath: bravo,
					state: 'loaded',
					lastActiveAt: 50,
				},
			],
		});

		await controller.ensureRestored();

		assert.strictEqual(viewFactory.views.length, 1);
		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			projectId: instance.projectId,
			worktreePath: instance.worktreePath,
			state: instance.state,
			visible: instance.visible,
		})), [
			{
				projectId: 'project-bravo',
				worktreePath: bravo,
				state: 'loading',
				visible: true,
			},
			{
				projectId: 'project-alpha',
				worktreePath: alpha,
				state: 'dormant',
				visible: false,
			},
		]);

		controller.notifyHostedWorkspaceReady('instance-2');

		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			worktreePath: instance.worktreePath,
			state: instance.state,
		})), [
			{ worktreePath: bravo, state: 'active' },
			{ worktreePath: alpha, state: 'dormant' },
		]);
		assert.ok(stateChanges.length >= 4);
	});

	test('project restore metadata wins retained path overlap', async () => {
		const alpha = createWorktree('project-retained-overlap');
		const { controller } = createController({
			activeWorktreePath: alpha,
			restoreEntries: [{
				projectId: 'project-alpha',
				worktreePath: alpha,
				state: 'active',
			}],
			retainedWorkbenches: [{
				id: 'retained-alpha',
				folderUri: URI.file(alpha).toJSON(),
				desiredState: 'loaded',
				order: 0,
			}],
		});

		await controller.ensureRestored();

		assert.strictEqual(
			controller.getState().instances[0].projectId,
			'project-alpha'
		);
	});

	test('restore skips missing active workspace and promotes MRU', async () => {
		const alpha = createWorktree('alpha');
		const stale = join(tempRoot, 'stale');
		const { browserViewMainService, controller, viewFactory, window } =
			createController({
				activeWorktreePath: stale,
				restoreEntries: [
					{
						projectId: 'project-alpha',
						worktreePath: alpha,
						state: 'loaded',
						lastActiveAt: 100,
					},
					{
						projectId: 'project-stale',
						worktreePath: stale,
						state: 'active',
						lastActiveAt: 200,
					},
				],
			});

		await controller.ensureRestored();
		controller.notifyHostedWorkspaceReady('instance-1');

		assert.strictEqual(viewFactory.views.length, 1);
		assert.deepStrictEqual(
			browserViewMainService.destroyedHostedWebContentsIds,
			[]
		);
		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			webContentsId: instance.webContentsId,
			worktreePath: instance.worktreePath,
			state: instance.state,
			visible: instance.visible,
		})), [
			{
				webContentsId: 1,
				worktreePath: alpha,
				state: 'active',
				visible: true,
			},
		]);
		assert.deepStrictEqual(browserViewMainService.visibleCalls.slice(-3), [
			{ id: 1, visible: false },
			{ id: 1, visible: true },
			{ id: 1, visible: true },
		]);
		assert.strictEqual(window.config?.omniActiveWorktreePath, alpha);
		assert.deepStrictEqual(window.config?.omniResidentWorkspaces, [{
			projectId: 'project-alpha',
			worktreePath: alpha,
			lastActiveAt: 1000,
			state: 'active',
		}]);
	});

	test('latest overlapping workspace open keeps activation', async () => {
		const alpha = createWorktree('slow-alpha');
		const bravo = createWorktree('fast-bravo');
		const slowLoad = new DeferredPromise<void>();
		const fastLoad = new DeferredPromise<void>();
		const { controller, viewFactory } = createController({
			loadUrlPromises: [slowLoad.p, fastLoad.p],
		});

		const openAlpha = controller.openWorkspace(alpha);
		for (let attempt = 0;
			attempt < 20 && viewFactory.views.length < 1;
			attempt++
		) {
			await Promise.resolve();
		}
		assert.strictEqual(viewFactory.views.length, 1);
		const openBravo = controller.openWorkspace(bravo);
		for (let attempt = 0;
			attempt < 20 && viewFactory.views.length < 2;
			attempt++
		) {
			await Promise.resolve();
		}
		assert.strictEqual(viewFactory.views.length, 2);

		fastLoad.complete();
		await openBravo;
		slowLoad.complete();
		await openAlpha;

		assert.deepStrictEqual({
			activeInstanceId: controller.getState().activeInstanceId,
			alphaLastActiveAt: controller.getState().retainedWorkbenches
				?.find(record => URI.revive(record.folderUri).fsPath === alpha)
				?.lastActiveAt,
			instances: controller.getState().instances
				.map(instance => ({
					instanceId: instance.instanceId,
					visible: instance.visible,
				}))
				.toSorted((a, b) => a.instanceId.localeCompare(b.instanceId)),
		}, {
			activeInstanceId: 'instance-4',
			alphaLastActiveAt: undefined,
			instances: [
				{ instanceId: 'instance-2', visible: false },
				{ instanceId: 'instance-4', visible: true },
			],
		});
	});

	test('coalesces overlapping opens for the same workspace', async () => {
		const alpha = createWorktree('same-alpha');
		const load = new DeferredPromise<void>();
		const { controller, viewFactory } = createController({
			loadUrlPromises: [load.p],
		});

		const first = controller.openWorkspace(alpha, 'project-alpha');
		for (let attempt = 0;
			attempt < 20 && viewFactory.views.length < 1;
			attempt++
		) {
			await Promise.resolve();
		}
		await controller.openWorkspace(alpha, 'project-alpha');

		assert.strictEqual(viewFactory.views.length, 1);
		load.complete();
		await first;
		assert.deepStrictEqual(
			controller.getState().instances.map(instance => instance.instanceId),
			['instance-1']
		);
	});

	test('retains missing folders without creating hosted views', async () => {
		const missing = join(tempRoot, 'missing');
		const { controller, protocolMainService, viewFactory } =
			createController();

		await controller.retainAndOpenWorkbench(URI.file(missing));

		assert.deepStrictEqual({
			instances: controller.getState().instances,
			retained: controller.getState().retainedWorkbenches?.map(record => ({
				desiredState: record.desiredState,
				folderStatus: record.folderStatus,
			})),
			views: viewFactory.views.length,
			objectUrls: protocolMainService.objectUrls.length,
		}, {
			instances: [],
			retained: [{
				desiredState: 'loaded',
				folderStatus: 'missing',
			}],
			views: 0,
			objectUrls: 0,
		});
	});

	test('classifies inaccessible hosted folders as unavailable', () => {
		for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']) {
			assert.strictEqual(
				isHostedWorkspaceFolderUnavailableError(
					Object.assign(new Error(code), { code })
				),
				true
			);
		}
		assert.strictEqual(
			isHostedWorkspaceFolderUnavailableError(
				Object.assign(new Error('EIO'), { code: 'EIO' })
			),
			false
		);
	});

	test('opening an existing workspace reuses the resident view', async () => {
		const alpha = createWorktree('alpha');
		const bravo = createWorktree('bravo');
		const { controller, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		now = 2000;
		await controller.openWorkspace(bravo, 'project-bravo');
		controller.notifyHostedWorkspaceReady('instance-2');
		now = 3000;
		await controller.openWorkspace(alpha, 'project-alpha');

		assert.strictEqual(viewFactory.views.length, 2);
		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			worktreePath: instance.worktreePath,
			state: instance.state,
			visible: instance.visible,
			lastActiveAt: instance.lastActiveAt,
		})), [
			{
				worktreePath: alpha,
				state: 'active',
				visible: true,
				lastActiveAt: 3000,
			},
			{
				worktreePath: bravo,
				state: 'loaded',
				visible: false,
				lastActiveAt: 2000,
			},
		]);
	});

	test('failed workspace attach rolls back lookup state', async () => {
		const alpha = createWorktree('alpha');
		const loadError = new Error('load failed');
		const { controller, protocolMainService, viewFactory } = createController({
			ids: ['failed-instance', 'recovered-instance'],
			loadUrlErrors: [loadError],
		});

		await assert.rejects(
			() => controller.openWorkspace(alpha, 'project-alpha'),
			/load failed/
		);

		assert.deepStrictEqual(controller.getState().instances, []);
		assert.strictEqual(protocolMainService.objectUrls[0].disposed, true);
		assert.strictEqual(viewFactory.views[0].rawWebContents.closeCalls.length, 1);

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('recovered-instance');

		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			instanceId: instance.instanceId,
			worktreePath: instance.worktreePath,
			state: instance.state,
		})), [
			{
				instanceId: 'recovered-instance',
				worktreePath: alpha,
				state: 'active',
			},
		]);
	});

	test('failed retained attach emits coherent persistent cleanup', async () => {
		const scratch = createWorktree('failed-retained');
		const loadError = new Error('load failed');
		const { controller, stateChanges, window } = createController({
			loadUrlErrors: [loadError],
		});
		await controller.ensureRestored();
		stateChanges.length = 0;

		await assert.rejects(
			() => controller.retainAndOpenWorkbench(URI.file(scratch)),
			/load failed/
		);

		assert.strictEqual(stateChanges.length, 2);
		assert.deepStrictEqual(stateChanges.at(-1), controller.getState());
		assert.deepStrictEqual(controller.getState().instances, []);
		assert.deepStrictEqual(
			controller.getState().retainedWorkbenches?.map(record => ({
				desiredState: record.desiredState,
				folderStatus: record.folderStatus,
			})),
			[{ desiredState: 'unloaded', folderStatus: undefined }]
		);
		assert.deepStrictEqual(
			window.config?.omniRetainedWorkbenches,
			controller.getState().retainedWorkbenches
		);
	});

	test('closing workspace owns its config object URL once', async () => {
		const alpha = createWorktree('alpha');
		const { controller, protocolMainService } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		await controller.closeWorkspace();

		assert.strictEqual(protocolMainService.objectUrls[0].disposeCalls, 1);
		controller.dispose();
		assert.strictEqual(protocolMainService.objectUrls[0].disposeCalls, 1);
	});

	test('opening crashed workspace creates a new resident view', async () => {
		const alpha = createWorktree('alpha');
		const { controller, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		viewFactory.views[0].rawWebContents.emit('render-process-gone');

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-2');

		assert.strictEqual(viewFactory.views.length, 2);
		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			instanceId: instance.instanceId,
			worktreePath: instance.worktreePath,
			state: instance.state,
		})), [
			{
				instanceId: 'instance-2',
				worktreePath: alpha,
				state: 'active',
			},
		]);
	});

	test('openFilesInWorkspace waits for new workspace readiness', async () => {
		const alpha = createWorktree('alpha');
		const fileUri = URI.file(join(alpha, 'src/file.txt'));
		const request = {
			filesToOpenOrCreate: [{ fileUri }],
			termProgram: 'hucode',
		};
		const { controller, viewFactory } = createController();

		const openPromise = controller.openFilesInWorkspace(
			alpha,
			request,
			'project-alpha'
		);
		setTimeout(() =>
			controller.notifyHostedWorkspaceReady('instance-1'), 0);

		assert.strictEqual(await openPromise, true);
		assert.strictEqual(viewFactory.views.length, 1);
		assert.deepStrictEqual(viewFactory.views[0].rawWebContents.sent, [
			{
				channel: 'vscode:openFiles',
				request,
			}
		]);
		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			projectId: instance.projectId,
			worktreePath: instance.worktreePath,
			state: instance.state,
			visible: instance.visible,
		})), [
			{
				projectId: 'project-alpha',
				worktreePath: alpha,
				state: 'active',
				visible: true,
			}
		]);
	});

	test('openFilesInActiveWorkspace waits for readiness', async () => {
		const alpha = createWorktree('alpha');
		const fileUri = URI.file(join(alpha, 'src/file.txt'));
		const request = {
			filesToOpenOrCreate: [{ fileUri }],
		};
		const { controller, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		const openPromise = controller.openFilesInActiveWorkspace(request);
		await Promise.resolve();

		assert.deepStrictEqual(viewFactory.views[0].rawWebContents.sent, []);
		controller.notifyHostedWorkspaceReady('instance-1');

		assert.strictEqual(await openPromise, true);
		assert.deepStrictEqual(viewFactory.views[0].rawWebContents.sent, [
			{
				channel: 'vscode:openFiles',
				request,
			}
		]);
	});

	test('openFilesInActiveWorkspace fails when readiness times out', async () => {
		const alpha = createWorktree('alpha');
		const fileUri = URI.file(join(alpha, 'src/file.txt'));
		const { controller, viewFactory } = createController({
			readyTimeoutMs: 1,
		});

		await controller.openWorkspace(alpha, 'project-alpha');

		assert.strictEqual(
			await controller.openFilesInActiveWorkspace({
				filesToOpenOrCreate: [{ fileUri }],
			}),
			false
		);
		assert.deepStrictEqual(viewFactory.views[0].rawWebContents.sent, []);
	});

	test('unload reply channels are unique across controllers', async () => {
		const alpha = createWorktree('alpha');
		const bravo = createWorktree('bravo');
		const ipcMain = new TestHostedWorkspaceIpcMain();
		const first = createController({ ipcMain, windowId: 1 });
		const second = createController({ ipcMain, windowId: 2 });

		await first.controller.openWorkspace(alpha, 'project-alpha');
		await second.controller.openWorkspace(bravo, 'project-bravo');
		first.controller.notifyHostedWorkspaceReady('instance-1');
		second.controller.notifyHostedWorkspaceReady('instance-1');

		await Promise.all([
			first.controller.closeWorkspace(),
			second.controller.closeWorkspace(),
		]);

		const firstBeforeUnload = first.viewFactory.views[0].rawWebContents
			.sent[0].request as { okChannel: string; cancelChannel: string };
		const secondBeforeUnload = second.viewFactory.views[0].rawWebContents
			.sent[0].request as { okChannel: string; cancelChannel: string };
		const firstWillUnload = first.viewFactory.views[0].rawWebContents
			.sent[1].request as { replyChannel: string };
		const secondWillUnload = second.viewFactory.views[0].rawWebContents
			.sent[1].request as { replyChannel: string };

		assert.strictEqual(firstBeforeUnload.okChannel, 'vscode:ok:1:instance-1:0');
		assert.strictEqual(
			firstBeforeUnload.cancelChannel,
			'vscode:cancel:1:instance-1:0'
		);
		assert.strictEqual(
			secondBeforeUnload.okChannel,
			'vscode:ok:2:instance-1:0'
		);
		assert.strictEqual(
			secondBeforeUnload.cancelChannel,
			'vscode:cancel:2:instance-1:0'
		);
		assert.strictEqual(
			firstWillUnload.replyChannel,
			'vscode:reply:1:instance-1:1'
		);
		assert.strictEqual(
			secondWillUnload.replyChannel,
			'vscode:reply:2:instance-1:1'
		);
	});

	test('closing active workspace unloads it and activates next MRU', async () => {
		const alpha = createWorktree('alpha');
		const bravo = createWorktree('bravo');
		const {
			browserViewMainService,
			controller,
			untrustedProcessIds,
			untrustedWebContentsIds,
			viewFactory,
		} = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		now = 2000;
		await controller.openWorkspace(bravo, 'project-bravo');
		controller.notifyHostedWorkspaceReady('instance-2');
		await controller.closeWorkspace();

		const closedView = viewFactory.views[1];
		assert.deepStrictEqual(
			closedView.rawWebContents.sent.map(item => item.channel),
			['vscode:onBeforeUnload', 'vscode:onWillUnload']
		);
		assert.deepStrictEqual(closedView.rawWebContents.closeCalls, [
			{ waitForBeforeUnload: false },
		]);
		assert.deepStrictEqual(
			browserViewMainService.destroyedHostedWebContentsIds,
			[2]
		);
		assert.deepStrictEqual(untrustedWebContentsIds, [2]);
		assert.deepStrictEqual(untrustedProcessIds, [1002]);
		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			worktreePath: instance.worktreePath,
			state: instance.state,
			visible: instance.visible,
		})), [
			{ worktreePath: alpha, state: 'active', visible: true },
		]);
	});

	test('suspends active project workspace and activates next MRU', async () => {
		const alpha = createWorktree('suspend-active-alpha');
		const bravo = createWorktree('suspend-active-bravo');
		const { controller, stateChanges, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		now = 2000;
		await controller.openWorkspace(bravo, 'project-bravo');
		controller.notifyHostedWorkspaceReady('instance-2');
		const changesBeforeSuspend = stateChanges.length;

		await controller.suspendWorkspace('instance-2');

		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			worktreePath: instance.worktreePath,
			state: instance.state,
			lastActiveAt: instance.lastActiveAt,
		})), [
			{ worktreePath: alpha, state: 'active', lastActiveAt: 2000 },
			{ worktreePath: bravo, state: 'dormant', lastActiveAt: 2000 },
		]);
		assert.deepStrictEqual(
			viewFactory.views[1].rawWebContents.sent.map(item => item.channel),
			['vscode:onBeforeUnload', 'vscode:onWillUnload']
		);
		assert.strictEqual(stateChanges.length, changesBeforeSuspend + 1);
		assert.ok(stateChanges.slice(changesBeforeSuspend).every(state =>
			state.instances.every(instance => instance.state !== 'unloaded')
		));
	});

	test('suspends loaded retained workbench without unloading its record',
		async () => {
			const scratch = createWorktree('suspend-retained');
			const project = createWorktree('suspend-project');
			const { controller } = createController();

			await controller.retainAndOpenWorkbench(URI.file(scratch));
			const retainedInstanceId = controller.getState().activeInstanceId;
			assert.ok(retainedInstanceId);
			controller.notifyHostedWorkspaceReady(retainedInstanceId);
			now = 2000;
			await controller.openWorkspace(project, 'project');
			const projectInstanceId = controller.getState().activeInstanceId;
			assert.ok(projectInstanceId);
			controller.notifyHostedWorkspaceReady(projectInstanceId);

			await controller.suspendWorkspace(retainedInstanceId);

			const state = controller.getState();
			assert.deepStrictEqual({
				activePath: state.instances.find(instance =>
					instance.instanceId === state.activeInstanceId
				)?.worktreePath,
				retainedState: state.instances.find(instance =>
					instance.worktreePath === scratch
				)?.state,
				desiredState: state.retainedWorkbenches?.[0].desiredState,
			}, {
				activePath: project,
				retainedState: 'dormant',
				desiredState: 'loaded',
			});
		}
	);

	test('preserves active retained workbench when suspension is vetoed',
		async () => {
			const scratch = createWorktree('suspend-veto');
			const { controller, ipcMain, viewFactory } = createController();

			await controller.retainAndOpenWorkbench(URI.file(scratch));
			const instanceId = controller.getState().activeInstanceId;
			assert.ok(instanceId);
			controller.notifyHostedWorkspaceReady(instanceId);
			viewFactory.views[0].rawWebContents.sendHook = (channel, request) => {
				if (channel === 'vscode:onBeforeUnload') {
					const { cancelChannel } = request as { cancelChannel: string };
					setTimeout(() => ipcMain.emitReply(cancelChannel), 0);
				}
				return true;
			};

			await controller.suspendWorkspace(instanceId);

			assert.deepStrictEqual({
				activeInstanceId: controller.getState().activeInstanceId,
				state: controller.getState().instances[0].state,
				desiredState:
					controller.getState().retainedWorkbenches?.[0].desiredState,
				sent: viewFactory.views[0].rawWebContents.sent.map(
					message => message.channel
				),
				closeCalls: viewFactory.views[0].rawWebContents.closeCalls,
			}, {
				activeInstanceId: instanceId,
				state: 'active',
				desiredState: 'loaded',
				sent: ['vscode:onBeforeUnload'],
				closeCalls: [],
			});
		}
	);

	test('ignores unknown, loading, and dormant suspension targets', async () => {
		const alpha = createWorktree('suspend-guards');
		const { controller, stateChanges, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		const loadingState = controller.getState();
		const instanceId = loadingState.activeInstanceId;
		assert.ok(instanceId);
		const changesBeforeGuards = stateChanges.length;

		await controller.suspendWorkspace('unknown-instance');
		await controller.suspendWorkspace(instanceId);

		assert.deepStrictEqual(controller.getState(), loadingState);
		assert.strictEqual(stateChanges.length, changesBeforeGuards);
		assert.deepStrictEqual(viewFactory.views[0].rawWebContents.sent, []);

		controller.notifyHostedWorkspaceReady(instanceId);
		await controller.suspendWorkspace(instanceId);
		const dormantState = controller.getState();
		const dormantInstanceId = dormantState.instances[0].instanceId;
		const unloadMessages = viewFactory.views[0].rawWebContents.sent.length;
		const changesBeforeDormantGuard = stateChanges.length;

		await controller.suspendWorkspace(dormantInstanceId);

		assert.deepStrictEqual(controller.getState(), dormantState);
		assert.strictEqual(
			viewFactory.views[0].rawWebContents.sent.length,
			unloadMessages
		);
		assert.strictEqual(stateChanges.length, changesBeforeDormantGuard);
	});

	test('ordinary close preserves a silent workspace after timeout',
		async () => {
			const alpha = createWorktree('alpha-close-timeout');
			const {
				browserViewMainService,
				controller,
				ipcMain,
				viewFactory,
				window,
			} = createController({ beforeUnloadTimeoutMs: 5 });
			const browserWindow = window.win as unknown as TestBrowserWindow;

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			const hostedView = viewFactory.views[0];
			let beforeUnload: {
				okChannel: string;
				preparationId: string;
			} | undefined;
			hostedView.rawWebContents.sendHook = (channel, request) => {
				if (channel === 'vscode:onBeforeUnload') {
					beforeUnload = request as {
						okChannel: string;
						preparationId: string;
					};
					return true;
				}
				return false;
			};

			await controller.closeWorkspace('instance-1');
			assert.ok(beforeUnload);
			ipcMain.emitReply(beforeUnload.okChannel);
			await Promise.resolve();

			assert.deepStrictEqual(
				controller.getState().instances.map(instance => ({
					instanceId: instance.instanceId,
					state: instance.state,
				})),
				[{ instanceId: 'instance-1', state: 'active' }]
			);
			assert.deepStrictEqual(browserWindow.contentView.children, [
				hostedView,
			]);
			assert.deepStrictEqual(hostedView.rawWebContents.closeCalls, []);
			assert.deepStrictEqual(
				browserViewMainService.destroyedHostedWebContentsIds,
				[]
			);
			assert.deepStrictEqual(
				hostedView.rawWebContents.sent.map(message => message.channel),
				[
					'vscode:onBeforeUnload',
					'vscode:onShutdownPreparationAbandoned',
				]
			);
			assert.strictEqual(
				(
					hostedView.rawWebContents.sent[1].request as {
						preparationId: string;
					}
				).preparationId,
				beforeUnload.preparationId
			);
		}
	);

	test('ordinary close preserves a workspace when before-unload send fails',
		async () => {
			const alpha = createWorktree('alpha-close-send-failure');
			const {
				browserViewMainService,
				controller,
				viewFactory,
				window,
			} = createController();
			const browserWindow = window.win as unknown as TestBrowserWindow;

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			const hostedView = viewFactory.views[0];
			hostedView.rawWebContents.sendHook = channel => {
				if (channel === 'vscode:onBeforeUnload') {
					throw new Error('send failed');
				}
				return false;
			};

			await controller.closeWorkspace('instance-1');

			assert.deepStrictEqual(
				controller.getState().instances.map(instance => ({
					instanceId: instance.instanceId,
					state: instance.state,
				})),
				[{ instanceId: 'instance-1', state: 'active' }]
			);
			assert.deepStrictEqual(browserWindow.contentView.children, [
				hostedView,
			]);
			assert.deepStrictEqual(hostedView.rawWebContents.closeCalls, []);
			assert.deepStrictEqual(
				browserViewMainService.destroyedHostedWebContentsIds,
				[]
			);
			assert.deepStrictEqual(
				hostedView.rawWebContents.sent.map(message => message.channel),
				[
					'vscode:onBeforeUnload',
					'vscode:onShutdownPreparationAbandoned',
				]
			);
			assert.strictEqual(hostedView.rawWebContents.reloadCalls.length, 0);
		}
	);

	test('does not close a workspace reactivated during unload', async () => {
		const alpha = createWorktree('alpha-reactivated');
		const bravo = createWorktree('bravo-reactivated');
		const { controller, ipcMain, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		await controller.openWorkspace(bravo, 'project-bravo');
		controller.notifyHostedWorkspaceReady('instance-2');
		await controller.openWorkspace(alpha, 'project-alpha');
		viewFactory.views[0].rawWebContents.autoBeforeUnloadReply = false;

		const closing = controller.closeWorkspace('instance-1');
		await Promise.resolve();
		const beforeUnload = viewFactory.views[0].rawWebContents.sent[0]
			.request as { okChannel: string };
		await controller.openWorkspace(bravo, 'project-bravo');
		await controller.openWorkspace(alpha, 'project-alpha');
		ipcMain.emitReply(beforeUnload.okChannel);
		await closing;

		const rollbackRequest = viewFactory.views[0].rawWebContents.sent[1]
			.request as {
				preparationId: string;
				replyChannel?: string;
			};
		assert.ok(rollbackRequest.replyChannel);
		assert.deepStrictEqual({
			activeInstanceId: controller.getState().activeInstanceId,
			instanceIds: controller.getState().instances.map(
				instance => instance.instanceId
			).toSorted(),
			sent: viewFactory.views[0].rawWebContents.sent.map(item => item.channel),
			closeCalls: viewFactory.views[0].rawWebContents.closeCalls,
		}, {
			activeInstanceId: 'instance-1',
			instanceIds: ['instance-1', 'instance-2'],
			sent: [
				'vscode:onBeforeUnload',
				'vscode:onShutdownPreparationAbandoned',
			],
			closeCalls: [],
		});
	});

	test('reloads a reactivated workspace when preparation rollback send fails',
		async () => {
			const alpha = createWorktree('alpha-reactivated-rollback-failure');
			const bravo = createWorktree('bravo-reactivated-rollback-failure');
			const { controller, ipcMain, viewFactory } = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');
			await controller.openWorkspace(alpha, 'project-alpha');
			const hostedWebContents = viewFactory.views[0].rawWebContents;
			hostedWebContents.autoBeforeUnloadReply = false;
			hostedWebContents.sendHook = channel => {
				if (channel === 'vscode:onShutdownPreparationAbandoned') {
					throw new Error('rollback send failed');
				}
				return false;
			};

			const closing = controller.closeWorkspace('instance-1');
			await Promise.resolve();
			const beforeUnload = hostedWebContents.sent[0].request as {
				okChannel: string;
			};
			await controller.openWorkspace(bravo, 'project-bravo');
			await controller.openWorkspace(alpha, 'project-alpha');
			ipcMain.emitReply(beforeUnload.okChannel);
			await closing;

			assert.deepStrictEqual({
				activeInstanceId: controller.getState().activeInstanceId,
				instanceIds: controller.getState().instances.map(
					instance => instance.instanceId
				).toSorted(),
				sent: hostedWebContents.sent.map(item => item.channel),
				state: controller.getState().instances.find(instance =>
					instance.instanceId === 'instance-1'
				)?.state,
				reloadCalls: hostedWebContents.reloadCalls.length,
				closeCalls: hostedWebContents.closeCalls,
			}, {
				activeInstanceId: 'instance-1',
				instanceIds: ['instance-1', 'instance-2'],
				sent: [
					'vscode:onBeforeUnload',
					'vscode:onShutdownPreparationAbandoned',
				],
				state: 'loading',
				reloadCalls: 1,
				closeCalls: [],
			});
		}
	);

	test('reloads when preparation rollback is not acknowledged', async () => {
		const alpha = createWorktree('alpha-rollback-timeout');
		const bravo = createWorktree('bravo-rollback-timeout');
		const { controller, ipcMain, viewFactory } = createController({
			beforeUnloadTimeoutMs: 5,
		});

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		await controller.openWorkspace(bravo, 'project-bravo');
		controller.notifyHostedWorkspaceReady('instance-2');
		await controller.openWorkspace(alpha, 'project-alpha');
		const hostedWebContents = viewFactory.views[0].rawWebContents;
		hostedWebContents.autoBeforeUnloadReply = false;
		hostedWebContents.autoPreparationRollbackReply = false;

		const closing = controller.closeWorkspace('instance-1');
		await Promise.resolve();
		const beforeUnload = hostedWebContents.sent[0].request as {
			okChannel: string;
		};
		await controller.openWorkspace(bravo, 'project-bravo');
		await controller.openWorkspace(alpha, 'project-alpha');
		ipcMain.emitReply(beforeUnload.okChannel);
		await closing;

		assert.strictEqual(hostedWebContents.reloadCalls.length, 1);
		assert.strictEqual(
			controller.getState().instances.find(instance =>
				instance.instanceId === 'instance-1'
			)?.state,
			'loading'
		);
	});

	for (const invalidReply of [
		{
			name: 'wrong preparation token',
			createReply: (preparationId: string) => ({
				preparationId: `${preparationId}:wrong`,
				disposition: 'applied',
			}),
		},
		{
			name: 'invalid disposition',
			createReply: (preparationId: string) => ({
				preparationId,
				disposition: 'invalid',
			}),
		},
	]) {
		test(`reloads after rollback reply with ${invalidReply.name}`,
			async () => {
				const alpha = createWorktree(
					`alpha-rollback-${invalidReply.name}`
				);
				const bravo = createWorktree(
					`bravo-rollback-${invalidReply.name}`
				);
				const { controller, ipcMain, viewFactory } = createController();

				await controller.openWorkspace(alpha, 'project-alpha');
				controller.notifyHostedWorkspaceReady('instance-1');
				await controller.openWorkspace(bravo, 'project-bravo');
				controller.notifyHostedWorkspaceReady('instance-2');
				await controller.openWorkspace(alpha, 'project-alpha');
				const hostedWebContents = viewFactory.views[0].rawWebContents;
				hostedWebContents.autoBeforeUnloadReply = false;
				hostedWebContents.autoPreparationRollbackReply = false;
				hostedWebContents.sendHook = (channel, request) => {
					if (channel !==
						'vscode:onShutdownPreparationAbandoned') {
						return false;
					}

					const rollback = request as {
						preparationId: string;
						replyChannel: string;
					};
					setTimeout(() => ipcMain.emitReply(
						rollback.replyChannel,
						invalidReply.createReply(rollback.preparationId)
					), 0);
					return true;
				};

				const closing = controller.closeWorkspace('instance-1');
				await Promise.resolve();
				const beforeUnload = hostedWebContents.sent[0].request as {
					okChannel: string;
				};
				await controller.openWorkspace(bravo, 'project-bravo');
				await controller.openWorkspace(alpha, 'project-alpha');
				ipcMain.emitReply(beforeUnload.okChannel);
				await closing;

				assert.strictEqual(hostedWebContents.reloadCalls.length, 1);
				assert.strictEqual(
					controller.getState().instances.find(instance =>
						instance.instanceId === 'instance-1'
					)?.state,
					'loading'
				);
			}
		);
	}

	test('settles rollback when the renderer is destroyed', async () => {
		const alpha = createWorktree('alpha-rollback-destroyed');
		const bravo = createWorktree('bravo-rollback-destroyed');
		const { controller, ipcMain, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		await controller.openWorkspace(bravo, 'project-bravo');
		controller.notifyHostedWorkspaceReady('instance-2');
		await controller.openWorkspace(alpha, 'project-alpha');
		const hostedWebContents = viewFactory.views[0].rawWebContents;
		hostedWebContents.autoBeforeUnloadReply = false;
		hostedWebContents.autoPreparationRollbackReply = false;
		hostedWebContents.sendHook = channel => {
			if (channel === 'vscode:onShutdownPreparationAbandoned') {
				setTimeout(() => hostedWebContents.close({
					waitForBeforeUnload: false,
				}), 0);
				return true;
			}
			return false;
		};

		const closing = controller.closeWorkspace('instance-1');
		await Promise.resolve();
		const beforeUnload = hostedWebContents.sent[0].request as {
			okChannel: string;
		};
		await controller.openWorkspace(bravo, 'project-bravo');
		await controller.openWorkspace(alpha, 'project-alpha');
		ipcMain.emitReply(beforeUnload.okChannel);
		await closing;

		const rollback = hostedWebContents.sent[1].request as {
			replyChannel: string;
		};
		assert.strictEqual(hostedWebContents.closeCalls.length, 1);
		assert.strictEqual(hostedWebContents.reloadCalls.length, 0);
		assert.strictEqual(ipcMain.listenerCount(rollback.replyChannel), 0);
		const recoveredInstance = controller.getState().instances.find(
			instance => instance.instanceId === 'instance-1'
		);
		assert.ok(recoveredInstance);
		assert.deepStrictEqual({
			state: recoveredInstance.state,
			focused: recoveredInstance.focused,
			visible: recoveredInstance.visible,
			processId: recoveredInstance.processId,
			webContentsId: recoveredInstance.webContentsId,
		}, {
			state: 'crashed',
			focused: false,
			visible: false,
			processId: undefined,
			webContentsId: undefined,
		});
	});

	test('an older unload cannot roll back a newer preparation', async () => {
		const alpha = createWorktree('alpha-overlapping-preparation');
		const bravo = createWorktree('bravo-overlapping-preparation');
		const { controller, ipcMain, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		await controller.openWorkspace(bravo, 'project-bravo');
		controller.notifyHostedWorkspaceReady('instance-2');
		await controller.openWorkspace(alpha, 'project-alpha');
		const hostedWebContents = viewFactory.views[0].rawWebContents;
		hostedWebContents.autoBeforeUnloadReply = false;
		hostedWebContents.autoPreparationRollbackReply = false;
		hostedWebContents.sendHook = (channel, request) => {
			if (channel === 'vscode:onWillUnload') {
				return true;
			}
			if (channel === 'vscode:onShutdownPreparationAbandoned') {
				const rollback = request as {
					preparationId: string;
					replyChannel?: string;
				};
				if (rollback.replyChannel) {
					setTimeout(() => ipcMain.emitReply(
						rollback.replyChannel!,
						{
							preparationId: rollback.preparationId,
							disposition: 'stale',
						}
					), 0);
				}
				return true;
			}
			return false;
		};
		const firstClose = controller.closeWorkspace('instance-1');
		await Promise.resolve();
		const firstPreparation = hostedWebContents.sent[0].request as {
			okChannel: string;
			preparationId?: string;
		};

		await controller.openWorkspace(bravo, 'project-bravo');
		await controller.openWorkspace(alpha, 'project-alpha');
		const secondClose = controller.closeWorkspace('instance-1');
		await Promise.resolve();
		const secondPreparation = hostedWebContents.sent[1].request as {
			okChannel: string;
			preparationId?: string;
		};
		ipcMain.emitReply(secondPreparation.okChannel);
		await Promise.resolve();
		const willUnload = hostedWebContents.sent[2].request as {
			replyChannel: string;
		};

		ipcMain.emitReply(firstPreparation.okChannel);
		await firstClose;

		assert.ok(firstPreparation.preparationId);
		assert.ok(secondPreparation.preparationId);
		assert.notStrictEqual(
			firstPreparation.preparationId,
			secondPreparation.preparationId
		);
		const rollbackRequest = hostedWebContents.sent[3].request as {
			preparationId: string;
			replyChannel?: string;
		};
		assert.strictEqual(
			hostedWebContents.sent[3].channel,
			'vscode:onShutdownPreparationAbandoned'
		);
		assert.strictEqual(
			rollbackRequest.preparationId,
			firstPreparation.preparationId
		);
		assert.ok(rollbackRequest.replyChannel);
		assert.strictEqual(hostedWebContents.reloadCalls.length, 0);

		ipcMain.emitReply(willUnload.replyChannel);
		await secondClose;
	});

	test('reloads a workspace reactivated during will-unload', async () => {
		const alpha = createWorktree('alpha-reactivated-after-will');
		const bravo = createWorktree('bravo-reactivated-after-will');
		const { controller, ipcMain, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		await controller.openWorkspace(bravo, 'project-bravo');
		controller.notifyHostedWorkspaceReady('instance-2');
		await controller.openWorkspace(alpha, 'project-alpha');
		const willUnload = new DeferredPromise<{ replyChannel: string }>();
		viewFactory.views[0].rawWebContents.sendHook = (channel, request) => {
			if (channel === 'vscode:onBeforeUnload') {
				const { okChannel } = request as { okChannel: string };
				setTimeout(() => ipcMain.emitReply(okChannel), 0);
			}
			if (channel === 'vscode:onWillUnload') {
				willUnload.complete(request as { replyChannel: string });
			}
			return true;
		};

		const closing = controller.closeWorkspace('instance-1');
		const willUnloadRequest = await willUnload.p;
		await controller.openWorkspace(bravo, 'project-bravo');
		await controller.openWorkspace(alpha, 'project-alpha');
		ipcMain.emitReply(willUnloadRequest.replyChannel);
		await closing;

		assert.deepStrictEqual({
			activeInstanceId: controller.getState().activeInstanceId,
			state: controller.getState().instances.find(instance =>
				instance.instanceId === 'instance-1'
			)?.state,
			sent: viewFactory.views[0].rawWebContents.sent.map(
				item => item.channel
			),
			reloadCalls: viewFactory.views[0].rawWebContents.reloadCalls.length,
			closeCalls: viewFactory.views[0].rawWebContents.closeCalls,
		}, {
			activeInstanceId: 'instance-1',
			state: 'loading',
			sent: ['vscode:onBeforeUnload', 'vscode:onWillUnload'],
			reloadCalls: 1,
			closeCalls: [],
		});
	});

	test('reloads a loading workspace reactivated during will-unload',
		async () => {
			const alpha = createWorktree('alpha-loading-reactivated-after-will');
			const bravo = createWorktree('bravo-loading-reactivated-after-will');
			const { controller, ipcMain, viewFactory } = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');
			await controller.openWorkspace(alpha, 'project-alpha');
			const willUnload = new DeferredPromise<{ replyChannel: string }>();
			viewFactory.views[0].rawWebContents.sendHook = (channel, request) => {
				if (channel === 'vscode:onBeforeUnload') {
					const { okChannel } = request as { okChannel: string };
					setTimeout(() => ipcMain.emitReply(okChannel), 0);
				}
				if (channel === 'vscode:onWillUnload') {
					willUnload.complete(request as { replyChannel: string });
				}
				return true;
			};

			const closing = controller.closeWorkspace('instance-1');
			const willUnloadRequest = await willUnload.p;
			await controller.openWorkspace(bravo, 'project-bravo');
			await controller.openWorkspace(alpha, 'project-alpha');
			ipcMain.emitReply(willUnloadRequest.replyChannel);
			await closing;

			assert.strictEqual(
				viewFactory.views[0].rawWebContents.reloadCalls.length,
				1
			);
		}
	);

	test('overlapping closes destroy a workspace once', async () => {
		const alpha = createWorktree('alpha-overlapping-close');
		const { controller, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');

		await Promise.all([
			controller.closeWorkspace('instance-1'),
			controller.closeWorkspace('instance-1'),
		]);

		assert.strictEqual(controller.getState().instances.length, 0);
		assert.strictEqual(
			viewFactory.views[0].rawWebContents.closeCalls.length,
			1
		);
	});

	test('closing an old active workspace preserves newer activation', async () => {
		const alpha = createWorktree('alpha-newer-activation');
		const bravo = createWorktree('bravo-newer-activation');
		const { controller, ipcMain, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		await controller.openWorkspace(bravo, 'project-bravo');
		controller.notifyHostedWorkspaceReady('instance-2');
		await controller.openWorkspace(alpha, 'project-alpha');
		viewFactory.views[0].rawWebContents.autoBeforeUnloadReply = false;

		const closing = controller.closeWorkspace('instance-1');
		await Promise.resolve();
		const beforeUnload = viewFactory.views[0].rawWebContents.sent[0]
			.request as { okChannel: string };
		await controller.openWorkspace(bravo, 'project-bravo');
		ipcMain.emitReply(beforeUnload.okChannel);
		await closing;

		assert.deepStrictEqual({
			activeInstanceId: controller.getState().activeInstanceId,
			instances: controller.getState().instances.map(instance => ({
				instanceId: instance.instanceId,
				state: instance.state,
			})),
		}, {
			activeInstanceId: 'instance-2',
			instances: [{ instanceId: 'instance-2', state: 'active' }],
		});
	});

	test('switching workspaces hides inactive BrowserViews and raises active',
		async () => {
			const alpha = createWorktree('alpha');
			const bravo = createWorktree('bravo');
			const { browserViewMainService, controller, viewFactory, window } =
				createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			now = 2000;
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');
			now = 3000;
			await controller.openWorkspace(alpha, 'project-alpha');

			assert.deepStrictEqual(browserViewMainService.visibleCalls.slice(-2), [
				{ id: 2, visible: false },
				{ id: 1, visible: true },
			]);
			assert.strictEqual(browserViewMainService.frontCalls.at(-1), 1);
			assert.deepStrictEqual(
				(window.win as unknown as TestBrowserWindow).contentView.children
					.map(view => view.webContents.id),
				[1]
			);

			now = 4000;
			const bravoInvalidateCallsBefore =
				viewFactory.views[1].rawWebContents.invalidateCalls.length;
			await controller.openWorkspace(bravo, 'project-bravo');

			assert.deepStrictEqual(browserViewMainService.visibleCalls.slice(-2), [
				{ id: 1, visible: false },
				{ id: 2, visible: true },
			]);
			assert.deepStrictEqual(
				(window.win as unknown as TestBrowserWindow).contentView.children
					.map(view => view.webContents.id),
				[2]
			);
			assert.strictEqual(
				viewFactory.views[1].rawWebContents.invalidateCalls.length,
				bravoInvalidateCallsBefore + 1
			);
		});

	test('opening a new active workspace reconciles stale active views',
		async () => {
			const alpha = createWorktree('alpha');
			const bravo = createWorktree('bravo');
			const { browserViewMainService, controller, viewFactory, window } =
				createController();
			const browserWindow = window.win as unknown as TestBrowserWindow;

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			now = 2000;
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');

			assert.deepStrictEqual(controller.getState().instances.map(instance => ({
				worktreePath: instance.worktreePath,
				state: instance.state,
				visible: instance.visible,
			})), [
				{ worktreePath: bravo, state: 'active', visible: true },
				{ worktreePath: alpha, state: 'loaded', visible: false },
			]);
			assert.deepStrictEqual(
				(browserWindow.contentView.children as IHostedWorkbenchView[])
					.map(view => view.webContents.id),
				[2]
			);
			assert.deepStrictEqual(viewFactory.views[0].visibleCalls.slice(-1), [
				false,
			]);
			assert.deepStrictEqual(
				browserViewMainService.visibleCalls.slice(-2),
				[
					{ id: 1, visible: false },
					{ id: 2, visible: true },
				]
			);
		});

	test('overlay occlusion restores active workspace with repaint',
		async () => {
			const alpha = createWorktree('alpha');
			const {
				browserViewMainService,
				controller,
				viewFactory,
				window,
			} = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			controller.layout({ x: 280, y: 0, width: 1000, height: 800 });

			const browserWindow = window.win as unknown as TestBrowserWindow;
			const view = viewFactory.views[0];
			const removedBefore = browserWindow.contentView.removed.length;
			const boundsBefore = view.boundsCalls.length;
			const invalidateCallsBefore = view.rawWebContents.invalidateCalls.length;

			controller.setWorkspaceOverlayOcclusion(true);

			assert.deepStrictEqual(view.visibleCalls.slice(-1), [false]);
			assert.strictEqual(
				browserWindow.contentView.removed.length,
				removedBefore + 1
			);
			assert.deepStrictEqual(
				browserViewMainService.visibleCalls.at(-1),
				{ id: 1, visible: false }
			);
			assert.strictEqual(
				view.rawWebContents.invalidateCalls.length,
				invalidateCallsBefore
			);

			controller.setWorkspaceOverlayOcclusion(false);

			assert.deepStrictEqual(view.visibleCalls.slice(-1), [true]);
			assert.deepStrictEqual(view.boundsCalls.slice(boundsBefore), [{
				x: 280,
				y: 0,
				width: 1000,
				height: 800,
			}]);
			assert.deepStrictEqual(
				browserViewMainService.visibleCalls.at(-1),
				{ id: 1, visible: true }
			);
			assert.strictEqual(browserViewMainService.frontCalls.at(-1), 1);
			assert.strictEqual(
				view.rawWebContents.invalidateCalls.length,
				invalidateCallsBefore + 1
			);
		});

	test('closing active workspace under overlay keeps MRU hidden until clear',
		async () => {
			const alpha = createWorktree('alpha');
			const bravo = createWorktree('bravo');
			const { browserViewMainService, controller, viewFactory, window } =
				createController();
			const browserWindow = window.win as unknown as TestBrowserWindow;

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			now = 2000;
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');
			now = 3000;
			await controller.openWorkspace(alpha, 'project-alpha');

			controller.setWorkspaceOverlayOcclusion(true);
			await controller.closeWorkspace('instance-1');

			assert.deepStrictEqual(controller.getState().instances.map(instance => ({
				worktreePath: instance.worktreePath,
				state: instance.state,
				visible: instance.visible,
			})), [
				{ worktreePath: bravo, state: 'active', visible: true },
			]);
			assert.deepStrictEqual(browserWindow.contentView.children, []);
			assert.deepStrictEqual(viewFactory.views[1].visibleCalls.slice(-1), [
				false,
			]);
			assert.deepStrictEqual(
				browserViewMainService.visibleCalls.at(-1),
				{ id: 2, visible: false }
			);

			controller.setWorkspaceOverlayOcclusion(false);

			assert.deepStrictEqual(
				(browserWindow.contentView.children as IHostedWorkbenchView[])
					.map(view => view.webContents.id),
				[2]
			);
			assert.deepStrictEqual(viewFactory.views[1].visibleCalls.slice(-1), [
				true,
			]);
			assert.deepStrictEqual(
				browserViewMainService.visibleCalls.at(-1),
				{ id: 2, visible: true }
			);
		});

	test('repeated overlay occlusion reconciles promoted active workspace',
		async () => {
			const alpha = createWorktree('alpha');
			const bravo = createWorktree('bravo');
			const { browserViewMainService, controller, viewFactory, window } =
				createController();
			const browserWindow = window.win as unknown as TestBrowserWindow;

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			now = 2000;
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');
			now = 3000;
			await controller.openWorkspace(alpha, 'project-alpha');

			controller.setWorkspaceOverlayOcclusion(true);
			await controller.closeWorkspace('instance-1');
			controller.setWorkspaceOverlayOcclusion(true);

			assert.deepStrictEqual(browserWindow.contentView.children, []);
			assert.deepStrictEqual(viewFactory.views[1].visibleCalls.slice(-1), [
				false,
			]);
			assert.deepStrictEqual(
				browserViewMainService.visibleCalls.at(-1),
				{ id: 2, visible: false }
			);
		});

	test('closing inactive workspace cleans up its BrowserViews and trust',
		async () => {
			const alpha = createWorktree('alpha');
			const bravo = createWorktree('bravo');
			const {
				browserViewMainService,
				controller,
				untrustedProcessIds,
				untrustedWebContentsIds,
				viewFactory,
			} = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			now = 2000;
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');
			await controller.closeWorkspace('instance-1');

			assert.deepStrictEqual(
				browserViewMainService.destroyedHostedWebContentsIds,
				[1]
			);
			assert.deepStrictEqual(untrustedWebContentsIds, [1]);
			assert.deepStrictEqual(untrustedProcessIds, [1001]);
			assert.deepStrictEqual(viewFactory.views[0].visibleCalls.slice(-1), [
				false,
			]);
			assert.deepStrictEqual(controller.getState().instances.map(instance => ({
				worktreePath: instance.worktreePath,
				state: instance.state,
				visible: instance.visible,
			})), [
				{ worktreePath: bravo, state: 'active', visible: true },
			]);
		});

	test('closing last workspace restores hidden projects sidebar', async () => {
		const alpha = createWorktree('alpha');
		const { controller } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		controller.setProjectsSidebarVisible(false);

		assert.strictEqual(controller.getState().projectsSidebarVisible, false);

		await controller.closeWorkspace();

		assert.strictEqual(controller.getState().projectsSidebarVisible, true);
		assert.strictEqual(controller.getState().instances.length, 0);
	});

	test('shutdown ignores unload veto after will-unload handoff', async () => {
		const alpha = createWorktree('alpha');
		const { controller, ipcMain, viewFactory } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		viewFactory.views[0].rawWebContents.sendHook = (channel, request) => {
			if (channel === 'vscode:onBeforeUnload') {
				const { cancelChannel } = request as { cancelChannel: string };
				setTimeout(() => ipcMain.emitReply(cancelChannel), 0);
			}
			if (channel === 'vscode:onWillUnload') {
				const { replyChannel } = request as { replyChannel: string };
				setTimeout(() => ipcMain.emitReply(replyChannel), 0);
			}
			return true;
		};

		await controller.closeWorkspace();
		assert.strictEqual(controller.getState().instances.length, 1);

		await controller.shutdownAllWorkspaces(UnloadReason.QUIT);
		assert.deepStrictEqual(
			viewFactory.views[0].rawWebContents.sent.map(item => item.channel),
			[
				'vscode:onBeforeUnload',
				'vscode:onBeforeUnload',
				'vscode:onWillUnload',
			]
		);
		assert.strictEqual(controller.getState().instances[0].state, 'unloaded');
	});

	test('shutdown times out silent renderer phases and destroys the view',
		async () => {
			const alpha = createWorktree('alpha');
			const {
				browserViewMainService,
				controller,
				logService,
				viewFactory,
			} = createController({
				beforeUnloadTimeoutMs: 5,
				willUnloadTimeoutMs: 5,
			});

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			viewFactory.views[0].rawWebContents.sendHook = () => true;

			await controller.shutdownAllWorkspaces(UnloadReason.QUIT);

			assert.deepStrictEqual(
				viewFactory.views[0].rawWebContents.sent.map(item =>
					item.channel),
				['vscode:onBeforeUnload', 'vscode:onWillUnload']
			);
			assert.deepStrictEqual(logService.warnings, [
				'[HucodeShellMainService] Timed out waiting for hosted ' +
				`workspace before-unload reply for ${alpha}.`,
				'[HucodeShellMainService] Timed out waiting for hosted ' +
				`workspace will-unload reply for ${alpha}.`,
			]);
			assert.deepStrictEqual(
				browserViewMainService.destroyedHostedWebContentsIds,
				[1]
			);
			assert.strictEqual(
				controller.getState().instances[0].state,
				'unloaded'
			);
		}
	);

	test('failed shutdown settles the batch and retries partial native cleanup',
		async () => {
			const paths = [
				createWorktree('alpha'),
				createWorktree('bravo'),
				createWorktree('charlie'),
			];
			const {
				browserViewMainService,
				controller,
				ipcMain,
				protocolMainService,
				viewFactory,
			} = createController();
			const phasesByWebContentsId = new Map<number, string[]>();
			for (const [index, path] of paths.entries()) {
				await controller.openWorkspace(path, `project-${index + 1}`);
				controller.notifyHostedWorkspaceReady(`instance-${index + 1}`);
				const view = viewFactory.views[index].rawWebContents;
				const phases: string[] = [];
				phasesByWebContentsId.set(view.id, phases);
				view.sendHook = (channel, request) => {
					if (channel === 'vscode:onBeforeUnload') {
						phases.push('prepare');
						const { okChannel } = request as { okChannel: string };
						ipcMain.emitReply(okChannel);
						return true;
					}
					if (channel === 'vscode:onWillUnload') {
						phases.push('commit');
						const { replyChannel } = request as {
							replyChannel: string;
						};
						ipcMain.emitReply(replyChannel);
						return true;
					}
					return false;
				};
			}

			const firstFailure = new Error('alpha native teardown failed');
			const laterFailure = new Error('bravo config disposal failed');
			browserViewMainService.failNextDestroyHostedWebContents(
				1,
				firstFailure
			);
			protocolMainService.objectUrls[1].failNextDispose(laterFailure);
			const firstShutdown = controller.shutdownAllWorkspaces(
				UnloadReason.QUIT
			);
			assert.strictEqual(
				controller.shutdownAllWorkspaces(UnloadReason.QUIT),
				firstShutdown
			);
			await assert.rejects(firstShutdown, error => {
				assert.strictEqual(error, firstFailure);
				return true;
			});

			assert.deepStrictEqual(
				[...phasesByWebContentsId.values()],
				[
					['prepare', 'commit'],
					['prepare', 'commit'],
					['prepare', 'commit'],
				]
			);
			assert.deepStrictEqual(
				browserViewMainService.destroyHostedWebContentsAttempts,
				[1, 2, 3]
			);
			assert.deepStrictEqual(
				browserViewMainService.destroyedHostedWebContentsIds,
				[2, 3]
			);
			assert.deepStrictEqual(
				protocolMainService.objectUrls.map(objectUrl => ({
					disposeCalls: objectUrl.disposeCalls,
					disposed: objectUrl.disposed,
				})),
				[
					{ disposeCalls: 0, disposed: false },
					{ disposeCalls: 1, disposed: false },
					{ disposeCalls: 1, disposed: true },
				]
			);
			assert.strictEqual(
				viewFactory.views[0].rawWebContents.isDestroyed(),
				false
			);
			assert.strictEqual(
				viewFactory.views[1].rawWebContents.isDestroyed(),
				true
			);

			const retry = controller.shutdownAllWorkspaces(UnloadReason.QUIT);
			assert.notStrictEqual(retry, firstShutdown);
			assert.strictEqual(
				controller.shutdownAllWorkspaces(UnloadReason.QUIT),
				retry
			);
			await retry;
			assert.deepStrictEqual(
				browserViewMainService.destroyHostedWebContentsAttempts,
				[1, 2, 3, 1]
			);
			assert.deepStrictEqual(
				browserViewMainService.destroyedHostedWebContentsIds,
				[2, 3, 1]
			);
			assert.deepStrictEqual(
				protocolMainService.objectUrls.map(objectUrl => ({
					disposeCalls: objectUrl.disposeCalls,
					disposed: objectUrl.disposed,
				})),
				[
					{ disposeCalls: 1, disposed: true },
					{ disposeCalls: 2, disposed: true },
					{ disposeCalls: 1, disposed: true },
				]
			);
			assert.deepStrictEqual(
				[...phasesByWebContentsId.values()],
				[
					['prepare', 'commit'],
					['prepare', 'commit'],
					['prepare', 'commit'],
				]
			);

			const cached = controller.shutdownAllWorkspaces(UnloadReason.QUIT);
			assert.strictEqual(cached, retry);
			await cached;
			assert.deepStrictEqual(
				browserViewMainService.destroyHostedWebContentsAttempts,
				[1, 2, 3, 1]
			);
		}
	);

	test('shutdown isolates a renderer handshake registration failure',
		async () => {
			const paths = [
				createWorktree('alpha'),
				createWorktree('bravo'),
				createWorktree('charlie'),
			];
			const {
				browserViewMainService,
				controller,
				ipcMain,
				viewFactory,
			} = createController();
			for (const [index, path] of paths.entries()) {
				await controller.openWorkspace(path, `project-${index + 1}`);
				controller.notifyHostedWorkspaceReady(`instance-${index + 1}`);
			}

			const failure = new Error('reply registration failed');
			ipcMain.failNextOnceRegistration(failure);
			const shutdown = controller.shutdownAllWorkspaces(
				UnloadReason.QUIT
			);
			await assert.rejects(shutdown, error => {
				assert.strictEqual(error, failure);
				return true;
			});

			assert.deepStrictEqual(
				viewFactory.views.map(view =>
					view.rawWebContents.sent.map(item => item.channel)),
				[
					[],
					['vscode:onBeforeUnload', 'vscode:onWillUnload'],
					['vscode:onBeforeUnload', 'vscode:onWillUnload'],
				]
			);
			assert.deepStrictEqual(
				browserViewMainService.destroyHostedWebContentsAttempts,
				[1, 2, 3]
			);
			assert.deepStrictEqual(
				browserViewMainService.destroyedHostedWebContentsIds,
				[1, 2, 3]
			);

			const retry = controller.shutdownAllWorkspaces(UnloadReason.QUIT);
			assert.notStrictEqual(retry, shutdown);
			await retry;
			assert.deepStrictEqual(
				browserViewMainService.destroyHostedWebContentsAttempts,
				[1, 2, 3]
			);
		}
	);

	test('shutdown prevents a late public workspace open', async () => {
		const alpha = createWorktree('alpha');
		const late = createWorktree('late');
		const {
			controller,
			ipcMain,
			stateChanges,
			viewFactory,
		} = createController();
		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		let releasePreparation: (() => void) | undefined;
		viewFactory.views[0].rawWebContents.sendHook = (channel, request) => {
			if (channel !== 'vscode:onBeforeUnload') {
				return false;
			}
			const { okChannel } = request as { okChannel: string };
			releasePreparation = () => ipcMain.emitReply(okChannel);
			return true;
		};

		const shutdown = controller.shutdownAllWorkspaces(UnloadReason.QUIT);
		for (let attempt = 0;
			attempt < 20 && !releasePreparation;
			attempt++
		) {
			await Promise.resolve();
		}
		assert.ok(releasePreparation);
		const stateBeforeLateOpen = structuredClone(controller.getState());
		const stateChangeCountBeforeLateOpen = stateChanges.length;
		const viewCountBeforeLateOpen = viewFactory.views.length;

		await controller.openWorkspace(late, 'project-late');

		assert.deepStrictEqual(controller.getState(), stateBeforeLateOpen);
		assert.strictEqual(
			stateChanges.length,
			stateChangeCountBeforeLateOpen
		);
		assert.strictEqual(viewFactory.views.length, viewCountBeforeLateOpen);

		releasePreparation();
		await shutdown;
		assert.strictEqual(
			controller.getState().instances.some(instance =>
				instance.worktreePath === late
			),
			false
		);
	});

	test('reload and load shutdown allow later workspace opens', async () => {
		for (const [reason, suffix] of [
			[UnloadReason.RELOAD, 'reload'],
			[UnloadReason.LOAD, 'load'],
		] as const) {
			const alpha = createWorktree(`${suffix}-alpha`);
			const bravo = createWorktree(`${suffix}-bravo`);
			const charlie = createWorktree(`${suffix}-charlie`);
			const {
				browserViewMainService,
				controller,
				viewFactory,
			} = createController();
			await controller.openWorkspace(alpha, `project-${suffix}-alpha`);
			controller.notifyHostedWorkspaceReady('instance-1');

			const firstShutdown = controller.shutdownAllWorkspaces(reason);
			assert.strictEqual(
				controller.shutdownAllWorkspaces(reason),
				firstShutdown
			);
			await firstShutdown;
			await controller.openWorkspace(bravo, `project-${suffix}-bravo`);
			controller.notifyHostedWorkspaceReady('instance-2');

			assert.strictEqual(viewFactory.views.length, 2);
			assert.strictEqual(
				controller.getState().instances.find(instance =>
					instance.worktreePath === bravo
				)?.state,
				'active'
			);

			const secondShutdown = controller.shutdownAllWorkspaces(reason);
			assert.notStrictEqual(secondShutdown, firstShutdown);
			assert.strictEqual(
				controller.shutdownAllWorkspaces(reason),
				secondShutdown
			);
			await secondShutdown;
			assert.deepStrictEqual(
				browserViewMainService.destroyedHostedWebContentsIds,
				[1, 2]
			);
			assert.strictEqual(
				viewFactory.views[1].rawWebContents.isDestroyed(),
				true
			);
			assert.strictEqual(
				controller.getState().instances.find(instance =>
					instance.worktreePath === bravo
				)?.state,
				'unloaded'
			);

			await controller.openWorkspace(charlie, `project-${suffix}-charlie`);
			controller.notifyHostedWorkspaceReady('instance-3');
			assert.strictEqual(viewFactory.views.length, 3);
			assert.strictEqual(
				controller.getState().instances.find(instance =>
					instance.worktreePath === charlie
				)?.state,
				'active'
			);
		}
	});

	test('close and quit shutdown keep later workspace opens blocked',
		async () => {
			for (const [reason, suffix] of [
				[UnloadReason.CLOSE, 'close'],
				[UnloadReason.QUIT, 'quit'],
			] as const) {
				const alpha = createWorktree(`${suffix}-alpha`);
				const blocked = createWorktree(`${suffix}-blocked`);
				const { controller, viewFactory } = createController();
				await controller.openWorkspace(alpha, `project-${suffix}`);
				controller.notifyHostedWorkspaceReady('instance-1');
				await controller.shutdownAllWorkspaces(reason);
				const frozenState = structuredClone(controller.getState());
				const frozenViewCount = viewFactory.views.length;

				await controller.openWorkspace(blocked, 'project-blocked');

				assert.deepStrictEqual(controller.getState(), frozenState);
				assert.strictEqual(viewFactory.views.length, frozenViewCount);
			}
		}
	);

	test('terminal shutdown dominates overlapping surviving reasons',
		async () => {
			for (const [
				firstReason,
				secondReason,
				expectedReasons,
				expectedPreparationChannels,
				suffix
			] of [
				[
					UnloadReason.RELOAD,
					UnloadReason.QUIT,
					[
						UnloadReason.RELOAD,
						UnloadReason.QUIT,
						UnloadReason.QUIT
					],
					[
						'vscode:onBeforeUnload',
						'vscode:onShutdownPreparationAbandoned',
						'vscode:onBeforeUnload',
						'vscode:onWillUnload'
					],
					'reload-then-quit'
				],
				[
					UnloadReason.CLOSE,
					UnloadReason.LOAD,
					[UnloadReason.CLOSE, UnloadReason.CLOSE],
					[
						'vscode:onBeforeUnload',
						'vscode:onWillUnload'
					],
					'close-then-load'
				],
			] as const) {
				const alpha = createWorktree(`${suffix}-alpha`);
				const blocked = createWorktree(`${suffix}-blocked`);
				const {
					controller,
					ipcMain,
					viewFactory,
				} = createController();
				await controller.openWorkspace(alpha, `project-${suffix}`);
				controller.notifyHostedWorkspaceReady('instance-1');
				let releasePreparation: (() => void) | undefined;
				let preparationCount = 0;
				viewFactory.views[0].rawWebContents.sendHook =
					(channel, request) => {
						if (channel !== 'vscode:onBeforeUnload') {
							return false;
						}
						if (preparationCount++ > 0) {
							return false;
						}
						const { okChannel } = request as { okChannel: string };
						releasePreparation = () => ipcMain.emitReply(okChannel);
						return true;
					};

				const firstShutdown =
					controller.shutdownAllWorkspaces(firstReason);
				for (let attempt = 0;
					attempt < 20 && !releasePreparation;
					attempt++
				) {
					await Promise.resolve();
				}
				assert.ok(releasePreparation);
				assert.strictEqual(
					controller.shutdownAllWorkspaces(secondReason),
					firstShutdown
				);
				releasePreparation();
				await firstShutdown;
				assert.deepStrictEqual(
					viewFactory.views[0].rawWebContents.sent
						.filter(({ channel }) =>
							channel === 'vscode:onBeforeUnload' ||
							channel === 'vscode:onWillUnload'
						)
						.map(({ request }) =>
							(request as { reason: UnloadReason }).reason
						),
					expectedReasons
				);
				const preparationMessages =
					viewFactory.views[0].rawWebContents.sent.filter(
						({ channel }) =>
							channel === 'vscode:onBeforeUnload' ||
							channel ===
							'vscode:onShutdownPreparationAbandoned' ||
							channel === 'vscode:onWillUnload'
					);
				assert.deepStrictEqual(
					preparationMessages.map(({ channel }) => channel),
					expectedPreparationChannels
				);
				const abandonmentIndex = preparationMessages.findIndex(
					({ channel }) =>
						channel === 'vscode:onShutdownPreparationAbandoned'
				);
				if (abandonmentIndex !== -1) {
					assert.strictEqual(
						(
							preparationMessages[abandonmentIndex].request as {
								preparationId: string;
							}
						).preparationId,
						(
							preparationMessages[abandonmentIndex - 1].request as {
								preparationId: string;
							}
						).preparationId
					);
					assert.notStrictEqual(
						(
							preparationMessages[abandonmentIndex + 1].request as {
								preparationId: string;
							}
						).preparationId,
						(
							preparationMessages[abandonmentIndex - 1].request as {
								preparationId: string;
							}
						).preparationId
					);
				}
				const frozenState = structuredClone(controller.getState());
				const frozenViewCount = viewFactory.views.length;

				await controller.openWorkspace(blocked, 'project-blocked');

				assert.deepStrictEqual(controller.getState(), frozenState);
				assert.strictEqual(viewFactory.views.length, frozenViewCount);
				assert.strictEqual(
					controller.shutdownAllWorkspaces(UnloadReason.RELOAD),
					firstShutdown
				);
			}
		}
	);

	test('shutdown prevents a held restore from resuming attachment', async () => {
		const alpha = createWorktree('restore-alpha');
		const bravo = createWorktree('restore-bravo');
		const heldLoad = new DeferredPromise<void>();
		const { controller, viewFactory } = createController({
			activeWorktreePath: alpha,
			loadUrlPromises: [heldLoad.p],
			restoreEntries: [{
				projectId: 'project-alpha',
				worktreePath: alpha,
				state: 'active',
			}, {
				projectId: 'project-bravo',
				worktreePath: bravo,
				state: 'loaded',
			}],
			restorePolicy: 'all',
		});

		const restore = controller.ensureRestored();
		for (let attempt = 0;
			attempt < 20 && viewFactory.views.length < 1;
			attempt++
		) {
			await Promise.resolve();
		}
		assert.strictEqual(viewFactory.views.length, 1);
		await controller.shutdownAllWorkspaces(UnloadReason.QUIT);
		const stateAfterShutdown = structuredClone(controller.getState());

		heldLoad.complete();
		await restore;

		assert.strictEqual(viewFactory.views.length, 1);
		assert.deepStrictEqual(controller.getState(), stateAfterShutdown);
		assert.strictEqual(
			controller.getState().instances.some(instance =>
				instance.state !== 'unloaded'
			),
			false
		);
	});

	test('held load rejection preserves frozen shutdown state', async () => {
		const alpha = createWorktree('reject-alpha');
		const heldLoad = new DeferredPromise<void>();
		const loadError = new Error('held load failed');
		const {
			controller,
			stateChanges,
			viewFactory,
		} = createController({
			loadUrlErrors: [loadError],
			loadUrlPromises: [heldLoad.p],
		});

		const open = controller.openWorkspace(alpha, 'project-alpha');
		for (let attempt = 0;
			attempt < 20 && viewFactory.views.length < 1;
			attempt++
		) {
			await Promise.resolve();
		}
		assert.strictEqual(viewFactory.views.length, 1);
		await controller.shutdownAllWorkspaces(UnloadReason.QUIT);
		const frozenState = structuredClone(controller.getState());
		const frozenActiveInstanceId = controller.getState().activeInstanceId;
		const frozenStateChangeCount = stateChanges.length;
		const rejectedOpen = assert.rejects(open, error => {
			assert.strictEqual(error, loadError);
			return true;
		});

		heldLoad.complete();
		await rejectedOpen;

		assert.deepStrictEqual(controller.getState(), frozenState);
		assert.strictEqual(
			controller.getState().activeInstanceId,
			frozenActiveInstanceId
		);
		assert.strictEqual(stateChanges.length, frozenStateChangeCount);
	});

	test('held attach settlement after reload preserves frozen state',
		async () => {
			for (const outcome of ['fulfilled', 'rejected'] as const) {
				const alpha = createWorktree(`reload-held-${outcome}`);
				const heldLoad = new DeferredPromise<void>();
				const loadError = new Error(`${outcome} held load failed`);
				const {
					controller,
					stateChanges,
					viewFactory,
				} = createController({
					loadUrlErrors: outcome === 'rejected' ? [loadError] : [],
					loadUrlPromises: [heldLoad.p],
				});

				const open = controller.openWorkspace(
					alpha,
					`project-${outcome}`
				);
				for (let attempt = 0;
					attempt < 20 && viewFactory.views.length < 1;
					attempt++
				) {
					await Promise.resolve();
				}
				assert.strictEqual(viewFactory.views.length, 1);
				await controller.shutdownAllWorkspaces(UnloadReason.RELOAD);
				const frozenState = structuredClone(controller.getState());
				const frozenActiveInstanceId =
					controller.getState().activeInstanceId;
				const frozenStateChangeCount = stateChanges.length;
				const frozenViewCount = viewFactory.views.length;
				const settlement = outcome === 'rejected'
					? assert.rejects(open, error => {
						assert.strictEqual(error, loadError);
						return true;
					})
					: open;

				heldLoad.complete();
				await settlement;

				assert.deepStrictEqual(controller.getState(), frozenState);
				assert.strictEqual(
					controller.getState().activeInstanceId,
					frozenActiveInstanceId
				);
				assert.strictEqual(
					stateChanges.length,
					frozenStateChangeCount
				);
				assert.strictEqual(viewFactory.views.length, frozenViewCount);
			}
		}
	);

	test('shutdown preserves the resident workspace restore snapshot', async () => {
		const alpha = createWorktree('alpha');
		const scratch = createWorktree('scratch');
		const { controller, viewFactory, window } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		await controller.retainAndOpenWorkbench(URI.file(scratch));
		controller.notifyHostedWorkspaceReady('instance-2');
		viewFactory.views[1].blurWhenHidden = true;
		viewFactory.views[1].rawWebContents.focus();

		const restoreSnapshot = structuredClone(
			window.config?.omniResidentWorkspaces
		);
		assert.strictEqual(restoreSnapshot?.[0].state, 'loaded');

		await controller.shutdownAllWorkspaces(UnloadReason.QUIT);

		assert.deepStrictEqual(
			window.config?.omniResidentWorkspaces,
			restoreSnapshot
		);
		assert.strictEqual(window.config?.omniActiveWorktreePath, scratch);
	});

	test('render process gone marks workspace crashed and clears trust', async () => {
		const alpha = createWorktree('alpha');
		const {
			browserViewMainService,
			controller,
			trustedProcessIds,
			trustedWebContentsIds,
			untrustedProcessIds,
			untrustedWebContentsIds,
			viewFactory,
		} = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		controller.setProjectsSidebarVisible(false);

		assert.strictEqual(controller.getState().projectsSidebarVisible, false);

		viewFactory.views[0].rawWebContents.emit('render-process-gone');

		assert.strictEqual(controller.getState().projectsSidebarVisible, true);
		assert.deepStrictEqual(
			browserViewMainService.destroyedHostedWebContentsIds,
			[1]
		);
		assert.deepStrictEqual(trustedWebContentsIds, [1]);
		assert.deepStrictEqual(trustedProcessIds, [1001]);
		assert.deepStrictEqual(untrustedWebContentsIds, [1]);
		assert.deepStrictEqual(untrustedProcessIds, [1001]);
		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			worktreePath: instance.worktreePath,
			state: instance.state,
			visible: instance.visible,
			focused: instance.focused,
		})), [
			{
				worktreePath: alpha,
				state: 'crashed',
				visible: false,
				focused: false,
			},
		]);
	});

	test('trust tracks hosted renderer process changes until close', async () => {
		const alpha = createWorktree('alpha');
		const {
			controller,
			trustedProcessIds,
			trustedWebContentsIds,
			untrustedProcessIds,
			untrustedWebContentsIds,
			viewFactory,
		} = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		viewFactory.views[0].rawWebContents.setProcessId(2001);
		viewFactory.views[0].rawWebContents.emit('did-start-navigation');
		viewFactory.views[0].rawWebContents.emit('did-start-loading');

		await controller.closeWorkspace();

		assert.deepStrictEqual(trustedWebContentsIds, [1]);
		assert.deepStrictEqual(trustedProcessIds, [1001, 2001]);
		assert.deepStrictEqual(untrustedWebContentsIds, [1]);
		assert.deepStrictEqual(untrustedProcessIds, [1001, 2001]);
	});

	test('window restore state tracks active workspace and MRU ordering',
		async () => {
			const alpha = createWorktree('alpha');
			const bravo = createWorktree('bravo');
			const { controller, window } = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			now = 2000;
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');
			now = 3000;
			await controller.openWorkspace(alpha, 'project-alpha');

			assert.strictEqual(window.config?.omniActiveWorktreePath, alpha);
			assert.deepStrictEqual(window.config?.omniResidentWorkspaces, [
				{
					projectId: 'project-alpha',
					worktreePath: alpha,
					lastActiveAt: 3000,
					state: 'active',
				},
				{
					projectId: 'project-bravo',
					worktreePath: bravo,
					lastActiveAt: 2000,
					state: 'loaded',
				},
			]);
		});

	test('window restore entries omit crashed and unloaded workspaces',
		async () => {
			const alpha = createWorktree('alpha');
			const bravo = createWorktree('bravo');
			const charlie = createWorktree('charlie');
			const { controller, viewFactory, window } = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			now = 2000;
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');
			now = 3000;
			await controller.openWorkspace(charlie, 'project-charlie');
			controller.notifyHostedWorkspaceReady('instance-3');

			viewFactory.views[1].rawWebContents.emit('render-process-gone');
			await controller.closeWorkspace('instance-3');

			assert.strictEqual(window.config?.omniActiveWorktreePath, alpha);
			assert.deepStrictEqual(window.config?.omniResidentWorkspaces, [
				{
					projectId: 'project-alpha',
					worktreePath: alpha,
					lastActiveAt: 3000,
					state: 'active',
				},
			]);
		});

	test('runActionInShell canonicalizes allowed legacy requests', () => {
		const { controller, logService, window } = createController();
		const shellWebContents = window.win!.webContents as unknown as
			TestWebContents;

		const allowedCommands = [
			TOGGLE_PROJECTS_SIDEBAR_COMMAND_ID,
			ADD_PROJECT_COMMAND_ID,
			REFRESH_PROJECTS_COMMAND_ID,
			COLLAPSE_ALL_PROJECTS_COMMAND_ID,
			GO_BACK_WORKTREE_COMMAND_ID,
			GO_FORWARD_WORKTREE_COMMAND_ID,
		];
		for (const id of allowedCommands) {
			assert.strictEqual(controller.runActionInShell({
				id,
				from: 'keybinding',
				args: [{ callerControlled: true }],
			}), true);
		}

		assert.deepStrictEqual(shellWebContents.sent, allowedCommands.map(id => ({
			channel: 'vscode:runAction',
			request: {
				id,
				from: 'menu',
				hucodeForwardedFromOmniShell: true,
			},
		})));

		const rejectedCommands = [
			'hucode.projectSwitcher.dismissWorkbench',
			`${ADD_PROJECT_COMMAND_ID}.lookalike`,
			FOCUS_PROJECT_PANE_COMMAND_ID,
		];
		for (const id of rejectedCommands) {
			assert.strictEqual(controller.runActionInShell({
				id,
				from: 'menu',
				args: [{ arbitrary: 'value' }],
			}), false);
		}
		assert.strictEqual(shellWebContents.sent.length, allowedCommands.length);
		assert.strictEqual(logService.warnings.length, 3);
		for (const id of rejectedCommands) {
			assert.ok(logService.warnings.some(warning => warning.includes(id)));
		}
		assert.ok(logService.warnings.every(warning =>
			warning.includes('Rejected hosted shell action') &&
			!warning.includes('arbitrary')
		));
	});

	test('runActionInWorkspace restores and forwards to active workspace', async () => {
		const alpha = createWorktree('alpha');
		const { browserViewMainService, controller, viewFactory } =
			createController({
				activeWorktreePath: alpha,
				restoreEntries: [{
					projectId: 'project-alpha',
					worktreePath: alpha,
					lastActiveAt: 100,
					state: 'active',
				}],
			});

		const sent = await controller.runActionInWorkspace({
			id: 'workbench.action.files.save',
			from: 'keybinding',
			args: [{ source: 'test' }],
		});

		const workspaceWebContents = viewFactory.views[0].rawWebContents;
		const frontCalls = browserViewMainService.frontCalls;
		assert.strictEqual(sent, true);
		assert.strictEqual(workspaceWebContents.isFocused(), true);
		assert.strictEqual(frontCalls[frontCalls.length - 1], 1);
		assert.deepStrictEqual(workspaceWebContents.sent, [{
			channel: 'vscode:runAction',
			request: {
				id: 'workbench.action.files.save',
				from: 'keybinding',
				args: [{ source: 'test' }],
				hucodeForwardedFromOmniShell: true,
			},
		}]);
	});

	test('runKeybindingInWorkspace forwards when shell has focus', async () => {
		const alpha = createWorktree('alpha');
		const { controller, viewFactory, window } = createController();

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		const shellWebContents = window.win!.webContents as unknown as
			TestWebContents;
		shellWebContents.focus();

		const sent = await controller.runKeybindingInWorkspace({
			userSettingsLabel: 'ctrl+s',
		});

		const workspaceWebContents = viewFactory.views[0].rawWebContents;
		assert.strictEqual(sent, true);
		assert.strictEqual(workspaceWebContents.isFocused(), true);
		assert.deepStrictEqual(workspaceWebContents.sent, [{
			channel: 'vscode:runKeybinding',
			request: {
				userSettingsLabel: 'ctrl+s',
				hucodeForwardedFromOmniShell: true,
			},
		}]);
	});

	test('runKeybindingInWorkspace skips forwarding when workspace has focus',
		async () => {
			const alpha = createWorktree('alpha');
			const { controller, viewFactory } = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			viewFactory.views[0].rawWebContents.focus();

			const sent = await controller.runKeybindingInWorkspace({
				userSettingsLabel: 'ctrl+s',
			});

			assert.strictEqual(sent, true);
			assert.deepStrictEqual(viewFactory.views[0].rawWebContents.sent, []);
		});

	test('triggerPasteInWorkspace focuses and pastes into active workspace',
		async () => {
			const alpha = createWorktree('alpha');
			const { controller, viewFactory } = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');

			const pasted = controller.triggerPasteInWorkspace();

			const workspaceWebContents = viewFactory.views[0].rawWebContents;
			assert.strictEqual(pasted, true);
			assert.strictEqual(workspaceWebContents.isFocused(), true);
			assert.strictEqual(workspaceWebContents.pasteCalls.length, 1);
		});

	test('workspace paste key event is rerouted through native paste', async () => {
		const alpha = createWorktree('alpha');
		const { controller, viewFactory } = createController();
		let prevented = false;

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		viewFactory.views[0].rawWebContents.emit('before-input-event', {
			preventDefault() {
				prevented = true;
			},
		}, {
			type: 'keyDown',
			meta: true,
			control: false,
			alt: false,
			shift: false,
			key: 'v',
		});

		assert.strictEqual(prevented, true);
		assert.strictEqual(
			viewFactory.views[0].rawWebContents.pasteCalls.length,
			1
		);
	});

	test('hosted shell bindings are sender-bound and generation-scoped',
		async () => {
			const alpha = createWorktree('alpha');
			const {
				controller,
				invalidatedHostedShellWebContentsIds,
				viewFactory,
			} = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			assert.strictEqual(
				controller.acquireHostedShellBinding(999),
				undefined
			);

			const first = controller.acquireHostedShellBinding(1)!;
			const replacement = controller.acquireHostedShellBinding(1)!;
			assert.strictEqual(first.instanceId, 'instance-1');
			assert.ok(
				replacement.connectionGeneration > first.connectionGeneration
			);
			assert.strictEqual(
				controller.getHostedShellAuthorityState(first).disposed,
				true
			);
			assert.strictEqual(
				controller.getHostedShellAuthorityState(replacement).disposed,
				false
			);

			viewFactory.views[0].rawWebContents.emit('did-start-loading');
			assert.strictEqual(
				controller.getHostedShellAuthorityState(replacement).disposed,
				true
			);
			assert.deepStrictEqual(
				invalidatedHostedShellWebContentsIds,
				[1, 1, 1]
			);
		});

	test('bound paste, screenshot, focus, and action never retarget',
		async () => {
			const alpha = createWorktree('alpha');
			const bravo = createWorktree('bravo');
			const { controller, viewFactory, window } = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			const alphaBinding = controller.acquireHostedShellBinding(1)!;
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');
			const bravoBinding = controller.acquireHostedShellBinding(2)!;

			assert.strictEqual(
				controller.triggerPasteInHostedShellSelf(alphaBinding),
				false
			);
			assert.strictEqual(
				await controller.captureHostedShellSelfScreenshot(alphaBinding),
				undefined
			);
			assert.strictEqual(
				controller.triggerPasteInHostedShellSelf(bravoBinding),
				true
			);
			assert.strictEqual(
				(await controller.captureHostedShellSelfScreenshot(
					bravoBinding
				))?.toString(),
				'test'
			);
			controller.setWorkspaceOverlayOcclusion(true);
			assert.strictEqual(
				controller.triggerPasteInHostedShellSelf(bravoBinding),
				false
			);
			assert.strictEqual(
				await controller.captureHostedShellSelfScreenshot(bravoBinding),
				undefined
			);
			assert.strictEqual(
				controller.runHostedShellAction(
					bravoBinding,
					HucodeHostedShellAction.AddProject
				),
				false
			);
			controller.setWorkspaceOverlayOcclusion(false);
			assert.strictEqual(
				controller.focusHostedShellSelf(alphaBinding),
				true
			);
			assert.strictEqual(
				controller.triggerPasteInHostedShellSelf(alphaBinding),
				true
			);
			assert.strictEqual(
				controller.triggerPasteInHostedShellSelf(bravoBinding),
				false
			);
			assert.strictEqual(
				controller.runHostedShellAction(
					bravoBinding,
					HucodeHostedShellAction.AddProject
				),
				false
			);
			assert.strictEqual(
				controller.runHostedShellAction(
					alphaBinding,
					HucodeHostedShellAction.AddProject
				),
				true
			);
			const shellWebContents = window.win!.webContents as unknown as
				TestWebContents;
			assert.strictEqual(shellWebContents.sent.length, 1);
			assert.strictEqual(viewFactory.views[0].rawWebContents.pasteCalls.length, 1);
			assert.strictEqual(viewFactory.views[1].rawWebContents.pasteCalls.length, 1);
		});

	test('invalid binding cannot discover or reuse a sibling generation',
		async () => {
			const alpha = createWorktree('alpha');
			const bravo = createWorktree('bravo');
			const { controller, viewFactory } = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			controller.acquireHostedShellBinding(1);
			const alphaBinding = controller.acquireHostedShellBinding(1)!;
			await controller.openWorkspace(bravo, 'project-bravo');
			controller.notifyHostedWorkspaceReady('instance-2');
			const bravoBinding = controller.acquireHostedShellBinding(2)!;
			assert.notStrictEqual(
				alphaBinding.connectionGeneration,
				bravoBinding.connectionGeneration
			);

			const forged = {
				...bravoBinding,
				instanceId: alphaBinding.instanceId,
			};
			const authority = controller.getHostedShellAuthorityState(forged);
			assert.strictEqual(authority.disposed, true);
			assert.strictEqual(authority.connectionGeneration, -1);
			assert.strictEqual(controller.reloadHostedShellSelf({
				...forged,
				connectionGeneration: authority.connectionGeneration,
			}), false);
			assert.strictEqual(
				viewFactory.views[0].rawWebContents.reloadCalls.length,
				0
			);
		});

	test('stale hosted shell binding cannot control a reloading view',
		async () => {
			const alpha = createWorktree('alpha');
			const { controller, viewFactory } = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			const stale = controller.acquireHostedShellBinding(1)!;
			viewFactory.views[0].rawWebContents.emit('did-start-loading');

			assert.strictEqual(controller.reloadHostedShellSelf(stale), false);
			assert.strictEqual(controller.focusHostedShellSelf(stale), false);
			assert.strictEqual(
				controller.triggerPasteInHostedShellSelf(stale),
				false
			);
			const current = controller.acquireHostedShellBinding(1)!;
			assert.strictEqual(controller.reloadHostedShellSelf(current), true);
			assert.strictEqual(
				viewFactory.views[0].rawWebContents.reloadCalls.length,
				1
			);
		});

	test('hosted close cannot remove a reloaded capability generation',
		async () => {
			const alpha = createWorktree('alpha');
			const { controller, ipcMain, viewFactory } = createController();

			await controller.openWorkspace(alpha, 'project-alpha');
			controller.notifyHostedWorkspaceReady('instance-1');
			const binding = controller.acquireHostedShellBinding(1)!;
			const hostedWebContents = viewFactory.views[0].rawWebContents;
			hostedWebContents.autoBeforeUnloadReply = false;

			const closing = controller.closeHostedShellSelf(binding);
			await Promise.resolve();
			const beforeUnload = hostedWebContents.sent[0].request as {
				okChannel: string;
			};
			hostedWebContents.emit('did-start-loading');
			ipcMain.emitReply(beforeUnload.okChannel);

			assert.strictEqual(await closing, false);
			assert.deepStrictEqual(
				controller.getState().instances.map(instance => instance.instanceId),
				['instance-1']
			);
			assert.deepStrictEqual(
				hostedWebContents.sent.map(message => message.channel),
				[
					'vscode:onBeforeUnload',
					'vscode:onShutdownPreparationAbandoned',
				]
			);
			assert.deepStrictEqual(hostedWebContents.closeCalls, []);
		});

	test('hosted navigation focuses a workbench in another Omni window',
		async () => {
			const caller = createWorktree('cross-shell-caller');
			const target = createWorktree('cross-shell-target');
			const {
				controller,
				focusHostedWorkspaceByPathCalls,
				focusNormalWindowByPathCalls,
				lastActiveWorktreePathCalls,
				viewFactory,
			} = createController({ hostedWindowPaths: [target] });

			await controller.openWorkspace(caller, 'project-caller');
			controller.notifyHostedWorkspaceReady('instance-1');
			const binding = controller.acquireHostedShellBinding(1)!;

			assert.strictEqual(
				await controller.navigateHostedShellToFolder(
					binding,
					{ folderUri: URI.file(target).toJSON() },
					{ isCurrentAndActiveVisible: async () => true }
				),
				HucodeHostedShellOperationOutcome.Accepted
			);
			assert.deepStrictEqual(focusHostedWorkspaceByPathCalls, [target]);
			assert.deepStrictEqual(focusNormalWindowByPathCalls, []);
			assert.deepStrictEqual(lastActiveWorktreePathCalls, [target]);
			assert.strictEqual(viewFactory.views.length, 1);
			assert.strictEqual(
				controller.getState().instances.some(instance =>
					instance.worktreePath === target),
				false
			);
		});

	test('hosted navigation reuses a sibling in the same Omni window',
		async () => {
			const target = createWorktree('same-shell-target');
			const caller = createWorktree('same-shell-caller');
			const {
				controller,
				focusHostedWorkspaceByPathCalls,
				lastActiveWorktreePathCalls,
				viewFactory,
			} = createController();

			await controller.openWorkspace(target, 'project-target');
			controller.notifyHostedWorkspaceReady('instance-1');
			await controller.openWorkspace(caller, 'project-caller');
			controller.notifyHostedWorkspaceReady('instance-2');
			const binding = controller.acquireHostedShellBinding(2)!;

			assert.strictEqual(
				await controller.navigateHostedShellToFolder(
					binding,
					{ folderUri: URI.file(target).toJSON() },
					{ isCurrentAndActiveVisible: async () => true }
				),
				HucodeHostedShellOperationOutcome.Accepted
			);
			assert.deepStrictEqual(focusHostedWorkspaceByPathCalls, [target]);
			assert.deepStrictEqual(lastActiveWorktreePathCalls, [target]);
			assert.strictEqual(
				controller.getState().activeInstanceId,
				'instance-1'
			);
			assert.strictEqual(viewFactory.views.length, 2);
		});

	test('superseded cross-shell focus does not open a local duplicate',
		async () => {
			const caller = createWorktree('cross-shell-stale-caller');
			const target = createWorktree('cross-shell-stale-target');
			const {
				controller,
				focusHostedWorkspaceByPathCalls,
				lastActiveWorktreePathCalls,
				viewFactory,
			} = createController({
				hostedWindowPaths: [target],
				hostedWindowFocusOutcome:
					HucodeHostedShellOperationOutcome.Superseded,
			});

			await controller.openWorkspace(caller, 'project-caller');
			controller.notifyHostedWorkspaceReady('instance-1');
			const binding = controller.acquireHostedShellBinding(1)!;

			assert.strictEqual(
				await controller.navigateHostedShellToFolder(
					binding,
					{ folderUri: URI.file(target).toJSON() },
					{ isCurrentAndActiveVisible: async () => true }
				),
				HucodeHostedShellOperationOutcome.Superseded
			);
			assert.deepStrictEqual(focusHostedWorkspaceByPathCalls, [target]);
			assert.deepStrictEqual(lastActiveWorktreePathCalls, []);
			assert.strictEqual(viewFactory.views.length, 1);
			assert.strictEqual(
				controller.getState().instances.some(instance =>
					instance.worktreePath === target),
				false
			);
		});

	test('hosted navigation focuses an existing standalone window', async () => {
		const caller = createWorktree('standalone-caller');
		const target = createWorktree('standalone-target');
		const {
			controller,
			focusNormalWindowByPathCalls,
			viewFactory,
		} = createController({ normalWindowPaths: [target] });

		await controller.openWorkspace(caller, 'project-caller');
		controller.notifyHostedWorkspaceReady('instance-1');
		const binding = controller.acquireHostedShellBinding(1)!;

		assert.strictEqual(
			await controller.navigateHostedShellToFolder(
				binding,
				{ folderUri: URI.file(target).toJSON() },
				{ isCurrentAndActiveVisible: async () => true }
			),
			HucodeHostedShellOperationOutcome.Accepted
		);
		assert.deepStrictEqual(focusNormalWindowByPathCalls, [target]);
		assert.strictEqual(viewFactory.views.length, 1);
		assert.strictEqual(
			controller.getState().instances.some(instance =>
				instance.worktreePath === target),
			false
		);
	});

	test('superseded hosted navigation cannot regain activation', async () => {
		const alpha = createWorktree('alpha');
		const bravo = createWorktree('bravo');
		const charlie = createWorktree('charlie');
		const heldLoad = new DeferredPromise<void>();
		const { controller, stateChanges, window } = createController({
			loadUrlPromises: [
				Promise.resolve(),
				Promise.resolve(),
				heldLoad.p,
			],
		});

		await controller.openWorkspace(alpha, 'project-alpha');
		controller.notifyHostedWorkspaceReady('instance-1');
		const alphaBinding = controller.acquireHostedShellBinding(1)!;
		await controller.openWorkspace(bravo, 'project-bravo');
		controller.notifyHostedWorkspaceReady('instance-2');
		assert.strictEqual(
			controller.focusHostedShellSelf(alphaBinding),
			true
		);
		const navigation = controller.navigateHostedShellToFolder(
			alphaBinding,
			{ folderUri: URI.file(charlie).toJSON() },
			{
				isCurrentAndActiveVisible: async () => {
					const state = controller.getHostedShellAuthorityState(
						alphaBinding
					);
					return !state.disposed &&
						state.activeInstanceId === alphaBinding.instanceId &&
						state.instances.some(instance =>
							instance.instanceId === alphaBinding.instanceId &&
							instance.visible
						);
				},
			}
		);
		await Promise.resolve();
		await controller.openWorkspace(bravo, 'project-bravo');
		void heldLoad.complete();

		assert.strictEqual(
			await navigation,
			HucodeHostedShellOperationOutcome.Superseded
		);
		assert.strictEqual(
			controller.getState().activeInstanceId,
			'instance-2'
		);
		assert.strictEqual(
			controller.getState().instances.some(instance =>
				instance.worktreePath === charlie),
			false
		);
		assert.strictEqual(
			controller.getState().retainedWorkbenches?.some(record =>
				URI.revive(record.folderUri).fsPath === charlie),
			false
		);
		assert.deepStrictEqual(stateChanges.at(-1), controller.getState());
		assert.strictEqual(
			window.config?.omniResidentWorkspaces?.some(entry =>
				entry.worktreePath === charlie),
			false
		);
		assert.strictEqual(
			window.config?.omniRetainedWorkbenches?.some(record =>
				URI.revive(record.folderUri).fsPath === charlie),
			false
		);
	});

	test('superseded navigation restores an unloaded retained target',
		async () => {
			const caller = createWorktree('retained-caller');
			const target = createWorktree('retained-target');
			const heldLoad = new DeferredPromise<void>();
			const { controller, stateChanges, viewFactory, window } =
				createController({
					loadUrlPromises: [Promise.resolve(), heldLoad.p],
					retainedWorkbenches: [{
						id: 'retained-target',
						folderUri: URI.file(target).toJSON(),
						desiredState: 'unloaded',
						order: 0,
						lastActiveAt: 42,
					}],
				});

			await controller.openWorkspace(caller, 'project-caller');
			controller.notifyHostedWorkspaceReady('instance-1');
			const binding = controller.acquireHostedShellBinding(1)!;
			const navigation = controller.navigateHostedShellToFolder(
				binding,
				{ folderUri: URI.file(target).toJSON() },
				{
					isCurrentAndActiveVisible: async () => true,
				}
			);
			await Promise.resolve();
			viewFactory.views[0].rawWebContents.emit('did-start-loading');
			void heldLoad.complete();

			assert.strictEqual(
				await navigation,
				HucodeHostedShellOperationOutcome.Superseded
			);
			const state = controller.getState();
			assert.strictEqual(state.instances.some(instance =>
				instance.worktreePath === target), false);
			assert.deepStrictEqual(state.retainedWorkbenches?.map(record => ({
				path: URI.revive(record.folderUri).fsPath,
				desiredState: record.desiredState,
				lastActiveAt: record.lastActiveAt,
			})), [{
				path: target,
				desiredState: 'unloaded',
				lastActiveAt: 42,
			}]);
			assert.deepStrictEqual(stateChanges.at(-1), state);
			assert.deepStrictEqual(
				window.config?.omniRetainedWorkbenches?.map(record => ({
					path: URI.revive(record.folderUri).fsPath,
					desiredState: record.desiredState,
				})),
				[{ path: target, desiredState: 'unloaded' }]
			);
		});

	test('superseded open restores a promoted retained record', async () => {
		const caller = createWorktree('promoted-caller');
		const target = createWorktree('promoted-target');
		const sibling = createWorktree('promoted-sibling');
		const heldLoad = new DeferredPromise<void>();
		const { controller, stateChanges, window } = createController({
			loadUrlPromises: [Promise.resolve(), heldLoad.p],
			retainedWorkbenches: [{
				id: 'retained-target',
				folderUri: URI.file(target).toJSON(),
				label: 'Scratch target',
				desiredState: 'unloaded',
				folderStatus: 'missing',
				order: 0,
				lastActiveAt: 42,
			}, {
				id: 'retained-sibling',
				folderUri: URI.file(sibling).toJSON(),
				desiredState: 'unloaded',
				order: 1,
			}],
		});

		await controller.openWorkspace(caller, 'project-caller');
		let canApply = true;
		const open = controller.openWorkspace(
			target,
			'project-target',
			() => true,
			() => canApply
		);
		await Promise.resolve();
		canApply = false;
		void heldLoad.complete();
		await open;

		const state = controller.getState();
		assert.strictEqual(state.instances.some(instance =>
			instance.worktreePath === target), false);
		assert.deepStrictEqual(state.retainedWorkbenches?.map(record => ({
			id: record.id,
			path: URI.revive(record.folderUri).fsPath,
			label: record.label,
			desiredState: record.desiredState,
			folderStatus: record.folderStatus,
			order: record.order,
			lastActiveAt: record.lastActiveAt,
		})), [{
			id: 'retained-target',
			path: target,
			label: 'Scratch target',
			desiredState: 'unloaded',
			folderStatus: 'missing',
			order: 0,
			lastActiveAt: 42,
		}, {
			id: 'retained-sibling',
			path: sibling,
			label: undefined,
			desiredState: 'unloaded',
			folderStatus: undefined,
			order: 1,
			lastActiveAt: undefined,
		}]);
		assert.deepStrictEqual(stateChanges.at(-1), state);
		assert.deepStrictEqual(
			window.config?.omniRetainedWorkbenches,
			state.retainedWorkbenches
		);
	});

	test('superseded navigation restores a dormant retained target',
		async () => {
			const target = createWorktree('dormant-target');
			const caller = createWorktree('dormant-caller');
			const heldLoad = new DeferredPromise<void>();
			const { controller, stateChanges, viewFactory, window } =
				createController({
					loadUrlPromises: [
						Promise.resolve(),
						Promise.resolve(),
						heldLoad.p,
					],
					deferDestroyedEvents: [false, false, true],
				});

			await controller.retainAndOpenWorkbench(URI.file(target));
			const targetInstanceId = controller.getState().activeInstanceId;
			assert.ok(targetInstanceId);
			controller.notifyHostedWorkspaceReady(targetInstanceId);
			await controller.openWorkspace(caller, 'project-caller');
			const callerState = controller.getState().instances.find(instance =>
				instance.worktreePath === caller);
			assert.ok(callerState?.webContentsId);
			controller.notifyHostedWorkspaceReady(callerState.instanceId);
			await controller.suspendWorkspace(targetInstanceId);
			const dormantBefore = controller.getState().instances.find(instance =>
				instance.worktreePath === target);
			assert.strictEqual(dormantBefore?.state, 'dormant');
			const binding = controller.acquireHostedShellBinding(
				callerState.webContentsId
			)!;
			const navigation = controller.navigateHostedShellToFolder(
				binding,
				{ folderUri: URI.file(target).toJSON() },
				{
					isCurrentAndActiveVisible: async () => true,
				}
			);
			await Promise.resolve();
			viewFactory.views[1].rawWebContents.emit('did-start-loading');
			void heldLoad.complete();

			assert.strictEqual(
				await navigation,
				HucodeHostedShellOperationOutcome.Superseded
			);
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			const state = controller.getState();
			assert.deepStrictEqual(state.instances.find(instance =>
				instance.worktreePath === target), {
				instanceId: dormantBefore.instanceId,
				projectId: undefined,
				worktreePath: target,
				state: 'dormant',
				visible: false,
				focused: false,
				lastActiveAt: 1000,
				processId: undefined,
				webContentsId: undefined,
			});
			assert.strictEqual(
				state.retainedWorkbenches?.[0].desiredState,
				'loaded'
			);
			assert.deepStrictEqual(stateChanges.at(-1), state);
			assert.strictEqual(
				window.config?.omniResidentWorkspaces?.some(entry =>
					entry.worktreePath === target),
				false
			);
			assert.strictEqual(
				window.config?.omniRetainedWorkbenches?.find(record =>
					URI.revive(record.folderUri).fsPath === target
				)?.desiredState,
				'loaded'
			);
		});
});
