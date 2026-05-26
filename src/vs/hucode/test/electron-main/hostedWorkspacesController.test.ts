/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
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
	IHostedWorkbenchView,
	IHostedWorkbenchViewFactory,
	IHostedWorkspaceIpcMain,
	ResidentHostedWorkspacesController,
} from '../../electron-main/hostedWorkspacesController.js';

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
		if (this.loadUrlError) {
			throw this.loadUrlError;
		}
	}

	send(channel: string, request: unknown): void {
		this.sent.push({ channel, request });
		if (channel === 'vscode:onBeforeUnload') {
			const { okChannel } = request as { okChannel: string };
			setTimeout(() => this.ipcMain.emitReply(okChannel), 0);
		}
		if (channel === 'vscode:onWillUnload') {
			const { replyChannel } = request as { replyChannel: string };
			setTimeout(() => this.ipcMain.emitReply(replyChannel), 0);
		}
	}

	close(options: Electron.CloseOpts): void {
		this.closeCalls.push(options);
		this.destroyed = true;
		this.emit('destroyed');
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

	override once(
		channel: string,
		listener: (event: Electron.IpcMainEvent, ...args: unknown[]) => void
	): this {
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

	emitReply(channel: string): void {
		this.emit(
			channel,
			{ senderFrame: undefined } as unknown as Electron.IpcMainEvent
		);
	}
}

class TestHostedWorkbenchView {
	readonly webContents: Electron.WebContents;
	readonly rawWebContents: TestWebContents;
	readonly visibleCalls: boolean[] = [];
	readonly boundsCalls: IRectangle[] = [];
	readonly backgroundColors: string[] = [];

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
	}
}

class TestHostedWorkbenchViewFactory implements IHostedWorkbenchViewFactory {
	readonly views: TestHostedWorkbenchView[] = [];
	private nextWebContentsId = 1;

	constructor(
		private readonly ipcMain: TestHostedWorkspaceIpcMain,
		private readonly loadUrlErrors: Error[] = []
	) { }

	createView(): IHostedWorkbenchView {
		const view = new TestHostedWorkbenchView(
			new TestWebContents(this.nextWebContentsId++, this.ipcMain)
		);
		view.rawWebContents.loadUrlError = this.loadUrlErrors.shift();
		this.views.push(view);
		return view as unknown as IHostedWorkbenchView;
	}
}

class TestIPCObjectUrl<T> implements IIPCObjectUrl<T> {
	readonly resource = URI.parse('vscode-file://test/window-config');
	value: T | undefined;
	disposed = false;
	disposeCalls = 0;

	update(obj: T): void {
		this.value = obj;
	}

