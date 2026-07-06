/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { statSync } from 'fs';
import { validatedIpcMain } from '../../base/parts/ipc/electron-main/ipcMain.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { FileAccess } from '../../base/common/network.js';
import { isLinux } from '../../base/common/platform.js';
import { URI } from '../../base/common/uri.js';
import { generateUuid } from '../../base/common/uuid.js';
import { IEnvironmentMainService } from
	'../../platform/environment/electron-main/environmentMainService.js';
import { ILogService } from '../../platform/log/common/log.js';
import {
	IIPCObjectUrl,
	IProtocolMainService,
} from '../../platform/protocol/electron-main/protocol.js';
import { IThemeMainService } from
	'../../platform/theme/electron-main/themeMainService.js';
import {
	ICodeWindow,
	UnloadReason,
} from '../../platform/window/electron-main/window.js';
import {
	INativeWindowConfiguration,
	INativeOpenFileRequest,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
	IOmniWorkspaceRestoreEntry,
	IRectangle,
} from '../../platform/window/common/window.js';
import { getSingleFolderWorkspaceIdentifier } from
	'../../platform/workspaces/node/workspaces.js';
import { getProjectManagerPathComparisonKey } from
	'../../platform/projectManager/common/projectManagerState.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeHostedWorkbenchInstance,
	IHucodeHostedWorkspaceState,
} from '../common/omniWindow.js';
import {
	createHostedWorkspaceRestoreEntries,
	getReadyHostedWorkspaceState,
	getMostRecentHostedWorkspace,
	getRestoreActiveWorktreePath,
	hasLoadedHostedWorkspace,
	HostedWorkspaceStateModel,
	waitForHostedWorkspaceReady,
	sortRestoreEntries,
} from '../common/hostedWorkspaceState.js';
import type { IBrowserViewMainService } from
	'../../platform/browserView/electron-main/browserViewMainService.js';

export interface IHostedWorkbenchView extends Electron.View {
	readonly webContents: Electron.WebContents;
	setBackgroundColor(color: string): void;
	setBounds(bounds: IRectangle): void;
	setVisible(visible: boolean): void;
}

export interface IHostedWorkbenchViewFactory {
	createView(
		configObjectUrl: IIPCObjectUrl<INativeWindowConfiguration>,
		useCodeCache: boolean
	): IHostedWorkbenchView;
}

export interface IHostedWorkspaceIpcMain {
	once(
		channel: string,
		listener: (event: Electron.IpcMainEvent, ...args: unknown[]) => void
	): this;
	removeListener(
		channel: string,
		listener: (event: Electron.IpcMainEvent, ...args: unknown[]) => void
	): this;
}

export interface IResidentHostedWorkspacesControllerOptions {
	readonly beforeUnloadTimeoutMs?: number;
	readonly willUnloadTimeoutMs?: number;
	readonly readyTimeoutMs?: number;
	readonly createInstanceId?: () => string;
	readonly now?: () => number;
	readonly viewFactory?: IHostedWorkbenchViewFactory;
	readonly ipcMain?: IHostedWorkspaceIpcMain;
}

interface IHostedWorkbenchInstance {
	instanceId: string;
	projectId?: string;
	worktreePath: string;
	view?: IHostedWorkbenchView;
	configObjectUrl?: IIPCObjectUrl<INativeWindowConfiguration>;
	trustedProcessIds: Set<number>;
	trustedWebContentsId?: number;
	attached: boolean;
	state: HucodeHostedWorkbenchLifecycleState;
	visible: boolean;
	focused: boolean;
	lastActiveAt?: number;
	disposed: boolean;
}

type OmniFocusedSurface = 'shell' | 'workspace';

const defaultHostedWorkbenchViewFactory: IHostedWorkbenchViewFactory = {
	createView(configObjectUrl, useCodeCache) {
		return new electron.WebContentsView({
			webPreferences: {
				preload: FileAccess.asFileUri(
					'vs/base/parts/sandbox/electron-browser/preload.js'
				).fsPath,
				additionalArguments: [
					`--vscode-window-config=${configObjectUrl.resource.toString()}`
				],
				v8CacheOptions: useCodeCache ? 'bypassHeatCheck' : 'none',
				backgroundThrottling: false,
				spellcheck: false,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
			},
		});
	}
};

export class ResidentHostedWorkspacesController extends Disposable {
	private static readonly BEFORE_UNLOAD_TIMEOUT_MS = 5000;
	private static readonly WILL_UNLOAD_TIMEOUT_MS = 15000;
	private static readonly READY_TIMEOUT_MS = 30000;

