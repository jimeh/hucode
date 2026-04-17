/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for
 *  license information.
 *--------------------------------------------------------------------------------------------*/

import { WebContentsView } from 'electron';
import { statSync } from 'fs';
import { Emitter } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { FileAccess } from '../../base/common/network.js';
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
import { ICodeWindow } from '../../platform/window/electron-main/window.js';
import {
	INativeWindowConfiguration,
	IOmniWorkspaceRestoreEntry,
	IRectangle,
} from '../../platform/window/common/window.js';
import { IWindowsMainService } from
	'../../platform/windows/electron-main/windows.js';
import { getSingleFolderWorkspaceIdentifier } from
	'../../platform/workspaces/node/workspaces.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeHostedWorkbenchInstance,
	IHucodeHostedWorkspaceState,
	IHucodeShellWindowStateChange,
} from '../common/omniWindow.js';
import { IHucodeShellMainService } from './omniWindow.js';

interface IHostedWorkbenchInstance {
	instanceId: string;
	projectId?: string;
	worktreePath: string;
	view?: WebContentsView;
	configObjectUrl?: IIPCObjectUrl<INativeWindowConfiguration>;
	trustedProcessIds: Set<number>;
	trustedWebContentsId?: number;
	state: HucodeHostedWorkbenchLifecycleState;
	visible: boolean;
	focused: boolean;
	lastActiveAt?: number;
	disposed: boolean;
}

class ResidentHostedWorkspacesController extends Disposable {
	private readonly instancesById = new Map<string, IHostedWorkbenchInstance>();
	private readonly instanceIdsByPath = new Map<string, string>();

	private bounds: IRectangle = { x: 0, y: 0, width: 0, height: 0 };
	private activeInstanceId: string | undefined;
	private restored = false;

	constructor(
		private readonly protocolMainService: IProtocolMainService,
		private readonly environmentMainService: IEnvironmentMainService,
		private readonly themeMainService: IThemeMainService,
		private readonly logService: ILogService,
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
	) {
		super();
	}

	getState(): IHucodeHostedWorkspaceState {
		const instances = Array.from(this.instancesById.values())
			.map(instance => this.toExternalInstance(instance))
			.sort((a, b) => {
				if (a.instanceId === this.activeInstanceId) {
					return -1;
				}

				if (b.instanceId === this.activeInstanceId) {
					return 1;
				}

				return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
			});

		return {
			activeInstanceId: this.activeInstanceId,
			instances,
		};
	}

	private toExternalInstance(
		instance: IHostedWorkbenchInstance
	): IHucodeHostedWorkbenchInstance {
		return {
			instanceId: instance.instanceId,
			projectId: instance.projectId,
			worktreePath: instance.worktreePath,
			state: instance.state,
			webContentsId: instance.view?.webContents.id,
			processId: instance.view?.webContents.getProcessId(),
			visible: instance.visible,
			focused: instance.focused,
			lastActiveAt: instance.lastActiveAt,
		};
	}

