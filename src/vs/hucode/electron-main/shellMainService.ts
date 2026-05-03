/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WebContentsView } from 'electron';
import { statSync } from 'fs';
import { validatedIpcMain } from '../../base/parts/ipc/electron-main/ipcMain.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
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
import {
	ICodeWindow,
	UnloadReason,
} from '../../platform/window/electron-main/window.js';
import {
	INativeWindowConfiguration,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
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
import { ShutdownReason } from '../../workbench/services/lifecycle/common/lifecycle.js';
import { IBrowserViewMainService } from
	'../../platform/browserView/electron-main/browserViewMainService.js';

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

type OmniFocusedSurface = 'shell' | 'workspace';

class ResidentHostedWorkspacesController extends Disposable {
	private static readonly BEFORE_UNLOAD_TIMEOUT_MS = 5000;
	private static readonly WILL_UNLOAD_TIMEOUT_MS = 15000;

	private readonly instancesById = new Map<string, IHostedWorkbenchInstance>();
	private readonly instanceIdsByPath = new Map<string, string>();

	private bounds: IRectangle = { x: 0, y: 0, width: 0, height: 0 };
	private activeInstanceId: string | undefined;
	private restored = false;
	private oneTimeListenerTokenGenerator = 0;
	private overlayOccluded = false;
	private lastFocusedSurface: OmniFocusedSurface = 'shell';
	private windowFocusRestoreSurface: OmniFocusedSurface | undefined;

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
	) {
		super();

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

		const state: HucodeHostedWorkbenchLifecycleState =
			instance.instanceId === this.activeInstanceId ? 'active' : 'loaded';
		this.updateInstanceState(instance, { state });
		if (state === 'active') {
			this.applyViewVisibility(instance);
		}
	}

	private setViewVisible(
		instance: IHostedWorkbenchInstance,
		visible: boolean
	): void {
		instance.visible = visible;
		this.applyViewVisibility(instance);
	}

	private isViewActuallyVisible(instance: IHostedWorkbenchInstance): boolean {
		return instance.visible
			&& (
				instance.instanceId !== this.activeInstanceId
				|| !this.overlayOccluded
			);
	}

	private applyViewVisibility(instance: IHostedWorkbenchInstance): void {
		const visible = this.isViewActuallyVisible(instance);
		if (!visible && instance.view?.webContents.isFocused()) {
			this.window.win?.webContents.focus();
		}
		instance.view?.setVisible(visible);
		if (instance.view) {
			this.browserViewMainService.setHostedWebContentsVisible(
				instance.view.webContents.id,
				visible
			);
		}
		if (visible) {
			this.bringInstanceToFront(instance);
		}
	}

	private bringInstanceToFront(instance: IHostedWorkbenchInstance): void {
		if (!instance.view || !this.window.win) {
			return;
		}

		// Re-adding an attached Electron View moves it above its siblings.
		this.window.win.contentView.addChildView(instance.view);
		this.browserViewMainService.bringHostedBrowserViewsToFront(
			instance.view.webContents.id
		);
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

		this.restored = true;
		const restoreEntries = this.window.config?.omniResidentWorkspaces;
		if (!restoreEntries?.length) {
			this.emitState();
			return;
		}

		const mostRecentWorktreePath = [...restoreEntries]
			.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
			?.worktreePath;
		const activeWorktreePath = this.window.config?.omniActiveWorktreePath ??
			restoreEntries.find(entry => entry.state === 'active')?.worktreePath ??
			mostRecentWorktreePath;
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
				this.emitState();
			}

			return instance;
		} catch (error) {
			await this.destroyInstance(instance, false, false);
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

			if (instance.instanceId === this.activeInstanceId) {
				this.setWorkspaceOverlayOcclusion(false);
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
				if (instance.instanceId === this.activeInstanceId) {
					this.setWorkspaceOverlayOcclusion(false);
				}
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
					: previousActive.state === 'loading'
						? 'loading'
						: 'loaded',
				focused: false,
			});
		}

		this.activeInstanceId = instance.instanceId;
		instance.lastActiveAt = Date.now();
		this.setViewVisible(instance, true);
		this.updateInstanceState(instance, {
			state: instance.state === 'crashed'
				? 'crashed'
				: instance.state === 'loading'
					? 'loading'
					: 'active',
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
			nextActive = Array.from(this.instancesById.values())
				.filter(candidate => candidate.instanceId !== target.instanceId)
				.sort((a, b) =>
					(b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
				)[0];
		}

		const closed = await this.destroyInstance(target, true);
		if (!closed) {
			return;
		}

		if (wasActive) {
			this.setWorkspaceOverlayOcclusion(false);
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
		if (instance.instanceId === this.activeInstanceId) {
			this.setWorkspaceOverlayOcclusion(false);
		}

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
			const oneTimeEventToken = this.oneTimeListenerTokenGenerator++;
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

				validatedIpcMain.removeListener(okChannel, handleOk);
				validatedIpcMain.removeListener(cancelChannel, handleCancel);
				webContents.removeListener('destroyed', handleDestroyed);

				resolve(veto);
			};

			validatedIpcMain.once(okChannel, handleOk);
			validatedIpcMain.once(cancelChannel, handleCancel);
			webContents.once('destroyed', handleDestroyed);
			const timeoutHandle = setTimeout(() => {
				this.logService.warn(
					'[HucodeShellMainService] Timed out waiting for hosted ' +
					`workspace before-unload reply for ${instance.worktreePath}.`
				);
				complete(false);
			}, ResidentHostedWorkspacesController.BEFORE_UNLOAD_TIMEOUT_MS);

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
			const oneTimeEventToken = this.oneTimeListenerTokenGenerator++;
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

				validatedIpcMain.removeListener(replyChannel, handleReply);
				webContents.removeListener('destroyed', handleDestroyed);

				resolve();
			};

			validatedIpcMain.once(replyChannel, handleReply);
			webContents.once('destroyed', handleDestroyed);
			const timeoutHandle = setTimeout(() => {
				this.logService.warn(
					'[HucodeShellMainService] Timed out waiting for hosted ' +
					`workspace will-unload reply for ${instance.worktreePath}.`
				);
				complete();
			}, ResidentHostedWorkspacesController.WILL_UNLOAD_TIMEOUT_MS);

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
		quality: number = 80
	): Promise<VSBuffer | undefined> {
		const webContents = this.getActiveInstance()?.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return undefined;
		}

		try {
			const image = await webContents.capturePage(undefined, {
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
		if (this.overlayOccluded === occluded) {
			return;
		}

		this.overlayOccluded = occluded;
		const activeInstance = this.getActiveInstance();
		if (activeInstance) {
			this.applyViewVisibility(activeInstance);
		}
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
		return this.sendToActiveWorkspace(
			'vscode:runKeybinding',
			this.withOmniForwardingMarker(request)
		);
	}

	triggerPasteInWorkspace(): boolean {
		const activeInstance = this.getActiveInstance();
		const webContents = activeInstance?.view?.webContents;
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
		const webContents = activeInstance?.view?.webContents;
		if (!webContents || webContents.isDestroyed()) {
			return false;
		}

		try {
			this.lastFocusedSurface = 'workspace';
			this.bringInstanceToFront(activeInstance);
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

	override dispose(): void {
		for (const instance of Array.from(this.instancesById.values())) {
			void this.destroyInstance(instance, true, false);
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
		@IBrowserViewMainService
		private readonly browserViewMainService: IBrowserViewMainService,
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

	async notifyHostedWorkspaceReady(
		windowId: number,
		instanceId: string
	): Promise<void> {
		this.controllers.get(windowId)?.notifyHostedWorkspaceReady(instanceId);
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

	async toggleWorkspaceDevTools(windowId: number): Promise<boolean> {
		return this.getOrCreateController(windowId).toggleWorkspaceDevTools();
	}

	async runActionInWorkspace(
		windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		return this.getOrCreateController(windowId).runActionInWorkspace(request);
	}

	async runKeybindingInWorkspace(
		windowId: number,
		request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		return this.getOrCreateController(windowId)
			.runKeybindingInWorkspace(request);
	}

	async triggerPasteInWorkspace(windowId: number): Promise<boolean> {
		return this.getOrCreateController(windowId).triggerPasteInWorkspace();
	}

	async layoutWorkspace(windowId: number, bounds: IRectangle): Promise<void> {
		this.getOrCreateController(windowId).layout(bounds);
	}

	async captureWorkspaceScreenshot(
		windowId: number,
		quality?: number
	): Promise<VSBuffer | undefined> {
		return this.getOrCreateController(windowId)
			.captureWorkspaceScreenshot(quality);
	}

	async setWorkspaceOverlayOcclusion(
		windowId: number,
		occluded: boolean
	): Promise<void> {
		this.getOrCreateController(windowId)
			.setWorkspaceOverlayOcclusion(occluded);
	}

	async shutdownWindowWorkspaces(
		windowId: number,
		reason: ShutdownReason
	): Promise<void> {
		const controller = this.controllers.get(windowId);
		if (!controller) {
			return;
		}

		await controller.shutdownAllWorkspaces(
			this.toUnloadReason(reason)
		);
	}

	private toUnloadReason(reason: ShutdownReason): UnloadReason {
		switch (reason) {
			case ShutdownReason.QUIT:
				return UnloadReason.QUIT;
			case ShutdownReason.RELOAD:
				return UnloadReason.RELOAD;
			case ShutdownReason.LOAD:
				return UnloadReason.LOAD;
			case ShutdownReason.CLOSE:
			default:
				return UnloadReason.CLOSE;
		}
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
				this.browserViewMainService,
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