	private readonly _onDidChangeState =
		this._register(new Emitter<IHucodeHostedWorkspaceState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly hostedWorkspaces: HostedWorkspaceStateModel<
		IHostedWorkbenchInstance
	>;

	private bounds: IRectangle = { x: 0, y: 0, width: 0, height: 0 };
	private restored = false;
	private restorePromise: Promise<void> | undefined;
	private oneTimeListenerTokenGenerator = 0;
	private overlayOccluded = false;
	private lastFocusedSurface: OmniFocusedSurface = 'shell';
	private windowFocusRestoreSurface: OmniFocusedSurface | undefined;
	private readonly traceRestoreToStdout: boolean;
	private readonly traceRestoreStartedAt: number;
	private readonly beforeUnloadTimeoutMs: number;
	private readonly willUnloadTimeoutMs: number;
	private readonly readyTimeoutMs: number;
	private readonly createInstanceId: () => string;
	private readonly now: () => number;
	private readonly viewFactory: IHostedWorkbenchViewFactory;
	private readonly ipcMain: IHostedWorkspaceIpcMain;

	constructor(
		private readonly protocolMainService: IProtocolMainService,
		private readonly environmentMainService: IEnvironmentMainService,
		private readonly themeMainService: IThemeMainService,
		private readonly logService: ILogService,
		private readonly browserViewMainService: IBrowserViewMainService,
		private readonly window: ICodeWindow,
		private readonly trustHostedWorkspaceProcess:
			(processId: number) => void,
		private readonly untrustHostedWorkspaceProcess:
			(processId: number) => void,
		private readonly trustHostedWorkspaceWebContents:
			(webContentsId: number) => void,
		private readonly untrustHostedWorkspaceWebContents:
			(webContentsId: number) => void,
		private readonly onStateChange: (state: IHucodeHostedWorkspaceState) => void,
		options: IResidentHostedWorkspacesControllerOptions = {},
	) {
		super();
		this.traceRestoreToStdout =
			process.env['HUCODE_OMNI_RESTORE_TRACE'] === '1';
		this.beforeUnloadTimeoutMs =
			options.beforeUnloadTimeoutMs ??
			ResidentHostedWorkspacesController.BEFORE_UNLOAD_TIMEOUT_MS;
		this.willUnloadTimeoutMs =
			options.willUnloadTimeoutMs ??
			ResidentHostedWorkspacesController.WILL_UNLOAD_TIMEOUT_MS;
		this.readyTimeoutMs =
			options.readyTimeoutMs ??
			ResidentHostedWorkspacesController.READY_TIMEOUT_MS;
		this.createInstanceId = options.createInstanceId ?? generateUuid;
		this.now = options.now ?? Date.now;
		this.hostedWorkspaces = new HostedWorkspaceStateModel(
			path => getProjectManagerPathComparisonKey(path, isLinux),
			this.now
		);
		this.traceRestoreStartedAt = this.now();
		this.viewFactory = options.viewFactory ??
			defaultHostedWorkbenchViewFactory;
		this.ipcMain = options.ipcMain ?? validatedIpcMain;

		const shellWebContents = this.window.win?.webContents;
		if (shellWebContents) {
			const onShellFocus = () => {
				this.lastFocusedSurface = 'shell';
			};
			shellWebContents.on('focus', onShellFocus);
			this._register(toDisposable(() => {
				shellWebContents.off('focus', onShellFocus);
			}));
		}

		if (this.window.win) {
			const onWindowBlur = () => {
				this.windowFocusRestoreSurface = this.getFocusedSurface();
			};
			const onWindowFocus = () => {
				this.restoreWindowFocus();
			};

			this.window.win.on('blur', onWindowBlur);
			this.window.win.on('focus', onWindowFocus);
			this._register(toDisposable(() => {
				this.window.win?.off('blur', onWindowBlur);
				this.window.win?.off('focus', onWindowFocus);
			}));
		}
	}

	getState(): IHucodeHostedWorkspaceState {
		return this.hostedWorkspaces.toState(
			instance => this.toExternalInstance(instance)
		);
	}

	private toExternalInstance(
		instance: IHostedWorkbenchInstance
	): IHucodeHostedWorkbenchInstance {
		const webContents = this.getLiveWebContents(instance);
		return {
			instanceId: instance.instanceId,
			projectId: instance.projectId,
			worktreePath: instance.worktreePath,
			state: instance.state,
			webContentsId: webContents?.id,
			processId: webContents?.getProcessId(),
			visible: instance.visible,
			focused: instance.focused,
			lastActiveAt: instance.lastActiveAt,
		};
	}

	private emitState(): void {
		this.ensureProjectsSidebarVisibleWithoutLoadedWorkbench();
		this.updateWindowRestoreState();
		const state = this.getState();
		this._onDidChangeState.fire(state);
		this.onStateChange(state);
	}

	private hasLoadedWorkbench(): boolean {
		return hasLoadedHostedWorkspace(
			this.instancesById.values(),
			instance => instance.disposed
		);
	}

	private ensureProjectsSidebarVisibleWithoutLoadedWorkbench(): void {
		this.hostedWorkspaces.setProjectsSidebarVisible(
			this.projectsSidebarVisible,
			this.hasLoadedWorkbench()
		);
	}

	private waitForInstanceReady(
		instance: IHostedWorkbenchInstance
	): Promise<boolean> {
		return waitForHostedWorkspaceReady(
			instance,
			this.onDidChangeState,
			this.readyTimeoutMs,
			candidate => !!(candidate as IHostedWorkbenchInstance).disposed
		);
	}

	private updateWindowRestoreState(): void {
		if (!this.window.config) {
			return;
		}

		this.window.config.omniActiveWorktreePath =
			this.getActiveInstance()?.worktreePath;
		this.window.config.omniResidentWorkspaces = this.getRestoreEntries();
	}

	private getRestoreEntries(): IOmniWorkspaceRestoreEntry[] {
		return createHostedWorkspaceRestoreEntries(
			this.instancesById.values(),
			this.activeInstanceId
		);
	}

	private getActiveInstance(): IHostedWorkbenchInstance | undefined {
		if (!this.activeInstanceId) {
			return undefined;
		}

		return this.instancesById.get(this.activeInstanceId);
	}

	private updateInstanceState(
		instance: IHostedWorkbenchInstance,
		update: Partial<
			Pick<
				IHostedWorkbenchInstance,
				| 'projectId'
				| 'state'
				| 'visible'
				| 'focused'
				| 'lastActiveAt'
			>
		>
	): void {
		Object.assign(instance, update);
		this.emitState();
	}

	notifyHostedWorkspaceReady(instanceId: string): void {
		const instance = this.instancesById.get(instanceId);
		if (
			!instance
			|| instance.disposed
			|| instance.state === 'crashed'
			|| instance.state === 'unloaded'
		) {
			return;
		}

		const state = getReadyHostedWorkspaceState(
			instance,
			this.activeInstanceId
		);
		if (instance.state === state) {
			return;
		}

		this.traceRestore(
			`ready previousState=${instance.state} nextState=${state}`,
			instance
		);
		this.hostedWorkspaces.markInstanceReady(instance);
		this.emitState();
		if (state === 'active') {
			this.reconcileViewVisibility('ready:active');
		}
	}

	private setViewVisible(
		instance: IHostedWorkbenchInstance,
		visible: boolean
	): void {
		instance.visible = visible;
		this.reconcileViewVisibility('setViewVisible');
	}

	private isViewActuallyVisible(instance: IHostedWorkbenchInstance): boolean {
		return instance.visible
			&& instance.instanceId === this.activeInstanceId
			&& !instance.disposed
			&& instance.state !== 'crashed'
			&& instance.state !== 'unloaded'
			&& !this.overlayOccluded;
	}

	private reconcileViewVisibility(reason: string): void {
		this.traceRestore(`reconcile:visibility reason=${reason}`);
		const instances = Array.from(this.instancesById.values());
		for (const instance of instances) {
			if (!this.isViewActuallyVisible(instance)) {
				this.applyInstanceViewVisibility(instance, false);
			}
		}

		for (const instance of instances) {
			if (this.isViewActuallyVisible(instance)) {
				this.applyInstanceViewVisibility(instance, true);
			}
		}
	}

	private applyInstanceViewVisibility(
		instance: IHostedWorkbenchInstance,
		visible: boolean
	): void {
		const wasActuallyVisible = instance.attached && visible;
		this.traceRestore(
			`visibility requested=${instance.visible} actual=${visible} ` +
			`wasActual=${wasActuallyVisible} attached=${instance.attached}`,
			instance
		);
		const view = instance.view;
		const webContents = this.getLiveWebContents(instance);
		if (view && !webContents) {
			instance.attached = false;
			return;
		}

		if (!visible && webContents?.isFocused()) {
			this.window.win?.webContents.focus();
		}
		if (view && webContents) {
			if (visible) {
				this.attachInstanceView(instance);
				if (!wasActuallyVisible) {
					this.setInstanceBounds(instance, this.bounds);
				}
				view.setVisible(true);
				this.browserViewMainService.setHostedWebContentsVisible(
					webContents.id,
					true
				);
			} else {
				this.browserViewMainService.setHostedWebContentsVisible(
					webContents.id,
					false
				);
				view.setVisible(false);
				this.detachInstanceView(instance);
			}
		}
		if (visible) {
			this.bringInstanceToFront(instance);
			if (
				!wasActuallyVisible &&
				instance.instanceId === this.activeInstanceId
			) {
				webContents?.invalidate();
			}
		}
	}

	private canBringInstanceToFront(
		instance: IHostedWorkbenchInstance
	): boolean {
		return this.isViewActuallyVisible(instance)
			&& (
				!instance.view
				|| !!this.getLiveWebContents(instance)
			);
	}

	private getLiveWebContents(
		instance: IHostedWorkbenchInstance
	): Electron.WebContents | undefined {
		const webContents = instance.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return undefined;
		}

		return webContents;
	}