	private emitState(): void {
		this.updateWindowRestoreState();
		this.onStateChange(this.getState());
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
		return Array.from(this.instancesById.values())
			.filter(instance =>
				instance.state !== 'crashed' && instance.state !== 'unloaded'
			)
			.map(instance => {
				const state: IOmniWorkspaceRestoreEntry['state'] =
					instance.instanceId === this.activeInstanceId
						? 'active'
						: 'loaded';

				return {
					projectId: instance.projectId,
					worktreePath: instance.worktreePath,
					lastActiveAt: instance.lastActiveAt,
					state,
				};
			})
			.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
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

	private setViewVisible(
		instance: IHostedWorkbenchInstance,
		visible: boolean
	): void {
		instance.visible = visible;
		instance.view?.setVisible(visible);
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

		this.restored = true;
		const restoreEntries = this.window.config?.omniResidentWorkspaces;
		if (!restoreEntries?.length) {
			this.emitState();
			return;
		}

		const activeWorktreePath = this.window.config?.omniActiveWorktreePath ??
			restoreEntries.find(entry => entry.state === 'active')?.worktreePath;
		const sortedEntries = [...restoreEntries].sort((a, b) => {
			if (a.worktreePath === activeWorktreePath) {
				return -1;
			}

			if (b.worktreePath === activeWorktreePath) {
				return 1;
			}

			return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
		});

		for (const entry of sortedEntries) {
			try {
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

		this.emitState();
	}

	async openWorkspace(
		worktreePath: string,
		projectId?: string
	): Promise<void> {
		await this.ensureRestored();

		const existingId = this.instanceIdsByPath.get(worktreePath);
		if (existingId) {
			const existing = this.instancesById.get(existingId);
			if (existing) {
				existing.projectId = projectId ?? existing.projectId;
				this.activateInstance(existing);
				return;
			}
		}

		await this.createOrRestoreInstance(worktreePath, projectId, true);
	}

	private async createOrRestoreInstance(
		worktreePath: string,
		projectId: string | undefined,
		makeActive: boolean
	): Promise<IHostedWorkbenchInstance> {
		const instance: IHostedWorkbenchInstance = {
			instanceId: generateUuid(),
			projectId,
			worktreePath,
			trustedProcessIds: new Set<number>(),
			state: 'loading',
			visible: false,
			focused: false,
			lastActiveAt: makeActive ? Date.now() : undefined,
			disposed: false,
		};

		this.instancesById.set(instance.instanceId, instance);
		this.instanceIdsByPath.set(worktreePath, instance.instanceId);
		this.emitState();

		try {
			await this.attachInstance(instance, makeActive);
			if (makeActive) {
				this.activateInstance(instance);
			} else {
				this.updateInstanceState(instance, { state: 'loaded' });
			}

			return instance;
		} catch (error) {
			await this.destroyInstance(instance, false);
			throw error;
		}
	}

	private async attachInstance(
		instance: IHostedWorkbenchInstance,
		makeActive: boolean
	): Promise<void> {
		const configObjectUrl = this._register(
			this.protocolMainService
				.createIPCObjectUrl<INativeWindowConfiguration>()
		);
		const view = new WebContentsView({
			webPreferences: {
				preload: FileAccess.asFileUri(
					'vs/base/parts/sandbox/electron-browser/preload.js'
				).fsPath,
				additionalArguments: [
					`--vscode-window-config=${configObjectUrl.resource.toString()}`
				],
				v8CacheOptions: this.environmentMainService.useCodeCache
					? 'bypassHeatCheck'
					: 'none',
				backgroundThrottling: false,
				spellcheck: false,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
			},
		});

		instance.view = view;
		instance.configObjectUrl = configObjectUrl;

		configObjectUrl.update(
			this.createHostedConfiguration(
				instance,
				view.webContents.id
			)
		);

		view.setBackgroundColor(this.themeMainService.getBackgroundColor());
		view.webContents.on('focus', () => {
			if (!this.instancesById.has(instance.instanceId)) {
				return;
			}

			this.updateInstanceState(instance, { focused: true });
		});
		view.webContents.on('blur', () => {
			if (!this.instancesById.has(instance.instanceId)) {
				return;
			}

			this.updateInstanceState(instance, { focused: false });
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
			this.setViewVisible(instance, false);
			this.updateInstanceState(instance, {
				state: 'crashed',
				focused: false,
				visible: false,
			});
		});
		view.webContents.once('destroyed', () => {
			this.untrustView(instance);
			if (!instance.disposed &&
				this.instancesById.has(instance.instanceId)) {
				this.setViewVisible(instance, false);
				this.updateInstanceState(instance, {
					state: 'crashed',
					focused: false,
					visible: false,
				});
			}
		});

		this.window.win?.contentView.addChildView(view);
		this.layout(this.bounds);
		this.setViewVisible(instance, makeActive);
		this.trustView(instance);

		const windowResourcePath = this.environmentMainService.isBuilt
			? 'vs/code/electron-browser/workbench/workbench.html'
			: 'vs/code/electron-browser/workbench/workbench-dev.html';
		const windowUrl = FileAccess
			.asBrowserUri(windowResourcePath)
			.toString(true);

		await view.webContents.loadURL(windowUrl);
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
		const previousActive = this.getActiveInstance();
		if (previousActive &&
			previousActive.instanceId !== instance.instanceId) {
			this.setViewVisible(previousActive, false);
			this.updateInstanceState(previousActive, {
				state: previousActive.state === 'crashed'
					? 'crashed'
					: 'loaded',
				focused: false,
			});
		}

		this.activeInstanceId = instance.instanceId;
		instance.lastActiveAt = Date.now();
		this.setViewVisible(instance, true);
		this.updateInstanceState(instance, {
			state: instance.state === 'crashed' ? 'crashed' : 'active',
			visible: true,
			lastActiveAt: instance.lastActiveAt,
		});
	}

	layout(bounds: IRectangle): void {
		this.bounds = bounds;
		if (!this.window.win) {
			return;
		}

		const zoomFactor = this.window.win.webContents.getZoomFactor();
		const viewBounds = {
			x: Math.round(bounds.x * zoomFactor),
			y: Math.round(bounds.y * zoomFactor),
			width: Math.round(bounds.width * zoomFactor),
			height: Math.round(bounds.height * zoomFactor),
		};

		for (const instance of this.instancesById.values()) {
			instance.view?.setBounds(viewBounds);
		}
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
			nextActive = Array.from(this.instancesById.values())
				.filter(candidate => candidate.instanceId !== target.instanceId)
				.sort((a, b) =>
					(b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
				)[0];
		}

		await this.destroyInstance(target, true);
		if (wasActive) {
			this.activeInstanceId = undefined;
			if (nextActive) {
				this.activateInstance(nextActive);
			} else {
				this.emitState();
			}
		}
	}

	private async destroyInstance(
		instance: IHostedWorkbenchInstance,
		removeFromMaps: boolean
	): Promise<void> {
		instance.disposed = true;
		instance.state = 'unloaded';
		instance.focused = false;
		instance.visible = false;

		if (instance.view) {
			this.untrustView(instance);
			instance.view.setVisible(false);
			this.window.win?.contentView.removeChildView(instance.view);
			instance.view.webContents.close({ waitForBeforeUnload: false });
			instance.view = undefined;
		}

		instance.configObjectUrl?.dispose();
		instance.configObjectUrl = undefined;

		if (removeFromMaps) {
			this.instancesById.delete(instance.instanceId);
			this.instanceIdsByPath.delete(instance.worktreePath);
		}
	}

	focusWorkspace(): void {
		this.getActiveInstance()?.view?.webContents.focus();
	}

	focusShell(): void {
		this.window.win?.webContents.focus();
	}

	reloadWorkspace(): void {
		this.getActiveInstance()?.view?.webContents.reload();
	}

	override dispose(): void {
		for (const instance of Array.from(this.instancesById.values())) {
			void this.destroyInstance(instance, true);
		}

		super.dispose();
	}
}

/**
 * Main-process hosted workspace controller for Hucode Omni-windows.
 */
export class HucodeShellMainService extends Disposable
	implements IHucodeShellMainService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWindowState =
		this._register(new Emitter<IHucodeShellWindowStateChange>());
	readonly onDidChangeWindowState = this._onDidChangeWindowState.event;

	private readonly controllers = new Map<
		number,
		ResidentHostedWorkspacesController
	>();
	private readonly trustedHostedWorkspaceProcessIds = new Map<number, number>();
	private readonly trustedHostedWorkspaceWebContentsIds =
		new Map<number, number>();

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IProtocolMainService
		private readonly protocolMainService: IProtocolMainService,
		@IEnvironmentMainService
		private readonly environmentMainService: IEnvironmentMainService,
		@IThemeMainService
		private readonly themeMainService: IThemeMainService,
		@ILogService
		private readonly logService: ILogService,
	) {
		super();

		this._register(this.windowsMainService.onDidDestroyWindow(window => {
			this.controllers.get(window.id)?.dispose();
			this.controllers.delete(window.id);
		}));
	}

	isTrustedHostedWorkspaceRequest(
		processId: number,
		webContentsId?: number
	): boolean {
		return this.trustedHostedWorkspaceProcessIds.has(processId) ||
			(typeof webContentsId === 'number' &&
				this.trustedHostedWorkspaceWebContentsIds.has(webContentsId));
	}

	async getWindowState(windowId: number): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.ensureRestored();
		return controller.getState();
	}

