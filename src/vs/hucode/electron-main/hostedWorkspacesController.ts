/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { Stats, statSync } from 'fs';
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
import {
	createLegacyHucodeHostedShellActionRequest,
	HucodeHostedShellAction,
	formatHucodeHostedShellActionCommandIdForLog,
	getHucodeHostedShellAction,
} from '../../platform/window/common/hucodeHostedShellActions.js';
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedNavigationRequest,
	IHucodeHostedShellAuthorityState,
	IHucodeHostedShellBinding,
	IHucodeHostedShellContinuationAuthorization,
} from '../../platform/window/common/hucodeHostedShellService.js';
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
	hasLoadedHostedWorkspace,
	HostedWorkspaceStateModel,
	isHostedWorkspaceRestorable,
	waitForHostedWorkspaceReady,
} from '../common/hostedWorkspaceState.js';
import {
	createHostedWorkbenchRestorePlan,
	HucodeHostedWorkbenchRestorePolicy,
	RetainedWorkbenchCatalog,
} from '../common/retainedWorkbench.js';
import { ProjectSwitcherOmniSection } from
	'../common/projectSwitcher/projectSwitcherViewState.js';
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
	readonly restorePolicy?: HucodeHostedWorkbenchRestorePolicy;
	readonly beforeUnloadTimeoutMs?: number;
	readonly willUnloadTimeoutMs?: number;
	readonly readyTimeoutMs?: number;
	readonly createInstanceId?: () => string;
	readonly now?: () => number;
	readonly viewFactory?: IHostedWorkbenchViewFactory;
	readonly ipcMain?: IHostedWorkspaceIpcMain;
}

/** Returns whether a file-system error makes a hosted folder unavailable. */
export function isHostedWorkspaceFolderUnavailableError(
	error: unknown
): boolean {
	const code = error && typeof error === 'object'
		? (error as NodeJS.ErrnoException).code
		: undefined;
	return code === 'ENOENT' || code === 'ENOTDIR' ||
		code === 'EACCES' || code === 'EPERM';
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
	lifecycleGeneration: number;
	connectionGeneration: number;
	interruptedUnloadReloadGeneration?: number;
	disposed: boolean;
}

interface IProjectCatalogSnapshot {
	readonly liveProjectIds: ReadonlySet<string> | undefined;
	readonly projectIdsByPath: ReadonlyMap<string, string>;
}

type OmniFocusedSurface = 'shell' | 'workspace';