	private attachInstanceView(instance: IHostedWorkbenchInstance): void {
		if (!instance.view || !this.window.win) {
			return;
		}

		// Re-adding an attached Electron View moves it above its siblings.
		this.window.win.contentView.addChildView(instance.view);
		instance.attached = true;
	}

	private detachInstanceView(instance: IHostedWorkbenchInstance): void {
		if (!instance.view || !this.window.win || !instance.attached) {
			return;
		}

		this.window.win.contentView.removeChildView(instance.view);
		instance.attached = false;
	}

	private bringInstanceToFront(instance: IHostedWorkbenchInstance): void {
		if (!this.canBringInstanceToFront(instance)) {
			return;
		}

		const webContents = this.getLiveWebContents(instance);
		if (!instance.view || !webContents) {
			return;
		}

		this.attachInstanceView(instance);
		this.browserViewMainService.bringHostedBrowserViewsToFront(
			webContents.id
		);
	}

	private setInstanceBounds(
		instance: IHostedWorkbenchInstance,
		bounds: IRectangle
	): void {
		if (!instance.view || !this.window.win) {
			return;
		}

		const zoomFactor = this.window.win.webContents.getZoomFactor();
		instance.view.setBounds({
			x: Math.round(bounds.x * zoomFactor),
			y: Math.round(bounds.y * zoomFactor),
			width: Math.round(bounds.width * zoomFactor),
			height: Math.round(bounds.height * zoomFactor),
		});
	}

	private expandActiveInstanceToWindowLeft(): void {
		const activeInstance = this.getActiveInstance();
		if (
			!activeInstance
			|| !this.isViewActuallyVisible(activeInstance)
			|| !this.window.win
		) {
			return;
		}

		const contentBounds = this.window.win.getContentBounds();
		const width = this.bounds.width > 0
			? Math.max(this.bounds.x + this.bounds.width, contentBounds.width)
			: contentBounds.width;
		const height = this.bounds.height > 0
			? Math.max(this.bounds.height, contentBounds.height)
			: contentBounds.height;

		this.setInstanceBounds(activeInstance, {
			x: 0,
			y: 0,
			width,
			height,
		});
		this.bringInstanceToFront(activeInstance);
	}