	async openWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.openWorkspace(worktreePath, projectId);
		return controller.getState();
	}

	async closeWorkspace(
		windowId: number,
		instanceId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		const controller = this.getOrCreateController(windowId);
		await controller.closeWorkspace(instanceId);
		return controller.getState();
	}

	async focusWorkspace(windowId: number): Promise<void> {
		this.getOrCreateController(windowId).focusWorkspace();
	}

	async focusShell(windowId: number): Promise<void> {
		this.getOrCreateController(windowId).focusShell();
	}

	async reloadWorkspace(windowId: number): Promise<void> {
		this.getOrCreateController(windowId).reloadWorkspace();
	}

	async layoutWorkspace(windowId: number, bounds: IRectangle): Promise<void> {
		this.getOrCreateController(windowId).layout(bounds);
	}

	private getOrCreateController(
		windowId: number
	): ResidentHostedWorkspacesController {
		const existing = this.controllers.get(windowId);
		if (existing) {
			return existing;
		}

		const window = this.windowsMainService.getWindowById(windowId);
		if (!window?.isOmniWindow) {
			throw new Error(`Window ${windowId} is not a Hucode Omni-window.`);
		}

		const controller = this._register(
			new ResidentHostedWorkspacesController(
				this.protocolMainService,
				this.environmentMainService,
				this.themeMainService,
				this.logService,
				window,
				processId => this.trackTrust(
					this.trustedHostedWorkspaceProcessIds,
					processId,
					1
				),
				processId => this.trackTrust(
					this.trustedHostedWorkspaceProcessIds,
					processId,
					-1
				),
				webContentsId => this.trackTrust(
					this.trustedHostedWorkspaceWebContentsIds,
					webContentsId,
					1
				),
				webContentsId => this.trackTrust(
					this.trustedHostedWorkspaceWebContentsIds,
					webContentsId,
					-1
				),
				(state: IHucodeHostedWorkspaceState) =>
					this._onDidChangeWindowState.fire({ windowId, state })
			)
		);
		this.controllers.set(windowId, controller);
		return controller;
	}

	private trackTrust(
		store: Map<number, number>,
		id: number,
		delta: 1 | -1
	): void {
		const nextValue = (store.get(id) ?? 0) + delta;
		if (nextValue <= 0) {
			store.delete(id);
			return;
		}

		store.set(id, nextValue);
	}
}