	dispose(): void {
		this.disposeCalls++;
		this.disposed = true;
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
	readonly destroyedHostedWebContentsIds: number[] = [];

	setHostedWebContentsVisible(id: number, visible: boolean): void {
		this.visibleCalls.push({ id, visible });
	}

	bringHostedBrowserViewsToFront(id: number): void {
		this.frontCalls.push(id);
	}

	destroyBrowserViewsForHostedWebContents(id: number): void {
		this.destroyedHostedWebContentsIds.push(id);
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
		readonly activeWorktreePath?: string;
		readonly ids?: string[];
		readonly ipcMain?: TestHostedWorkspaceIpcMain;
		readonly loadUrlErrors?: Error[];
		readonly readyTimeoutMs?: number;
		readonly windowId?: number;
	} = {}) {
		const protocolMainService = new TestProtocolMainService();
		const ipcMain = options.ipcMain ?? new TestHostedWorkspaceIpcMain();
		const viewFactory = new TestHostedWorkbenchViewFactory(
			ipcMain,
			[...(options.loadUrlErrors ?? [])]
		);
		const browserViewMainService = new TestBrowserViewMainService();
		const trustedProcessIds: number[] = [];
		const untrustedProcessIds: number[] = [];
		const trustedWebContentsIds: number[] = [];
		const untrustedWebContentsIds: number[] = [];
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
			} as unknown as INativeWindowConfiguration,
		} as ICodeWindow;
		const controller = disposables.add(new ResidentHostedWorkspacesController(
			protocolMainService as unknown as IProtocolMainService,
			{ useCodeCache: false } as unknown as IEnvironmentMainService,
			{ getBackgroundColor: () => '#111111' } as IThemeMainService,
			new NullLogService(),
			browserViewMainService as unknown as IBrowserViewMainService,
			window,
			id => trustedProcessIds.push(id),
			id => untrustedProcessIds.push(id),
			id => trustedWebContentsIds.push(id),
			id => untrustedWebContentsIds.push(id),
			state => stateChanges.push(state),
			{
				beforeUnloadTimeoutMs: 100,
				willUnloadTimeoutMs: 100,
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
			ipcMain,
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

	test('restore without resident workspaces emits an empty shell state', async () => {
		const { controller, stateChanges } = createController();

		await controller.ensureRestored();

		assert.deepStrictEqual(controller.getState(), {
			activeInstanceId: undefined,
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			instances: [],
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

		assert.strictEqual(viewFactory.views.length, 2);
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
				state: 'loading',
				visible: false,
			},
		]);

		controller.notifyHostedWorkspaceReady('instance-1');
		controller.notifyHostedWorkspaceReady('instance-2');

		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			worktreePath: instance.worktreePath,
			state: instance.state,
		})), [
			{ worktreePath: bravo, state: 'active' },
			{ worktreePath: alpha, state: 'loaded' },
		]);
		assert.ok(stateChanges.length >= 4);
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
		controller.notifyHostedWorkspaceReady('instance-2');

		assert.strictEqual(viewFactory.views.length, 2);
		assert.deepStrictEqual(
			browserViewMainService.destroyedHostedWebContentsIds,
			[1]
		);
		assert.deepStrictEqual(viewFactory.views[0].rawWebContents.closeCalls, [
			{ waitForBeforeUnload: false },
		]);
		assert.deepStrictEqual(controller.getState().instances.map(instance => ({
			webContentsId: instance.webContentsId,
			worktreePath: instance.worktreePath,
			state: instance.state,
			visible: instance.visible,
		})), [
			{
				webContentsId: 2,
				worktreePath: alpha,
				state: 'active',
				visible: true,
			},
		]);
		assert.deepStrictEqual(browserViewMainService.visibleCalls.slice(-3), [
			{ id: 2, visible: false },
			{ id: 2, visible: true },
			{ id: 2, visible: true },
		]);
		assert.strictEqual(window.config?.omniActiveWorktreePath, alpha);
		assert.deepStrictEqual(window.config?.omniResidentWorkspaces, [{
			projectId: 'project-alpha',
			worktreePath: alpha,
			lastActiveAt: 1000,
			state: 'active',
		}]);
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
		viewFactory.views[0].rawWebContents.send = function (
			channel: string,
			request: unknown
		): void {
			this.sent.push({ channel, request });
			if (channel === 'vscode:onBeforeUnload') {
				const { cancelChannel } = request as { cancelChannel: string };
				setTimeout(() => ipcMain.emitReply(cancelChannel), 0);
			}
			if (channel === 'vscode:onWillUnload') {
				const { replyChannel } = request as { replyChannel: string };
				setTimeout(() => ipcMain.emitReply(replyChannel), 0);
			}
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

	test('runActionInShell forwards marked action to shell webContents', () => {
		const { controller, window } = createController();
		const shellWebContents = window.win!.webContents as unknown as
			TestWebContents;

		const sent = controller.runActionInShell({
			id: 'workbench.action.toggleSidebarVisibility',
			from: 'menu',
			args: ['test'],
		});

		assert.strictEqual(sent, true);
		assert.deepStrictEqual(shellWebContents.sent, [{
			channel: 'vscode:runAction',
			request: {
				id: 'workbench.action.toggleSidebarVisibility',
				from: 'menu',
				args: ['test'],
				hucodeForwardedFromOmniShell: true,
			},
		}]);
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
});