	private bringActiveInstanceToFront(): void {
		const activeInstance = this.getActiveInstance();
		if (activeInstance && this.isViewActuallyVisible(activeInstance)) {
			this.bringInstanceToFront(activeInstance);
		}
	}

	private trustView(instance: IHostedWorkbenchInstance): void {
		const view = instance.view;
		if (!view) {
			return;
		}

		if (instance.trustedWebContentsId !== view.webContents.id) {
			instance.trustedWebContentsId = view.webContents.id;
			this.trustHostedWorkspaceWebContents(view.webContents.id);
		}

		const processId = view.webContents.getProcessId();
		if (processId > 0 && !instance.trustedProcessIds.has(processId)) {
			instance.trustedProcessIds.add(processId);
			this.trustHostedWorkspaceProcess(processId);
		}
	}

	private untrustView(instance: IHostedWorkbenchInstance): void {
		if (typeof instance.trustedWebContentsId === 'number') {
			this.untrustHostedWorkspaceWebContents(instance.trustedWebContentsId);
			instance.trustedWebContentsId = undefined;
		}

		for (const processId of instance.trustedProcessIds) {
			this.untrustHostedWorkspaceProcess(processId);
		}

		instance.trustedProcessIds.clear();
	}

	async ensureRestored(): Promise<void> {
		if (this.restored) {
			return;
		}

		this.restorePromise ??= this.restoreResidentWorkspaces().finally(() => {
			this.restorePromise = undefined;
		});

		await this.restorePromise;
	}

	private async restoreResidentWorkspaces(): Promise<void> {
		if (this.restored) {
			return;
		}

		const restoreEntries = this.window.config?.omniResidentWorkspaces;
		if (!restoreEntries?.length) {
			this.traceRestore('restore:start entries=0');
			this.restored = true;
			this.emitState();
			return;
		}

		const configuredActiveWorktreePath =
			this.window.config?.omniActiveWorktreePath;
		const activeWorktreePath = getRestoreActiveWorktreePath(
			restoreEntries,
			configuredActiveWorktreePath
		);
		const sortedEntries = sortRestoreEntries(
			restoreEntries,
			activeWorktreePath
		);
		this.traceRestore(
			`restore:start entries=${sortedEntries.length} ` +
			`active=${activeWorktreePath ?? '<none>'}`
		);
		this.createRestorePendingInstances(sortedEntries, activeWorktreePath);

		for (const [index, entry] of sortedEntries.entries()) {
			try {
				this.traceRestore(
					`restore:entry index=${index + 1}/${sortedEntries.length} ` +
					`makeActive=${entry.worktreePath === activeWorktreePath} ` +
					`path=${entry.worktreePath}`
				);
				await this.createOrRestoreInstance(
					entry.worktreePath,
					entry.projectId,
					entry.worktreePath === activeWorktreePath
				);
			} catch (error) {
				this.logService.warn(
					`[HucodeShellMainService] Failed to restore hosted ` +
					`workspace ${entry.worktreePath}: ${error}`
				);
			}
		}

		this.restored = true;
		this.activateMostRecentRestoredInstance();
		this.traceRestore('restore:complete');
		this.emitState();
	}

	private activateMostRecentRestoredInstance(): void {
		if (this.getActiveInstance()) {
			return;
		}

		const nextActive = getMostRecentHostedWorkspace(
			this.instancesById.values(),
			undefined,
			instance => instance.disposed
		);

		if (nextActive) {
			this.activateInstance(nextActive);
		}
	}

	private createRestorePendingInstances(
		entries: readonly IOmniWorkspaceRestoreEntry[],
		activeWorktreePath: string | undefined
	): void {
		for (const entry of entries) {
			if (this.instanceIdsByPath.has(entry.worktreePath)) {
				continue;
			}

			const instance: IHostedWorkbenchInstance = {
				instanceId: this.createInstanceId(),
				projectId: entry.projectId,
				worktreePath: entry.worktreePath,
				trustedProcessIds: new Set<number>(),
				attached: false,
				state: 'restore-pending',
				visible: false,
				focused: false,
				lastActiveAt: entry.worktreePath === activeWorktreePath
					? this.now()
					: entry.lastActiveAt,
				disposed: false,
			};
			this.hostedWorkspaces.addInstance(instance);
			if (entry.worktreePath === activeWorktreePath) {
				this.activeInstanceId = instance.instanceId;
			}
			this.traceRestore('restore:pending', instance);
		}

		this.emitState();
	}

	async openWorkspace(
		worktreePath: string,
		projectId?: string
	): Promise<void> {
		await this.ensureRestored();

		const existing = this.hostedWorkspaces.getInstanceByPath(worktreePath);
		if (existing) {
			if (
				!existing.disposed &&
				existing.state !== 'crashed' &&
				existing.state !== 'unloaded'
			) {
				existing.projectId = projectId ?? existing.projectId;
				this.activateInstance(existing);
				return;
			}

			await this.destroyInstance(existing, true, false);
		}

		await this.createOrRestoreInstance(worktreePath, projectId, true);
	}

	async openFilesInWorkspace(
		worktreePath: string,
		request: INativeOpenFileRequest,
		projectId?: string
	): Promise<boolean> {
		await this.openWorkspace(worktreePath, projectId);

		const instance = this.getActiveInstance();
		if (!instance || instance.worktreePath !== worktreePath) {
			return false;
		}

		if (!await this.waitForInstanceReady(instance)) {
			this.logService.warn(
				'[HucodeShellMainService] Timed out waiting for hosted ' +
				`workspace before opening files for ${worktreePath}.`
			);
			return false;
		}

		return this.sendToWorkspace(instance, 'vscode:openFiles', request);
	}