function unloadReasonRank(reason: UnloadReason): number {
	switch (reason) {
		case UnloadReason.RELOAD:
			return 0;
		case UnloadReason.LOAD:
			return 1;
		case UnloadReason.CLOSE:
			return 2;
		case UnloadReason.QUIT:
			return 3;
	}
}

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
	private readonly retainedWorkbenches: RetainedWorkbenchCatalog;
	private restorePolicy: HucodeHostedWorkbenchRestorePolicy;

	private bounds: IRectangle = { x: 0, y: 0, width: 0, height: 0 };
	private restored = false;
	private shuttingDown = false;
	private terminalShutdownRequested = false;
	private shutdownReason: UnloadReason | undefined;
	private shutdownPromise: Promise<void> | undefined;
	private stateEmissionDeferrals = 0;
	private stateEmissionPending = false;
	private activationIntentGeneration = 0;
	private projectCatalogSnapshot: IProjectCatalogSnapshot | undefined;
	private lifecycleGeneration = 0;
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
			(webContentsId: number, instanceId: string) => void,
		private readonly untrustHostedWorkspaceWebContents:
			(webContentsId: number, instanceId: string) => void,
		private readonly invalidateHostedShellConnection:
			(webContentsId: number) => void,
		private readonly focusHostedWorkspaceByPath:
			(
				worktreePath: string,
				canApply: () => boolean
			) => Promise<HucodeHostedShellOperationOutcome>,
		private readonly focusNormalWindowByPath:
			(worktreePath: string) => Promise<boolean>,
		private readonly onStateChange: (state: IHucodeHostedWorkspaceState) => void,
		options: IResidentHostedWorkspacesControllerOptions = {},
	) {
		super();
		this.traceRestoreToStdout =
			process.env['HUCODE_OMNI_RESTORE_TRACE'] === '1';
		this.restorePolicy = options.restorePolicy ?? 'active';
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
		this.retainedWorkbenches = new RetainedWorkbenchCatalog(
			this.window.config?.omniRetainedWorkbenches,
			uri => getProjectManagerPathComparisonKey(uri.fsPath, isLinux),
			this.createInstanceId
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
		return {
			...this.hostedWorkspaces.toState(
				instance => this.toExternalInstance(instance)
			),
			retainedWorkbenches: this.retainedWorkbenches.all,
		};
	}

	acquireHostedShellBinding(
		webContentsId: number
	): IHucodeHostedShellBinding | undefined {
		const instance = Array.from(this.instancesById.values()).find(candidate =>
			candidate.trustedWebContentsId === webContentsId &&
			this.getLiveWebContents(candidate)?.id === webContentsId
		);
		if (!instance || instance.disposed) {
			return undefined;
		}

		this.invalidateHostedShellBinding(instance);
		return {
			windowId: this.window.id,
			instanceId: instance.instanceId,
			connectionGeneration: instance.connectionGeneration,
		};
	}

	releaseHostedShellBinding(binding: IHucodeHostedShellBinding): void {
		const instance = this.instancesById.get(binding.instanceId);
		if (instance && this.isCurrentHostedShellBinding(instance, binding)) {
			this.invalidateHostedShellBinding(instance);
		}
	}

	getHostedShellAuthorityState(
		binding: IHucodeHostedShellBinding
	): IHucodeHostedShellAuthorityState {
		const instance = this.instancesById.get(binding.instanceId);
		const bindingIsCurrent = !!instance &&
			this.isCurrentHostedShellBinding(instance, binding);
		const state = this.getState();
		return {
			connectionGeneration: bindingIsCurrent
				? instance.connectionGeneration
				: -1,
			disposed: !bindingIsCurrent,
			projectsSidebarVisible: state.projectsSidebarVisible,
			projectSwitcherCanGoBack: state.projectSwitcherCanGoBack,
			projectSwitcherCanGoForward: state.projectSwitcherCanGoForward,
			activeInstanceId: state.activeInstanceId,
			instances: state.instances.map(candidate => ({
				instanceId: candidate.instanceId,
				state: candidate.state,
				visible: candidate.visible,
			})),
		};
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
		if (this.stateEmissionDeferrals > 0) {
			this.stateEmissionPending = true;
			return;
		}
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
		if (this.shuttingDown || !this.window.config) {
			return;
		}

		this.window.config.omniActiveWorktreePath =
			this.getActiveInstance()?.worktreePath;
		this.window.config.omniResidentWorkspaces = this.getRestoreEntries();
		this.window.config.omniRetainedWorkbenches =
			this.retainedWorkbenches.all;
	}

	private getRestoreEntries(): IOmniWorkspaceRestoreEntry[] {
		return createHostedWorkspaceRestoreEntries(
			Array.from(this.instancesById.values()).filter(instance =>
				!!instance.projectId
			),
			this.activeInstanceId
		);
	}

	setRestorePolicy(policy: HucodeHostedWorkbenchRestorePolicy): void {
		if (!this.restored && !this.restorePromise) {
			this.restorePolicy = policy;
		}
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

	notifyHostedShellReady(binding: IHucodeHostedShellBinding): boolean {
		const instance = this.getBoundHostedShellInstance(binding);
		if (!instance) {
			return false;
		}
		this.notifyHostedWorkspaceReady(instance.instanceId);
		return true;
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
			this.trustHostedWorkspaceWebContents(
				view.webContents.id,
				instance.instanceId
			);
		}

		const processId = view.webContents.getProcessId();
		if (processId > 0 && !instance.trustedProcessIds.has(processId)) {
			instance.trustedProcessIds.add(processId);
			this.trustHostedWorkspaceProcess(processId);
		}
	}

	private untrustView(instance: IHostedWorkbenchInstance): void {
		this.invalidateHostedShellBinding(instance);
		if (typeof instance.trustedWebContentsId === 'number') {
			this.untrustHostedWorkspaceWebContents(
				instance.trustedWebContentsId,
				instance.instanceId
			);
			instance.trustedWebContentsId = undefined;
		}

		for (const processId of instance.trustedProcessIds) {
			this.untrustHostedWorkspaceProcess(processId);
		}

		instance.trustedProcessIds.clear();
	}

	private invalidateHostedShellBinding(
		instance: IHostedWorkbenchInstance
	): void {
		instance.connectionGeneration++;
		const webContentsId = instance.trustedWebContentsId ??
			instance.view?.webContents.id;
		if (typeof webContentsId === 'number') {
			this.invalidateHostedShellConnection(webContentsId);
		}
	}

	private isCurrentHostedShellBinding(
		instance: IHostedWorkbenchInstance,
		binding: IHucodeHostedShellBinding
	): boolean {
		return binding.windowId === this.window.id &&
			binding.instanceId === instance.instanceId &&
			binding.connectionGeneration === instance.connectionGeneration &&
			this.instancesById.get(instance.instanceId) === instance &&
			!instance.disposed &&
			instance.trustedWebContentsId === instance.view?.webContents.id;
	}

	private getBoundHostedShellInstance(
		binding: IHucodeHostedShellBinding,
		requireActiveVisible = false
	): IHostedWorkbenchInstance | undefined {
		const instance = this.instancesById.get(binding.instanceId);
		if (!instance || !this.isCurrentHostedShellBinding(instance, binding)) {
			return undefined;
		}
		if (requireActiveVisible && (
			this.activeInstanceId !== instance.instanceId ||
			!instance.visible
		)) {
			return undefined;
		}
		return instance;
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

		const restoreEntries = this.window.config?.omniResidentWorkspaces ?? [];
		this.adoptLegacyRetainedWorkbenches(restoreEntries);
		const retainedCandidates = this.retainedWorkbenches.all
			.filter(record => record.desiredState === 'loaded')
			.map(record => ({
				worktreePath: URI.revive(record.folderUri).fsPath,
				retainedWorkbenchId: record.id,
				lastActiveAt: record.lastActiveAt,
			}));
		const projectCandidates = restoreEntries
			.filter(entry => !!entry.projectId)
			.map(entry => ({
				worktreePath: entry.worktreePath,
				projectId: entry.projectId,
				lastActiveAt: entry.lastActiveAt,
			}));
		const candidates = [...projectCandidates, ...retainedCandidates];
		if (!candidates.length) {
			this.traceRestore('restore:start entries=0');
			this.restored = true;
			this.emitState();
			return;
		}

		const configuredActiveWorktreePath =
			this.window.config?.omniActiveWorktreePath;
		const plan = createHostedWorkbenchRestorePlan(
			candidates,
			configuredActiveWorktreePath,
			this.restorePolicy,
			(a, b) => getProjectManagerPathComparisonKey(a, isLinux) ===
				getProjectManagerPathComparisonKey(b, isLinux)
		);
		const activeWorktreePath = plan.eager[0]?.worktreePath;
		this.traceRestore(
			`restore:start entries=${candidates.length} ` +
			`active=${activeWorktreePath ?? '<none>'}`
		);
		this.createDormantInstances(plan.dormant);
		this.createRestorePendingInstances(plan.eager, activeWorktreePath);

		for (const [index, entry] of plan.eager.entries()) {
			try {
				this.traceRestore(
					`restore:entry index=${index + 1}/${plan.eager.length} ` +
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
		if (!this.getActiveInstance() && this.restorePolicy === 'active') {
			for (const entry of [...plan.dormant].sort((a, b) =>
				(b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
			)) {
				try {
					const instance = await this.createOrRestoreInstance(
						entry.worktreePath,
						entry.projectId,
						true
					);
					if (instance) {
						break;
					}
				} catch (error) {
					this.logService.warn(
						'[HucodeShellMainService] Failed to restore fallback ' +
						`workspace ${entry.worktreePath}: ${error}`
					);
				}
			}
		}

		this.restored = true;
		this.activateMostRecentRestoredInstance();
		this.traceRestore('restore:complete');
		this.emitState();
	}

	private adoptLegacyRetainedWorkbenches(
		entries: readonly IOmniWorkspaceRestoreEntry[]
	): void {
		for (const entry of entries) {
			if (!entry.projectId) {
				this.retainedWorkbenches.retain(
					URI.file(entry.worktreePath),
					'loaded',
					entry.lastActiveAt
				);
			}
		}
	}

	private createDormantInstances(
		entries: readonly {
			readonly projectId?: string;
			readonly worktreePath: string;
			readonly lastActiveAt?: number;
		}[]
	): void {
		for (const entry of entries) {
			if (this.hostedWorkspaces.getInstanceByPath(entry.worktreePath)) {
				continue;
			}

			this.hostedWorkspaces.addInstance({
				instanceId: this.createInstanceId(),
				projectId: entry.projectId,
				worktreePath: entry.worktreePath,
				trustedProcessIds: new Set<number>(),
				attached: false,
				state: 'dormant',
				visible: false,
				focused: false,
				lastActiveAt: entry.lastActiveAt,
				lifecycleGeneration: 0,
				connectionGeneration: 0,
				disposed: false,
			});
		}
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
		entries: readonly {
			readonly projectId?: string;
			readonly worktreePath: string;
			readonly lastActiveAt?: number;
		}[],
		activeWorktreePath: string | undefined
	): void {
		for (const entry of entries) {
			if (this.hostedWorkspaces.getInstanceByPath(entry.worktreePath)) {
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
				lifecycleGeneration: 0,
				connectionGeneration: 0,
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
		projectId?: string,
		canActivate: () => boolean = () => true,
		canApply: () => boolean = () => true
	): Promise<void> {
		if (this.shuttingDown) {
			return;
		}

		await this.ensureRestored();
		if (this.shuttingDown || !canApply()) {
			return;
		}

		const retainedBeforeOpen = this.retainedWorkbenches.getByUri(
			URI.file(worktreePath)
		);
		const retainedSnapshot = retainedBeforeOpen && {
			...retainedBeforeOpen,
		};
		const activationIntent = ++this.activationIntentGeneration;
		let existing = this.hostedWorkspaces.getInstanceByPath(worktreePath);
		const instanceBeforeTeardown = existing;
		let effectiveProjectId = this.resolveProjectIdAgainstCatalog(
			worktreePath,
			projectId ?? existing?.projectId
		);

		if (existing) {
			if (
				!existing.disposed &&
				existing.state !== 'crashed' &&
				existing.state !== 'unloaded' &&
				existing.state !== 'dormant'
			) {
				const retained = this.retainedWorkbenches.getByUri(
					URI.file(worktreePath)
				);
				if (effectiveProjectId && retained) {
					this.retainedWorkbenches.dismiss(retained.id);
				} else if (!effectiveProjectId) {
					this.retainedWorkbenches.retain(
						URI.file(worktreePath),
						'loaded'
					);
				}
				existing.projectId = effectiveProjectId;
				if (canActivate()) {
					this.activateInstance(existing, activationIntent);
				}
				return;
			}

			if (existing.state !== 'dormant') {
				await this.destroyInstance(existing, true, false);
				if (!canApply()) {
					this.emitState();
					return;
				}
			}
		}

		existing = this.hostedWorkspaces.getInstanceByPath(worktreePath);
		effectiveProjectId = this.resolveProjectIdAgainstCatalog(
			worktreePath,
			existing && existing !== instanceBeforeTeardown
				? existing.projectId
				: projectId ?? existing?.projectId
		);
		const retained = this.retainedWorkbenches.getByUri(
			URI.file(worktreePath)
		);
		if (effectiveProjectId && retained) {
			this.retainedWorkbenches.dismiss(retained.id);
		} else if (!effectiveProjectId) {
			this.retainedWorkbenches.retain(
				URI.file(worktreePath),
				'loaded'
			);
		}
		if (existing && (
			!existing.disposed &&
			existing.state !== 'crashed' &&
			existing.state !== 'unloaded' &&
			existing.state !== 'dormant'
		)) {
			existing.projectId = effectiveProjectId;
			if (activationIntent === this.activationIntentGeneration &&
				canActivate()) {
				this.activateInstance(existing, activationIntent);
			}
			return;
		}

		let supersededOpenRolledBack = false;
		await this.createOrRestoreInstance(
			worktreePath,
			effectiveProjectId,
			true,
			activationIntent,
			canActivate,
			canApply,
			() => supersededOpenRolledBack = true
		);
		if (supersededOpenRolledBack) {
			if (retainedSnapshot) {
				const restored = this.retainedWorkbenches.update(
					retainedSnapshot.id,
					{
						desiredState: retainedSnapshot.desiredState,
						folderStatus: retainedSnapshot.folderStatus,
						lastActiveAt: retainedSnapshot.lastActiveAt,
					}
				);
				if (!restored) {
					this.retainedWorkbenches.restore(retainedSnapshot);
				}
			} else if (!retained &&
				!this.hostedWorkspaces.getInstanceByPath(worktreePath)) {
				const createdRetained = this.retainedWorkbenches.getByUri(
					URI.file(worktreePath)
				);
				if (createdRetained) {
					this.retainedWorkbenches.dismiss(createdRetained.id);
				}
			}
			this.emitState();
		}
	}

	async retainAndOpenWorkbench(folderUri: URI): Promise<void> {
		await this.openWorkspace(folderUri.fsPath);
	}

	async navigateHostedShellToFolder(
		binding: IHucodeHostedShellBinding,
		request: IHucodeHostedNavigationRequest,
		authorization: IHucodeHostedShellContinuationAuthorization
	): Promise<HucodeHostedShellOperationOutcome> {
		const resource = URI.revive(request.folderUri);
		if (resource.scheme !== 'file') {
			return HucodeHostedShellOperationOutcome.Unsupported;
		}
		if (!this.getBoundHostedShellInstance(binding, true)) {
			return HucodeHostedShellOperationOutcome.Rejected;
		}

		await this.ensureRestored();
		if (!await authorization.isCurrentAndActiveVisible()) {
			return HucodeHostedShellOperationOutcome.Superseded;
		}
		const canApply = () =>
			!!this.getBoundHostedShellInstance(binding, true);
		const hostedFocusOutcome = await this.focusHostedWorkspaceByPath(
			resource.fsPath,
			canApply
		);
		if (hostedFocusOutcome !==
			HucodeHostedShellOperationOutcome.Unavailable) {
			return hostedFocusOutcome;
		}
		if (canApply() &&
			await this.focusNormalWindowByPath(resource.fsPath)) {
			return HucodeHostedShellOperationOutcome.Accepted;
		}
		let activationAuthorized = false;
		const canActivate = () => {
			activationAuthorized = canApply();
			return activationAuthorized;
		};
		await this.openWorkspace(
			resource.fsPath,
			undefined,
			canActivate,
			canApply
		);
		const active = this.getActiveInstance();
		return activationAuthorized && active &&
			this.hostedWorkspaces.getInstanceByPath(resource.fsPath) === active &&
			this.getBoundHostedShellInstance(binding)
			? HucodeHostedShellOperationOutcome.Accepted
			: HucodeHostedShellOperationOutcome.Superseded;
	}

	/** Gracefully unloads a ready renderer and leaves it dormant. */
	async suspendWorkspace(instanceId: string): Promise<void> {
		await this.ensureRestored();
		const instance = this.instancesById.get(instanceId);
		if (!instance || (
			instance.state !== 'active' && instance.state !== 'loaded'
		)) {
			return;
		}

		await this.deferStateEmission(async () => {
			const lifecycleGeneration = instance.lifecycleGeneration;
			const suspended = await this.destroyInstance(
				instance,
				true,
				true,
				UnloadReason.CLOSE,
				false,
				lifecycleGeneration
			);
			if (!suspended) {
				return;
			}

			this.hostedWorkspaces.addInstance({
				instanceId: this.createInstanceId(),
				projectId: instance.projectId,
				worktreePath: instance.worktreePath,
				trustedProcessIds: new Set<number>(),
				attached: false,
				state: 'dormant',
				visible: false,
				focused: false,
				lastActiveAt: instance.lastActiveAt,
				lifecycleGeneration: 0,
				connectionGeneration: 0,
				disposed: false,
			});

			if (!this.getActiveInstance()) {
				const nextActive = getMostRecentHostedWorkspace(
					this.instancesById.values(),
					undefined,
					candidate => candidate.disposed
				);
				if (nextActive) {
					this.activateInstance(nextActive);
					return;
				}
			}
			this.emitState();
		});
	}

	async unloadRetainedWorkbench(workbenchId: string): Promise<void> {
		await this.ensureRestored();
		const record = this.retainedWorkbenches.getById(workbenchId);
		if (!record) {
			return;
		}

		await this.deferStateEmission(async () => {
			const instance = this.hostedWorkspaces.getInstanceByPath(
				URI.revive(record.folderUri).fsPath
			);
			if (instance && instance.state !== 'dormant') {
				if (!await this.closeInstance(instance)) {
					return;
				}
			} else if (instance) {
				this.hostedWorkspaces.removeInstance(instance);
			}
			this.retainedWorkbenches.update(workbenchId, {
				desiredState: 'unloaded',
			});
			this.emitState();
		});
	}

	async dismissRetainedWorkbench(workbenchId: string): Promise<void> {
		await this.ensureRestored();
		const record = this.retainedWorkbenches.getById(workbenchId);
		if (!record) {
			return;
		}

		await this.deferStateEmission(async () => {
			const instance = this.hostedWorkspaces.getInstanceByPath(
				URI.revive(record.folderUri).fsPath
			);
			if (instance && instance.state !== 'dormant') {
				if (!await this.closeInstance(instance)) {
					return;
				}
			} else if (instance) {
				this.hostedWorkspaces.removeInstance(instance);
			}
			this.retainedWorkbenches.dismiss(workbenchId);
			this.emitState();
		});
	}

	private async deferStateEmission<T>(operation: () => Promise<T>): Promise<T> {
		this.stateEmissionDeferrals++;
		try {
			return await operation();
		} finally {
			this.stateEmissionDeferrals--;
			if (this.stateEmissionDeferrals === 0 && this.stateEmissionPending) {
				this.stateEmissionPending = false;
				this.emitState();
			}
		}
	}

	reorderRetainedWorkbenches(orderedIds: readonly string[]): void {
		if (this.retainedWorkbenches.reorder(orderedIds)) {
			this.emitState();
		}
	}

	/**
	 * Updates or resets a retained workbench label, emitting state when the
	 * catalog changes.
	 */
	setRetainedWorkbenchLabel(
		workbenchId: string,
		label: string | undefined,
	): void {
		if (this.retainedWorkbenches.setLabel(workbenchId, label)) {
			this.emitState();
		}
	}

	async reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
		projects: readonly {
			readonly projectId: string;
			readonly folderUris: readonly URI[];
		}[]
	): Promise<void> {
		await this.ensureRestored();
		const liveProjectIds = new Set(projects.map(project =>
			project.projectId
		));
		const projectFolders = projects.flatMap(project =>
			project.folderUris.map(folderUri => ({
				projectId: project.projectId,
				folderUri,
			}))
		);
		const projectIdsByPath = new Map(projectFolders.map(folder => [
			getProjectManagerPathComparisonKey(
				folder.folderUri.fsPath,
				isLinux
			),
			folder.projectId,
		]));
		this.projectCatalogSnapshot = {
			liveProjectIds,
			projectIdsByPath,
		};
		let changed = false;
		for (const instance of this.instancesById.values()) {
			const claimedProjectId = projectIdsByPath.get(
				getProjectManagerPathComparisonKey(
					instance.worktreePath,
					isLinux
				)
			);
			if (claimedProjectId) {
				changed ||= instance.projectId !== claimedProjectId;
				instance.projectId = claimedProjectId;
				continue;
			}
			if (
				!isHostedWorkspaceRestorable(instance) ||
				!instance.projectId ||
				liveProjectIds.has(instance.projectId)
			) {
				continue;
			}

			this.retainedWorkbenches.retain(
				URI.file(instance.worktreePath),
				'loaded',
				instance.lastActiveAt
			);
			instance.projectId = undefined;
			changed = true;
		}
		if (this.retainedWorkbenches.reconcileProjectPaths(
			projectFolders.map(folder => folder.folderUri)
		)) {
			changed = true;
		}
		if (changed) {
			this.emitState();
		}
	}

	async promoteRetainedWorkbenchProjectFolders(
		projectFolders: readonly {
			readonly projectId: string;
			readonly folderUri: URI;
		}[]
	): Promise<void> {
		await this.ensureRestored();
		this.recordProjectFolderPromotions(projectFolders);
		if (this.applyProjectFolderPromotions(projectFolders)) {
			this.emitState();
		}
	}

	private applyProjectFolderPromotions(projectFolders: readonly {
		readonly projectId: string;
		readonly folderUri: URI;
	}[]): boolean {
		let changed = false;
		for (const projectFolder of projectFolders) {
			const instance = this.hostedWorkspaces.getInstanceByPath(
				projectFolder.folderUri.fsPath
			);
			if (instance) {
				changed ||= instance.projectId !== projectFolder.projectId;
				instance.projectId = projectFolder.projectId;
			}
		}
		if (this.retainedWorkbenches.reconcileProjectPaths(
			projectFolders.map(folder => folder.folderUri)
		)) {
			changed = true;
		}
		return changed;
	}

	private recordProjectFolderPromotions(projectFolders: readonly {
		readonly projectId: string;
		readonly folderUri: URI;
	}[]): void {
		if (projectFolders.length === 0) {
			return;
		}
		const current = this.projectCatalogSnapshot;
		const liveProjectIds = current?.liveProjectIds
			? new Set(current.liveProjectIds)
			: undefined;
		const projectIdsByPath = new Map(current?.projectIdsByPath);
		for (const projectFolder of projectFolders) {
			liveProjectIds?.add(projectFolder.projectId);
			projectIdsByPath.set(
				getProjectManagerPathComparisonKey(
					projectFolder.folderUri.fsPath,
					isLinux
				),
				projectFolder.projectId
			);
		}
		this.projectCatalogSnapshot = {
			liveProjectIds,
			projectIdsByPath,
		};
	}

	private resolveProjectIdAgainstCatalog(
		worktreePath: string,
		projectId: string | undefined
	): string | undefined {
		const catalog = this.projectCatalogSnapshot;
		if (!catalog) {
			return projectId;
		}
		const claimedProjectId = catalog.projectIdsByPath.get(
			getProjectManagerPathComparisonKey(worktreePath, isLinux)
		);
		if (claimedProjectId) {
			return claimedProjectId;
		}
		if (!catalog.liveProjectIds) {
			return projectId;
		}
		return projectId && catalog.liveProjectIds.has(projectId)
			? projectId
			: undefined;
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
		makeActive: boolean,
		activationIntent?: number,
		canActivate: () => boolean = () => true,
		canApply: () => boolean = () => true,
		onSupersededRollback: () => void = () => { }
	): Promise<IHostedWorkbenchInstance | undefined> {
		if (this.shuttingDown || !canApply()) {
			return undefined;
		}

		const pendingInstance =
			this.hostedWorkspaces.getInstanceByPath(worktreePath);
		const workspaceFolderStat = this.getHostedWorkspaceFolderStat(
			worktreePath
		);
		if (!workspaceFolderStat) {
			if (pendingInstance) {
				if (pendingInstance.view || pendingInstance.attached) {
					await this.destroyInstance(pendingInstance, true, false);
				} else {
					this.hostedWorkspaces.removeInstance(pendingInstance);
				}
			}
			const retained = this.retainedWorkbenches.getByUri(
				URI.file(worktreePath)
			);
			if (retained) {
				this.retainedWorkbenches.update(retained.id, {
					...(activationIntent === undefined
						? { desiredState: 'unloaded' as const }
						: {}),
					folderStatus: 'missing',
				});
			}
			this.emitState();
			return undefined;
		}
		const retained = this.retainedWorkbenches.getByUri(
			URI.file(worktreePath)
		);
		if (retained?.folderStatus === 'missing') {
			this.retainedWorkbenches.update(retained.id, {
				folderStatus: undefined,
			});
		}
		const previousActiveInstanceId = this.activeInstanceId;
		const reusedPendingInstance =
			pendingInstance?.state === 'restore-pending' ||
			pendingInstance?.state === 'dormant';
		const pendingSnapshot = reusedPendingInstance && pendingInstance ? {
			instanceId: pendingInstance.instanceId,
			projectId: pendingInstance.projectId,
			state: pendingInstance.state,
			visible: pendingInstance.visible,
			focused: pendingInstance.focused,
			lastActiveAt: pendingInstance.lastActiveAt,
			lifecycleGeneration: pendingInstance.lifecycleGeneration,
			connectionGeneration: pendingInstance.connectionGeneration,
		} : undefined;
		const instance: IHostedWorkbenchInstance =
			reusedPendingInstance
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
					lifecycleGeneration: 0,
					connectionGeneration: 0,
					disposed: false,
				};

		instance.projectId = projectId ?? instance.projectId;
		instance.disposed = false;
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
			await this.attachInstance(instance, makeActive, workspaceFolderStat);
			if (
				this.shuttingDown ||
				instance.disposed ||
				this.hostedWorkspaces.getInstanceByPath(worktreePath) !==
				instance
			) {
				return undefined;
			}
			if (!canApply()) {
				const requestStillOwnsInstance =
					instance.lifecycleGeneration ===
					(pendingSnapshot?.lifecycleGeneration ?? 0) &&
					this.activeInstanceId !== instance.instanceId;
				if (requestStillOwnsInstance) {
					await this.destroyInstance(
						instance,
						true,
						false
					);
					if (pendingSnapshot) {
						this.hostedWorkspaces.addInstance({
							instanceId: pendingSnapshot.instanceId,
							projectId: pendingSnapshot.projectId,
							worktreePath,
							trustedProcessIds: new Set<number>(),
							attached: false,
							state: pendingSnapshot.state,
							visible: pendingSnapshot.visible,
							focused: pendingSnapshot.focused,
							lastActiveAt: pendingSnapshot.lastActiveAt,
							lifecycleGeneration:
								pendingSnapshot.lifecycleGeneration,
							connectionGeneration:
								pendingSnapshot.connectionGeneration,
							disposed: false,
						});
					}
					onSupersededRollback();
				}
				return undefined;
			}

			this.traceRestore(
				`instance:attached makeActive=${makeActive} state=${instance.state}`,
				instance
			);
			if (makeActive && canActivate() && (
				activationIntent === undefined ||
				activationIntent === this.activationIntentGeneration
			)) {
				this.activateInstance(instance, activationIntent);
			} else {
				if (instance.instanceId !== this.activeInstanceId) {
					instance.visible = false;
					instance.focused = false;
					this.reconcileViewVisibility('attach:inactive');
				}
				this.emitState();
			}

			return instance;
		} catch (error) {
			if (
				this.shuttingDown ||
				instance.disposed ||
				this.hostedWorkspaces.getInstanceByPath(worktreePath) !==
				instance
			) {
				throw error;
			}

			await this.deferStateEmission(async () => {
				this.markRetainedWorkbenchCrashed(instance.worktreePath);
				await this.destroyInstance(instance, true, false);
				if (instance.instanceId === this.activeInstanceId) {
					this.activeInstanceId =
						previousActiveInstanceId !== instance.instanceId
							? previousActiveInstanceId
							: undefined;
				}
				this.emitState();
			});
			throw error;
		}
	}

	private async attachInstance(
		instance: IHostedWorkbenchInstance,
		makeActive: boolean,
		workspaceFolderStat: Stats
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
				webContentsId,
				workspaceFolderStat
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
			this.invalidateHostedShellBinding(instance);
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
			this.markRetainedWorkbenchCrashed(instance.worktreePath);
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
				this.markRetainedWorkbenchCrashed(instance.worktreePath);
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

	private markRetainedWorkbenchCrashed(worktreePath: string): void {
		const retained = this.retainedWorkbenches.getByUri(
			URI.file(worktreePath)
		);
		if (retained) {
			this.retainedWorkbenches.update(retained.id, {
				desiredState: 'unloaded',
				folderStatus: this.getRetainedWorkbenchFolderStatus(worktreePath),
			});
		}
	}

	private getRetainedWorkbenchFolderStatus(
		worktreePath: string
	): 'missing' | undefined {
		try {
			return statSync(worktreePath).isDirectory() ? undefined : 'missing';
		} catch (error) {
			return isHostedWorkspaceFolderUnavailableError(error)
				? 'missing'
				: undefined;
		}
	}

	private getHostedWorkspaceFolderStat(
		worktreePath: string
	): Stats | undefined {
		try {
			const stat = statSync(worktreePath);
			return stat.isDirectory() ? stat : undefined;
		} catch (error) {
			if (isHostedWorkspaceFolderUnavailableError(error)) {
				return undefined;
			}
			throw error;
		}
	}

	private createHostedConfiguration(
		instance: IHostedWorkbenchInstance,
		hostedWebContentsId: number,
		workspaceFolderStat: Stats
	): INativeWindowConfiguration {
		const baseConfig = this.window.config;
		if (!baseConfig) {
			throw new Error('Omni-window configuration is unavailable.');
		}

		const workspace = getSingleFolderWorkspaceIdentifier(
			URI.file(instance.worktreePath),
			workspaceFolderStat
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
			omniRetainedWorkbenches: undefined,
		};
	}

	private activateInstance(
		instance: IHostedWorkbenchInstance,
		activationIntent?: number
	): boolean {
		if (activationIntent === undefined) {
			activationIntent = ++this.activationIntentGeneration;
		} else if (activationIntent !== this.activationIntentGeneration) {
			return false;
		}
		instance.lifecycleGeneration = ++this.lifecycleGeneration;
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
		const retained = this.retainedWorkbenches.getByUri(
			URI.file(instance.worktreePath)
		);
		if (retained) {
			this.retainedWorkbenches.update(retained.id, {
				desiredState: 'loaded',
				folderStatus: undefined,
				lastActiveAt: instance.lastActiveAt,
			});
		}
		this.setViewVisible(instance, true);
		this.updateInstanceState(instance, {
			visible: true,
			lastActiveAt: instance.lastActiveAt,
		});
		this.traceRestore(`activate:complete state=${instance.state}`, instance);
		return true;
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
		const retained = this.retainedWorkbenches.getByUri(
			URI.file(target.worktreePath)
		);
		if (!retained) {
			await this.closeInstance(target);
			return;
		}
		await this.deferStateEmission(async () => {
			if (await this.closeInstance(target)) {
				this.retainedWorkbenches.update(retained.id, {
					desiredState: 'unloaded',
				});
				this.emitState();
			}
		});
	}

	async closeHostedShellSelf(
		binding: IHucodeHostedShellBinding
	): Promise<boolean> {
		const instance = this.getBoundHostedShellInstance(binding);
		if (!instance) {
			return false;
		}
		return this.closeInstance(
			instance,
			binding.connectionGeneration
		);
	}

	private async closeInstance(
		target: IHostedWorkbenchInstance,
		expectedConnectionGeneration?: number
	): Promise<boolean> {
		const lifecycleGeneration = target.lifecycleGeneration;
		const closed = await this.destroyInstance(
			target,
			true,
			true,
			UnloadReason.CLOSE,
			false,
			lifecycleGeneration,
			expectedConnectionGeneration
		);
		if (!closed) {
			return false;
		}

		if (!this.getActiveInstance()) {
			const nextActive = getMostRecentHostedWorkspace(
				this.instancesById.values(),
				undefined,
				instance => instance.disposed
			);
			if (nextActive) {
				this.activateInstance(nextActive);
			} else {
				this.emitState();
			}
		} else {
			this.emitState();
		}
		return true;
	}

	private async destroyInstance(
		instance: IHostedWorkbenchInstance,
		removeFromMaps: boolean,
		graceful: boolean = true,
		reason: UnloadReason = UnloadReason.CLOSE,
		ignoreUnloadVeto: boolean = false,
		expectedLifecycleGeneration?: number,
		expectedConnectionGeneration?: number
	): Promise<boolean> {
		if (graceful) {
			const unloadResult = await this.unloadInRenderer(
				instance,
				reason,
				ignoreUnloadVeto,
				() => (
					expectedLifecycleGeneration !== undefined && (
						instance.lifecycleGeneration !==
						expectedLifecycleGeneration ||
						instance.disposed ||
						this.hostedWorkspaces.getInstanceByPath(
							instance.worktreePath
						) !== instance
					)
				) || (
						expectedConnectionGeneration !== undefined &&
						instance.connectionGeneration !==
						expectedConnectionGeneration
					)
			);
			if (unloadResult === 'reload-required') {
				this.reloadInstanceAfterInterruptedUnload(instance);
				return false;
			}
			if (unloadResult === 'superseded') {
				return false;
			}
			if (unloadResult === 'before-unload-failed') {
				this.logService.trace(
					'[HucodeShellMainService] Hosted workspace unload ' +
					`preparation failed for ${instance.worktreePath}.`
				);
				return false;
			}
			if (unloadResult === 'vetoed') {
				if (!ignoreUnloadVeto) {
					this.logService.trace(
						'[HucodeShellMainService] Hosted workspace unload ' +
						`vetoed for ${instance.worktreePath}.`
					);
					return false;
				}

				this.logIgnoredShutdownUnloadVeto(instance);
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

	private reloadInstanceAfterInterruptedUnload(
		instance: IHostedWorkbenchInstance
	): void {
		if (
			instance.disposed ||
			instance.interruptedUnloadReloadGeneration ===
			instance.lifecycleGeneration ||
			this.hostedWorkspaces.getInstanceByPath(instance.worktreePath) !==
			instance
		) {
			return;
		}

		const webContents = this.getLiveWebContents(instance);
		if (!webContents) {
			return;
		}

		this.logService.trace(
			'[HucodeShellMainService] Reloading hosted workspace after an ' +
			`interrupted unload for ${instance.worktreePath}.`
		);
		instance.interruptedUnloadReloadGeneration =
			instance.lifecycleGeneration;
		instance.state = 'loading';
		webContents.reload();
		this.emitState();
	}

	shutdownAllWorkspaces(reason: UnloadReason): Promise<void> {
		if (
			this.shutdownReason === undefined ||
			unloadReasonRank(reason) > unloadReasonRank(this.shutdownReason)
		) {
			this.shutdownReason = reason;
		}
		if (
			reason === UnloadReason.CLOSE ||
			reason === UnloadReason.QUIT
		) {
			this.terminalShutdownRequested = true;
		}
		if (this.shutdownPromise) {
			return this.shutdownPromise;
		}

		this.updateWindowRestoreState();
		this.shuttingDown = true;
		const instances = Array.from(this.instancesById.values())
			.filter(instance => !instance.disposed ||
				!!instance.view ||
				!!instance.configObjectUrl);
		const shutdown = Promise.resolve().then(
			() => this.runShutdown(
				instances,
				() => this.shutdownReason ?? reason
			)
		);
		this.shutdownPromise = shutdown;
		const releaseShutdown = (failed: boolean) => {
			if (this.shutdownPromise === shutdown) {
				if (failed || !this.terminalShutdownRequested) {
					this.shutdownPromise = undefined;
				}
				if (!this.terminalShutdownRequested) {
					this.shutdownReason = undefined;
					this.shuttingDown = false;
				}
			}
		};
		void shutdown.then(
			() => releaseShutdown(false),
			() => releaseShutdown(true)
		);
		return shutdown;
	}

	private async runShutdown(
		instances: readonly IHostedWorkbenchInstance[],
		getReason: () => UnloadReason
	): Promise<void> {
		const unloadInstances = instances.filter(instance => !instance.disposed);
		const unloadResults = await Promise.allSettled(
			unloadInstances.map(instance =>
				this.unloadInRenderer(
					instance,
					getReason(),
					true,
					undefined,
					getReason
				)
			)
		);
		let firstFailure: { readonly error: unknown } | undefined;
		for (let index = 0; index < unloadInstances.length; index++) {
			const unloadResult = unloadResults[index];
			if (unloadResult.status === 'rejected') {
				firstFailure ??= { error: unloadResult.reason };
			} else if (unloadResult.value === 'vetoed') {
				this.logIgnoredShutdownUnloadVeto(unloadInstances[index]);
			}
		}

		// Native view ownership changes remain ordered even though the renderer
		// handshakes above are independent and can consume their budgets
		// concurrently.
		for (const instance of instances) {
			if (
				instance.disposed &&
				!instance.view &&
				!instance.configObjectUrl
			) {
				continue;
			}

			try {
				await this.destroyInstance(instance, false, false);
			} catch (error) {
				firstFailure ??= { error };
			}
		}

		if (firstFailure) {
			throw firstFailure.error;
		}
	}

	private logIgnoredShutdownUnloadVeto(
		instance: IHostedWorkbenchInstance
	): void {
		this.logService.warn(
			'[HucodeShellMainService] Ignoring hosted workspace ' +
			`unload veto during Omni shutdown for ` +
			`${instance.worktreePath}.`
		);
	}

	private async unloadInRenderer(
		instance: IHostedWorkbenchInstance,
		reason: UnloadReason,
		ignoreBeforeUnloadVeto: boolean = false,
		isSuperseded: () => boolean = () => false,
		getLatestReason: () => UnloadReason = () => reason
	): Promise<
		'ready' | 'vetoed' | 'before-unload-failed' |
		'superseded' | 'reload-required'
	> {
		const webContents = instance.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return isSuperseded() ? 'superseded' : 'ready';
		}

		const preparation = await this.onBeforeUnloadInRenderer(
			webContents,
			instance,
			reason
		);
		const latestReason = getLatestReason();
		if (latestReason !== reason) {
			if (preparation.outcome !== 'vetoed') {
				await this.notifyShutdownPreparationAbandonedInRenderer(
					webContents,
					instance,
					preparation.preparationId
				);
			}
			return this.unloadInRenderer(
				instance,
				latestReason,
				ignoreBeforeUnloadVeto,
				isSuperseded,
				getLatestReason
			);
		}
		if (preparation.outcome === 'vetoed') {
			if (ignoreBeforeUnloadVeto) {
				await this.onWillUnloadInRenderer(
					webContents,
					instance,
					reason,
					preparation.preparationId
				);
			}
			return 'vetoed';
		}
		if (preparation.outcome === 'failed') {
			if (ignoreBeforeUnloadVeto) {
				await this.onWillUnloadInRenderer(
					webContents,
					instance,
					reason,
					preparation.preparationId
				);
				return 'ready';
			}

			const rollbackDisposition =
				await this.notifyShutdownPreparationAbandonedInRenderer(
					webContents,
					instance,
					preparation.preparationId
				);
			if (!rollbackDisposition) {
				return 'reload-required';
			}
			return isSuperseded()
				? 'superseded'
				: 'before-unload-failed';
		}
		if (isSuperseded()) {
			const rollbackDisposition =
				await this.notifyShutdownPreparationAbandonedInRenderer(
					webContents,
					instance,
					preparation.preparationId
				);
			if (!rollbackDisposition) {
				return 'reload-required';
			}
			return 'superseded';
		}

		await this.onWillUnloadInRenderer(
			webContents,
			instance,
			reason,
			preparation.preparationId
		);
		if (isSuperseded()) {
			return 'reload-required';
		}
		return 'ready';
	}

	private notifyShutdownPreparationAbandonedInRenderer(
		webContents: Electron.WebContents,
		instance: IHostedWorkbenchInstance,
		preparationId: string
	): Promise<'applied' | 'stale' | undefined> {
		if (webContents.isDestroyed()) {
			return Promise.resolve(undefined);
		}

		return new Promise(resolve => {
			const oneTimeEventToken = this.createOneTimeEventToken(instance);
			const replyChannel = `vscode:reply${oneTimeEventToken}`;
			let settled = false;

			const complete = (
				disposition: 'applied' | 'stale' | undefined
			) => {
				if (settled) {
					return;
				}

				settled = true;
				clearTimeout(timeoutHandle);
				this.ipcMain.removeListener(replyChannel, handleReply);
				webContents.removeListener('destroyed', handleDestroyed);
				resolve(disposition);
			};
			const handleReply = (
				_event: Electron.IpcMainEvent,
				...args: unknown[]
			) => {
				const reply = args[0] as {
					preparationId?: string;
					disposition?: string;
				} | undefined;
				if (
					reply?.preparationId !== preparationId ||
					(reply.disposition !== 'applied' &&
						reply.disposition !== 'stale')
				) {
					complete(undefined);
					return;
				}

				complete(reply.disposition);
			};
			const handleDestroyed = () => complete(undefined);

			this.ipcMain.once(replyChannel, handleReply);
			webContents.once('destroyed', handleDestroyed);
			const timeoutHandle = setTimeout(() => {
				this.logService.warn(
					'[HucodeShellMainService] Timed out waiting for hosted ' +
					`workspace shutdown preparation rollback reply for ` +
					`${instance.worktreePath}.`
				);
				complete(undefined);
			}, this.beforeUnloadTimeoutMs);

			try {
				webContents.send('vscode:onShutdownPreparationAbandoned', {
					preparationId,
					replyChannel,
				});
			} catch (error) {
				this.logService.warn(
					'[HucodeShellMainService] Failed to send hosted workspace ' +
					`shutdown preparation rollback for ` +
					`${instance.worktreePath}: ${error}`
				);
				complete(undefined);
			}
		});
	}

	private onBeforeUnloadInRenderer(
		webContents: Electron.WebContents,
		instance: IHostedWorkbenchInstance,
		reason: UnloadReason
	): Promise<{
		readonly preparationId: string;
		readonly outcome: 'ready' | 'vetoed' | 'failed';
	}> {
		return new Promise(resolve => {
			const oneTimeEventToken = this.createOneTimeEventToken(instance);
			const okChannel = `vscode:ok${oneTimeEventToken}`;
			const cancelChannel = `vscode:cancel${oneTimeEventToken}`;
			const preparationId = oneTimeEventToken;

			let settled = false;

			const handleOk = () => complete('ready');
			const handleCancel = () => complete('vetoed');
			const handleDestroyed = () => complete('failed');

			const complete = (
				outcome: 'ready' | 'vetoed' | 'failed'
			) => {
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

				resolve({ preparationId, outcome });
			};

			this.ipcMain.once(okChannel, handleOk);
			this.ipcMain.once(cancelChannel, handleCancel);
			webContents.once('destroyed', handleDestroyed);
			const timeoutHandle = setTimeout(() => {
				this.logService.warn(
					'[HucodeShellMainService] Timed out waiting for hosted ' +
					`workspace before-unload reply for ${instance.worktreePath}.`
				);
				complete('failed');
			}, this.beforeUnloadTimeoutMs);

			try {
				webContents.send('vscode:onBeforeUnload', {
					okChannel,
					cancelChannel,
					preparationId,
					reason
				});
			} catch (error) {
				this.logService.warn(
					'[HucodeShellMainService] Failed to send hosted workspace ' +
					`before-unload for ${instance.worktreePath}: ${error}`
				);
				complete('failed');
			}
		});
	}

	private onWillUnloadInRenderer(
		webContents: Electron.WebContents,
		instance: IHostedWorkbenchInstance,
		reason: UnloadReason,
		preparationId: string
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
					preparationId,
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

	focusHostedShellSelf(binding: IHucodeHostedShellBinding): boolean {
		const instance = this.getBoundHostedShellInstance(binding);
		if (!instance?.view || instance.view.webContents.isDestroyed()) {
			return false;
		}
		this.activateInstance(instance);
		this.lastFocusedSurface = 'workspace';
		this.bringInstanceToFront(instance);
		instance.view.webContents.focus();
		return true;
	}

	focusShell(): void {
		this.lastFocusedSurface = 'shell';
		this.window.win?.webContents.focus();
	}

	focusShellFromHosted(binding: IHucodeHostedShellBinding): boolean {
		if (!this.getBoundHostedShellInstance(binding, true)) {
			return false;
		}
		this.focusShell();
		return true;
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

	setProjectSwitcherSectionOrder(
		order: readonly ProjectSwitcherOmniSection[]
	): void {
		if (!this.hostedWorkspaces.setProjectSwitcherSectionOrder(order)) {
			return;
		}

		this.emitState();
	}

	runActionInShell(request: INativeRunActionInWindowRequest): boolean {
		const action = getHucodeHostedShellAction(request.id);
		if (!action) {
			this.logService.warn(
				'[HucodeShellMainService] Rejected hosted shell action from ' +
				`legacy desktop connection for Omni window ${this.window.id}: ` +
				'unsupported command id ' +
				`${formatHucodeHostedShellActionCommandIdForLog(request.id)}.`
			);
			return false;
		}

		const webContents = this.window.win?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return false;
		}

		try {
			webContents.send(
				'vscode:runAction',
				this.withOmniForwardingMarker(
					createLegacyHucodeHostedShellActionRequest(action)
				)
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

	runHostedShellAction(
		binding: IHucodeHostedShellBinding,
		action: HucodeHostedShellAction
	): boolean {
		if (!this.getBoundHostedShellInstance(binding, true)) {
			return false;
		}
		return this.runActionInShell(
			createLegacyHucodeHostedShellActionRequest(action)
		);
	}

	reloadWorkspace(): void {
		this.getActiveInstance()?.view?.webContents.reload();
	}

	reloadHostedShellSelf(binding: IHucodeHostedShellBinding): boolean {
		const webContents = this.getBoundHostedShellInstance(binding)
			?.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return false;
		}
		webContents.reload();
		return true;
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

	async captureHostedShellSelfScreenshot(
		binding: IHucodeHostedShellBinding,
		rect?: IRectangle,
		quality: number = 80
	): Promise<VSBuffer | undefined> {
		const webContents = this.getBoundHostedShellInstance(binding, true)
			?.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return undefined;
		}

		try {
			const image = await webContents.capturePage(rect, {
				stayHidden: true,
			});
			if (!this.getBoundHostedShellInstance(binding, true)) {
				return undefined;
			}
			return VSBuffer.wrap(image.toJPEG(quality));
		} catch (error) {
			this.logService.warn(
				'[HucodeShellMainService] Failed to capture bound hosted ' +
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

	triggerPasteInHostedShellSelf(
		binding: IHucodeHostedShellBinding
	): boolean {
		const instance = this.getBoundHostedShellInstance(binding, true);
		const webContents = instance?.view?.webContents;
		if (!instance || !webContents || webContents.isDestroyed()) {
			return false;
		}

		try {
			this.lastFocusedSurface = 'workspace';
			this.bringInstanceToFront(instance);
			webContents.focus();
			webContents.paste();
			return true;
		} catch (error) {
			this.logService.warn(
				'[HucodeShellMainService] Failed to trigger bound hosted ' +
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