	async openFilesInActiveWorkspace(
		request: INativeOpenFileRequest
	): Promise<boolean> {
		await this.ensureRestored();

		const instance = this.getActiveInstance();
		if (!instance) {
			return false;
		}

		if (!await this.waitForInstanceReady(instance)) {
			this.logService.warn(
				'[HucodeShellMainService] Timed out waiting for active ' +
				'hosted workspace before opening files.'
			);
			return false;
		}

		return this.sendToWorkspace(instance, 'vscode:openFiles', request);
	}

	private async createOrRestoreInstance(
		worktreePath: string,
		projectId: string | undefined,
		makeActive: boolean
	): Promise<IHostedWorkbenchInstance> {
		const pendingInstance =
			this.hostedWorkspaces.getInstanceByPath(worktreePath);
		const previousActiveInstanceId = this.activeInstanceId;
		const instance: IHostedWorkbenchInstance =
			pendingInstance?.state === 'restore-pending'
				? pendingInstance
				: {
					instanceId: this.createInstanceId(),
					projectId,
					worktreePath,
					trustedProcessIds: new Set<number>(),
					attached: false,
					state: 'loading',
					visible: false,
					focused: false,
					lastActiveAt: makeActive ? this.now() : undefined,
					disposed: false,
				};

		instance.projectId = projectId ?? instance.projectId;
		instance.state = 'loading';
		if (makeActive) {
			instance.lastActiveAt = this.now();
		}

		this.hostedWorkspaces.addInstance(instance);
		this.traceRestore(
			`instance:create makeActive=${makeActive} state=${instance.state}`,
			instance
		);
		this.emitState();

		try {
			await this.attachInstance(instance, makeActive);
			this.traceRestore(
				`instance:attached makeActive=${makeActive} state=${instance.state}`,
				instance
			);
			if (makeActive) {
				this.activateInstance(instance);
			} else {
				this.emitState();
			}

			return instance;
		} catch (error) {
			await this.destroyInstance(instance, true, false);
			if (instance.instanceId === this.activeInstanceId) {
				this.activeInstanceId =
					previousActiveInstanceId !== instance.instanceId
						? previousActiveInstanceId
						: undefined;
				this.emitState();
			}
			throw error;
		}
	}

	private async attachInstance(
		instance: IHostedWorkbenchInstance,
		makeActive: boolean
	): Promise<void> {
		this.traceRestore(`attach:start makeActive=${makeActive}`, instance);
		const configObjectUrl = this.protocolMainService
			.createIPCObjectUrl<INativeWindowConfiguration>();
		const view = this.viewFactory.createView(
			configObjectUrl,
			this.environmentMainService.useCodeCache
		);

		instance.view = view;
		instance.configObjectUrl = configObjectUrl;
		const webContents = view.webContents;
		const webContentsId = webContents.id;

		configObjectUrl.update(
			this.createHostedConfiguration(
				instance,
				webContentsId
			)
		);

		view.setBackgroundColor(this.themeMainService.getBackgroundColor());
		view.setVisible(false);
		view.webContents.on('focus', () => {
			if (!this.instancesById.has(instance.instanceId)) {
				return;
			}

			this.lastFocusedSurface = 'workspace';
			this.updateInstanceState(instance, { focused: true });
		});
		view.webContents.on('blur', () => {
			if (!this.instancesById.has(instance.instanceId)) {
				return;
			}

			this.updateInstanceState(instance, { focused: false });
		});
		view.webContents.on('before-input-event', (_event, input) => {
			if (
				instance.instanceId !== this.activeInstanceId ||
				!this.isPasteKeyDown(input)
			) {
				return;
			}

			_event.preventDefault();
			this.triggerPasteInWorkspace();
		});
		view.webContents.on('did-start-loading', () => {
			this.trustView(instance);
		});
		view.webContents.on('did-start-navigation', () => {
			this.trustView(instance);
		});
		view.webContents.on('render-process-gone', () => {
			if (!this.instancesById.has(instance.instanceId) ||
				instance.disposed) {
				return;
			}

			this.untrustView(instance);
			this.browserViewMainService
				.destroyBrowserViewsForHostedWebContents(webContentsId);
			this.setViewVisible(instance, false);
			this.updateInstanceState(instance, {
				state: 'crashed',
				focused: false,
				visible: false,
			});
		});
		webContents.once('destroyed', () => {
			this.untrustView(instance);
			if (!instance.disposed &&
				this.instancesById.has(instance.instanceId)) {
				this.browserViewMainService
					.destroyBrowserViewsForHostedWebContents(webContentsId);
				instance.view = undefined;
				instance.attached = false;
				this.updateInstanceState(instance, {
					state: 'crashed',
					focused: false,
					visible: false,
				});
			}
		});

		this.attachInstanceView(instance);
		this.layout(this.bounds);
		this.setViewVisible(instance, makeActive);
		this.trustView(instance);

		const windowResourcePath = this.environmentMainService.isBuilt
			? 'vs/code/electron-browser/workbench/workbench.html'
			: 'vs/code/electron-browser/workbench/workbench-dev.html';
		const windowUrl = FileAccess
			.asBrowserUri(windowResourcePath)
			.toString(true);

		const loadStartedAt = Date.now();
		this.traceRestore('loadURL:start', instance);
		await view.webContents.loadURL(windowUrl);
		this.traceRestore(
			`loadURL:complete duration=${Date.now() - loadStartedAt}ms`,
			instance
		);
	}

	private createHostedConfiguration(
		instance: IHostedWorkbenchInstance,
		hostedWebContentsId: number
	): INativeWindowConfiguration {
		const baseConfig = this.window.config;
		if (!baseConfig) {
			throw new Error('Omni-window configuration is unavailable.');
		}

		const workspace = getSingleFolderWorkspaceIdentifier(
			URI.file(instance.worktreePath),
			statSync(instance.worktreePath)
		);
		if (!workspace) {
			throw new Error(
				`Unable to resolve hosted workspace identifier for ` +
				`${instance.worktreePath}.`
			);
		}

		return {
			...baseConfig,
			workspace,
			backupPath: undefined,
			filesToOpenOrCreate: undefined,
			filesToDiff: undefined,
			filesToMerge: undefined,
			filesToWait: undefined,
			isSessionsWindow: false,
			isOmniWindow: false,
			isHostedOmniWorkspace: true,
			hostedWebContentsId,
			hostedInstanceId: instance.instanceId,
			omniActiveWorktreePath: undefined,
			omniResidentWorkspaces: undefined,
		};
	}

	private activateInstance(instance: IHostedWorkbenchInstance): void {
		this.traceRestore(
			`activate:start previousActive=${this.activeInstanceId ?? '<none>'}`,
			instance
		);
		const previousActive = this.getActiveInstance();
		if (previousActive &&
			previousActive.instanceId !== instance.instanceId) {
			this.setViewVisible(previousActive, false);
			this.updateInstanceState(previousActive, {
				focused: false,
			});
		}

		this.hostedWorkspaces.activateInstance(instance);
		this.setViewVisible(instance, true);
		this.updateInstanceState(instance, {
			visible: true,
			lastActiveAt: instance.lastActiveAt,
		});
		this.traceRestore(`activate:complete state=${instance.state}`, instance);
	}

	layout(bounds: IRectangle): void {
		this.bounds = bounds;
		if (!this.window.win) {
			return;
		}

		for (const instance of this.instancesById.values()) {
			this.setInstanceBounds(instance, bounds);
		}
		this.bringActiveInstanceToFront();
	}

	async closeWorkspace(instanceId?: string): Promise<void> {
		await this.ensureRestored();

		const target = instanceId
			? this.instancesById.get(instanceId)
			: this.getActiveInstance();
		if (!target) {
			return;
		}

		const wasActive = target.instanceId === this.activeInstanceId;
		let nextActive: IHostedWorkbenchInstance | undefined;
		if (wasActive) {
			nextActive = getMostRecentHostedWorkspace(
				this.instancesById.values(),
				target.instanceId,
				instance => instance.disposed
			);
		}

		const closed = await this.destroyInstance(target, true);
		if (!closed) {
			return;
		}

		if (wasActive) {
			this.activeInstanceId = undefined;
			if (nextActive) {
				this.activateInstance(nextActive);
			} else {
				this.emitState();
			}
		} else {
			this.emitState();
		}
	}

	private async destroyInstance(
		instance: IHostedWorkbenchInstance,
		removeFromMaps: boolean,
		graceful: boolean = true,
		reason: UnloadReason = UnloadReason.CLOSE,
		ignoreUnloadVeto: boolean = false
	): Promise<boolean> {
		if (graceful) {
			const veto = await this.unloadInRenderer(
				instance,
				reason,
				ignoreUnloadVeto
			);
			if (veto) {
				if (!ignoreUnloadVeto) {
					this.logService.trace(
						'[HucodeShellMainService] Hosted workspace unload ' +
						`vetoed for ${instance.worktreePath}.`
					);
					return false;
				}

				this.logService.warn(
					'[HucodeShellMainService] Ignoring hosted workspace ' +
					`unload veto during Omni shutdown for ` +
					`${instance.worktreePath}.`
				);
			}
		}

		instance.disposed = true;
		instance.state = 'unloaded';
		instance.focused = false;
		instance.visible = false;

		if (instance.view) {
			const view = instance.view;
			const webContents = this.getLiveWebContents(instance);
			if (webContents) {
				this.browserViewMainService
					.destroyBrowserViewsForHostedWebContents(webContents.id);
			}
			this.untrustView(instance);
			view.setVisible(false);
			this.detachInstanceView(instance);
			if (webContents) {
				webContents.close({ waitForBeforeUnload: false });
			}
			instance.view = undefined;
		}

		instance.configObjectUrl?.dispose();
		instance.configObjectUrl = undefined;

		if (removeFromMaps) {
			this.hostedWorkspaces.removeInstance(instance);
		}

		return true;
	}

	async shutdownAllWorkspaces(reason: UnloadReason): Promise<void> {
		const instances = Array.from(this.instancesById.values());
		for (const instance of instances) {
			if (instance.disposed) {
				continue;
			}

			await this.destroyInstance(instance, false, true, reason, true);
		}
	}

	private async unloadInRenderer(
		instance: IHostedWorkbenchInstance,
		reason: UnloadReason,
		ignoreBeforeUnloadVeto: boolean = false
	): Promise<boolean> {
		const webContents = instance.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return false;
		}

		const beforeUnloadVeto = await this.onBeforeUnloadInRenderer(
			webContents,
			instance,
			reason
		);
		if (beforeUnloadVeto) {
			if (ignoreBeforeUnloadVeto) {
				await this.onWillUnloadInRenderer(
					webContents,
					instance,
					reason
				);
			}
			return true;
		}

		await this.onWillUnloadInRenderer(webContents, instance, reason);
		return false;
	}

	private onBeforeUnloadInRenderer(
		webContents: Electron.WebContents,
		instance: IHostedWorkbenchInstance,
		reason: UnloadReason
	): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			const oneTimeEventToken = this.createOneTimeEventToken(instance);
			const okChannel = `vscode:ok${oneTimeEventToken}`;
			const cancelChannel = `vscode:cancel${oneTimeEventToken}`;

			let settled = false;

			const handleOk = () => complete(false);
			const handleCancel = () => complete(true);
			const handleDestroyed = () => complete(false);

			const complete = (veto: boolean) => {
				if (settled) {
					return;
				}

				settled = true;
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}

				this.ipcMain.removeListener(okChannel, handleOk);
				this.ipcMain.removeListener(cancelChannel, handleCancel);
				webContents.removeListener('destroyed', handleDestroyed);

				resolve(veto);
			};

			this.ipcMain.once(okChannel, handleOk);
			this.ipcMain.once(cancelChannel, handleCancel);
			webContents.once('destroyed', handleDestroyed);
			const timeoutHandle = setTimeout(() => {
				this.logService.warn(
					'[HucodeShellMainService] Timed out waiting for hosted ' +
					`workspace before-unload reply for ${instance.worktreePath}.`
				);
				complete(false);
			}, this.beforeUnloadTimeoutMs);

			try {
				webContents.send('vscode:onBeforeUnload', {
					okChannel,
					cancelChannel,
					reason
				});
			} catch (error) {
				this.logService.warn(
					'[HucodeShellMainService] Failed to send hosted workspace ' +
					`before-unload for ${instance.worktreePath}: ${error}`
				);
				complete(false);
			}
		});
	}

	private onWillUnloadInRenderer(
		webContents: Electron.WebContents,
		instance: IHostedWorkbenchInstance,
		reason: UnloadReason
	): Promise<void> {
		return new Promise<void>(resolve => {
			const oneTimeEventToken = this.createOneTimeEventToken(instance);
			const replyChannel = `vscode:reply${oneTimeEventToken}`;

			let settled = false;

			const handleReply = () => complete();
			const handleDestroyed = () => complete();

			const complete = () => {
				if (settled) {
					return;
				}

				settled = true;
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}

				this.ipcMain.removeListener(replyChannel, handleReply);
				webContents.removeListener('destroyed', handleDestroyed);

				resolve();
			};

			this.ipcMain.once(replyChannel, handleReply);
			webContents.once('destroyed', handleDestroyed);
			const timeoutHandle = setTimeout(() => {
				this.logService.warn(
					'[HucodeShellMainService] Timed out waiting for hosted ' +
					`workspace will-unload reply for ${instance.worktreePath}.`
				);
				complete();
			}, this.willUnloadTimeoutMs);

			try {
				webContents.send('vscode:onWillUnload', {
					replyChannel,
					reason
				});
			} catch (error) {
				this.logService.warn(
					'[HucodeShellMainService] Failed to send hosted workspace ' +
					`will-unload for ${instance.worktreePath}: ${error}`
				);
				complete();
			}
		});
	}

	private createOneTimeEventToken(instance: IHostedWorkbenchInstance): string {
		return `:${this.window.id}:${instance.instanceId}:` +
			`${this.oneTimeListenerTokenGenerator++}`;
	}

	focusWorkspace(): void {
		const activeInstance = this.getActiveInstance();
		if (!activeInstance?.view) {
			return;
		}

		this.lastFocusedSurface = 'workspace';
		this.bringInstanceToFront(activeInstance);
		activeInstance.view.webContents.focus();
	}

	focusShell(): void {
		this.lastFocusedSurface = 'shell';
		this.window.win?.webContents.focus();
	}

	setProjectsSidebarVisible(visible: boolean): void {
		if (!this.hostedWorkspaces.setProjectsSidebarVisible(
			visible,
			this.hasLoadedWorkbench()
		)) {
			return;
		}

		if (!this.projectsSidebarVisible) {
			this.expandActiveInstanceToWindowLeft();
		}
		this.emitState();
	}

	setProjectSwitcherNavigationState(
		canGoBack: boolean,
		canGoForward: boolean
	): void {
		if (!this.hostedWorkspaces.setProjectSwitcherNavigationState(
			canGoBack,
			canGoForward
		)) {
			return;
		}

		this.emitState();
	}

	runActionInShell(request: INativeRunActionInWindowRequest): boolean {
		const webContents = this.window.win?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return false;
		}

		try {
			webContents.send(
				'vscode:runAction',
				this.withOmniForwardingMarker(request)
			);
			return true;
		} catch (error) {
			this.logService.warn(
				'[HucodeShellMainService] Failed to forward shell action ' +
				`${request.id}: ${error}`
			);
			return false;
		}
	}

	reloadWorkspace(): void {
		this.getActiveInstance()?.view?.webContents.reload();
	}

	toggleWorkspaceDevTools(): boolean {
		const webContents = this.getActiveInstance()?.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return false;
		}

		webContents.toggleDevTools();
		return true;
	}

	async captureWorkspaceScreenshot(
		rect?: IRectangle,
		quality: number = 80
	): Promise<VSBuffer | undefined> {
		const webContents = this.getActiveInstance()?.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return undefined;
		}

		try {
			const image = await webContents.capturePage(rect, {
				stayHidden: true
			});
			return VSBuffer.wrap(image.toJPEG(quality));
		} catch (error) {
			this.logService.warn(
				'[HucodeShellMainService] Failed to capture hosted ' +
				`workspace screenshot: ${error}`
			);
			return undefined;
		}
	}

	setWorkspaceOverlayOcclusion(occluded: boolean): void {
		const wasOccluded = this.overlayOccluded;
		if (wasOccluded === occluded) {
			this.reconcileViewVisibility('overlay:unchanged');
			return;
		}

		this.overlayOccluded = occluded;
		this.reconcileViewVisibility('overlay:changed');
	}

	async runActionInWorkspace(
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		await this.ensureRestored();
		return this.sendToActiveWorkspace(
			'vscode:runAction',
			this.withOmniForwardingMarker(request)
		);
	}

	async runKeybindingInWorkspace(
		request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		await this.ensureRestored();
		if (this.getFocusedSurface() === 'workspace') {
			return this.hasActiveWorkspace();
		}

		return this.sendToActiveWorkspace(
			'vscode:runKeybinding',
			this.withOmniForwardingMarker(request)
		);
	}

	triggerPasteInWorkspace(): boolean {
		const activeInstance = this.getActiveInstance();
		if (!activeInstance) {
			return false;
		}

		const webContents = activeInstance.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return false;
		}

		try {
			this.lastFocusedSurface = 'workspace';
			this.bringInstanceToFront(activeInstance);
			webContents.focus();
			webContents.paste();
			return true;
		} catch (error) {
			this.logService.warn(
				'[HucodeShellMainService] Failed to trigger hosted ' +
				`workspace paste: ${error}`
			);
			return false;
		}
	}

	private sendToActiveWorkspace(channel: string, request: unknown): boolean {
		const activeInstance = this.getActiveInstance();
		if (!activeInstance) {
			return false;
		}

		return this.sendToWorkspace(activeInstance, channel, request);
	}

	private sendToWorkspace(
		instance: IHostedWorkbenchInstance,
		channel: string,
		request: unknown
	): boolean {
		if (this.activeInstanceId !== instance.instanceId) {
			this.activateInstance(instance);
		}

		const webContents = instance.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return false;
		}

		try {
			this.lastFocusedSurface = 'workspace';
			this.bringInstanceToFront(instance);
			webContents.focus();
			webContents.send(channel, request);
			return true;
		} catch (error) {
			this.logService.warn(
				'[HucodeShellMainService] Failed to forward ' +
				`hosted workspace ${channel}: ${error}`
			);
			return false;
		}
	}

	private withOmniForwardingMarker<
		T extends
		| INativeRunActionInWindowRequest
		| INativeRunKeybindingInWindowRequest
	>(request: T): T {
		return {
			...request,
			hucodeForwardedFromOmniShell: true,
		};
	}

	private hasActiveWorkspace(): boolean {
		const webContents = this.getActiveInstance()?.view?.webContents;
		return !!webContents && !webContents.isDestroyed();
	}

	private getFocusedSurface(): OmniFocusedSurface {
		const activeWebContents = this.getActiveInstance()?.view?.webContents;
		if (
			activeWebContents &&
			!activeWebContents.isDestroyed() &&
			activeWebContents.isFocused()
		) {
			return 'workspace';
		}

		const shellWebContents = this.window.win?.webContents;
		if (
			shellWebContents &&
			!shellWebContents.isDestroyed() &&
			shellWebContents.isFocused()
		) {
			return 'shell';
		}

		return this.lastFocusedSurface;
	}

	private restoreWindowFocus(): void {
		const surface =
			this.windowFocusRestoreSurface ?? this.lastFocusedSurface;
		this.windowFocusRestoreSurface = undefined;

		if (surface === 'workspace' && this.hasActiveWorkspace()) {
			this.focusWorkspace();
			return;
		}

		this.focusShell();
	}

	private isPasteKeyDown(input: Electron.Input): boolean {
		return input.type === 'keyDown' &&
			input.meta &&
			!input.control &&
			!input.alt &&
			!input.shift &&
			input.key.toLowerCase() === 'v';
	}

	private traceRestore(
		message: string,
		instance?: IHostedWorkbenchInstance
	): void {
		if (!this.traceRestoreToStdout) {
			return;
		}

		const elapsed = this.now() - this.traceRestoreStartedAt;
		const instanceDetails = instance
			? ` instance=${instance.instanceId}` +
			` state=${instance.state}` +
			` active=${instance.instanceId === this.activeInstanceId}` +
			` visible=${instance.visible}` +
			` attached=${instance.attached}` +
			` path=${instance.worktreePath}`
			: '';
		console.log(
			`[HucodeOmniRestore +${elapsed}ms win=${this.window.id}] ` +
			`${message}${instanceDetails}`
		);
	}

	private get instancesById(): Map<string, IHostedWorkbenchInstance> {
		return this.hostedWorkspaces.instancesById;
	}

	private get instanceIdsByPath(): Map<string, string> {
		return this.hostedWorkspaces.instanceIdsByPath;
	}

	private get activeInstanceId(): string | undefined {
		return this.hostedWorkspaces.activeInstanceId;
	}

	private set activeInstanceId(instanceId: string | undefined) {
		this.hostedWorkspaces.activeInstanceId = instanceId;
	}

	private get projectsSidebarVisible(): boolean {
		return this.hostedWorkspaces.projectsSidebarVisible;
	}

	private set projectsSidebarVisible(visible: boolean) {
		this.hostedWorkspaces.projectsSidebarVisible = visible;
	}

	override dispose(): void {
		for (const instance of Array.from(this.instancesById.values())) {
			void this.destroyInstance(instance, true, false);
		}

		super.dispose();
	}
}
