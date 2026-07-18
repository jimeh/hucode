/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { Schemas } from '../../base/common/network.js';
import {
	Disposable,
	DisposableStore,
	IDisposable,
	toDisposable,
} from '../../base/common/lifecycle.js';
import { generateUuid } from '../../base/common/uuid.js';
import { URI, UriComponents } from '../../base/common/uri.js';
import { Client as MessagePortClient } from
	'../../base/parts/ipc/browser/ipc.mp.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { IConfigurationService } from
	'../../platform/configuration/common/configuration.js';
import { IFileService } from '../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import {
	INativeOpenFileRequest,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
	IRectangle,
} from '../../platform/window/common/window.js';
import { FOCUS_PROJECT_PANE_COMMAND_ID } from
	'../../platform/window/common/hucodeOmniCommandRouting.js';
import { ShutdownReason } from
	'../../workbench/services/lifecycle/common/lifecycle.js';
import { IBrowserWorkbenchEnvironmentService } from
	'../../workbench/services/environment/browser/environmentService.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeHostedWorkspaceOwner,
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
	IHucodeShellWindowStateChange,
} from '../common/omniWindow.js';
import {
	createEmptyHostedWorkspaceState,
	getMostRecentHostedWorkspace,
	hasLoadedHostedWorkspace,
	HostedWorkspaceStateModel,
	isHostedWorkspaceAvailable,
	isHostedWorkspacePendingReady,
	isHostedWorkspaceRestorable,
	waitForHostedWorkspaceReady,
} from '../common/hostedWorkspaceState.js';
import { reopenHucodeHostedWorkspaceInNormalWindow } from
	'../common/omniWorkspaceReopen.js';
import {
	HUCODE_OMNI_WEB_SHELL_CHANNEL,
	HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
	HucodeOmniWebChildMessage,
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
	IHucodeOmniWebWorkbenchClient,
} from '../../platform/window/common/hucodeOmniWebMessages.js';
import {
	getHucodeOmniHostedWorkbenchRoute,
	getHucodeOmniWorkbenchRoute,
	getHucodeServerPathCaseSensitive,
} from '../../platform/environment/common/hucodeWebConfiguration.js';
import { getProjectManagerPathComparisonKey } from
	'../../platform/projectManager/common/projectManagerState.js';
import { IHucodeWebOmniHostSurfaceService } from
	'./webOmniHostSurfaceService.js';
import {
	createHostedWorkbenchRestorePlan,
	HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING,
	HucodeHostedWorkbenchRestorePolicy,
	IHucodeRetainedWorkbench,
	RetainedWorkbenchCatalog,
} from '../common/retainedWorkbench.js';
import { IStorageService, StorageScope, StorageTarget } from
	'../../platform/storage/common/storage.js';
import { ProjectSwitcherOmniSection } from
	'../common/projectSwitcher/projectSwitcherViewState.js';

interface IHostedIframeConnection {
	readonly workbench: IHucodeOmniWebWorkbenchClient;
	readonly disposables: DisposableStore;
}

interface IHostedIframeInstance {
	instanceId: string;
	projectId?: string;
	retainedWorkbenchId?: string;
	worktreePath: string;
	state: HucodeHostedWorkbenchLifecycleState;
	iframe?: HTMLIFrameElement;
	visible: boolean;
	focused: boolean;
	lastActiveAt?: number;
	lifecycleGeneration: number;
	connection?: IHostedIframeConnection;
}

/** Persisted serve-web catalog and hosted-workbench restore snapshot. */
export interface IWebHucodeShellPersistedState {
	readonly retainedWorkbenches: readonly IHucodeRetainedWorkbench[];
	readonly residentWorkspaces: readonly {
		readonly projectId?: string;
		readonly worktreePath: string;
		readonly lastActiveAt?: number;
	}[];
	readonly activeWorktreePath?: string;
}

/** Persistence seam for serve-web Omni catalog and restore state. */
export interface IWebHucodeShellPersistenceAdapter {
	load(): IWebHucodeShellPersistedState | undefined;
	save(state: IWebHucodeShellPersistedState): void;
}

/** File-system seam used to reject missing folders before iframe creation. */
export interface IWebHucodeShellFolderAccess {
	exists(worktreePath: string): Promise<boolean>;
}

/** Resolves a server path through the active remote file-system provider. */
export function getWebHucodeShellFolderResource(
	worktreePath: string,
	remoteAuthority: string | undefined
): URI {
	return remoteAuthority
		? URI.file(worktreePath).with({
			scheme: Schemas.vscodeRemote,
			authority: remoteAuthority,
		})
		: URI.file(worktreePath);
}

/** Creates the production folder preflight adapter around file-service stat. */
export function createWebHucodeShellFolderAccess(
	remoteAuthority: string | undefined,
	stat: (resource: URI) => Promise<{ readonly isDirectory: boolean }>
): IWebHucodeShellFolderAccess {
	return {
		async exists(worktreePath: string): Promise<boolean> {
			try {
				const resource = getWebHucodeShellFolderResource(
					worktreePath,
					remoteAuthority
				);
				return (await stat(resource)).isDirectory;
			} catch {
				return false;
			}
		},
	};
}

/** Drops malformed serve-web persistence entries before restore scheduling. */
export function sanitizeWebHucodeShellPersistedState(
	value: unknown
): IWebHucodeShellPersistedState | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const candidate = value as Partial<IWebHucodeShellPersistedState>;
	if (!Array.isArray(candidate.retainedWorkbenches) ||
		!Array.isArray(candidate.residentWorkspaces)
	) {
		return undefined;
	}
	return {
		retainedWorkbenches: candidate.retainedWorkbenches,
		residentWorkspaces: candidate.residentWorkspaces.filter(entry =>
			!!entry && typeof entry === 'object' &&
			typeof entry.worktreePath === 'string' &&
			entry.worktreePath.length > 0 &&
			(entry.projectId === undefined ||
				typeof entry.projectId === 'string') &&
			(entry.lastActiveAt === undefined ||
				Number.isFinite(entry.lastActiveAt))
		),
		activeWorktreePath: typeof candidate.activeWorktreePath === 'string'
			? candidate.activeWorktreePath
			: undefined,
	};
}

const emptyWebPersistence: IWebHucodeShellPersistenceAdapter = {
	load: () => undefined,
	save: () => { },
};

const assumeFoldersExist: IWebHucodeShellFolderAccess = {
	exists: async () => true,
};

const WEB_OMNI_WORKBENCHES_STORAGE_KEY =
	'hucode.omni.webRetainedWorkbenches';

class StorageServiceWebHucodeShellPersistence
	implements IWebHucodeShellPersistenceAdapter {

	constructor(private readonly storageService: IStorageService) { }

	load(): IWebHucodeShellPersistedState | undefined {
		const raw = this.storageService.get(
			WEB_OMNI_WORKBENCHES_STORAGE_KEY,
			StorageScope.PROFILE
		);
		if (!raw) {
			return undefined;
		}
		try {
			return sanitizeWebHucodeShellPersistedState(JSON.parse(raw));
		} catch {
			return undefined;
		}
	}

	save(state: IWebHucodeShellPersistedState): void {
		this.storageService.store(
			WEB_OMNI_WORKBENCHES_STORAGE_KEY,
			JSON.stringify(state),
			StorageScope.PROFILE,
			StorageTarget.MACHINE
		);
	}
}

type WebHucodeShellTimer = ReturnType<typeof setTimeout>;
type HostedUnloadResult = 'ready' | 'vetoed' | 'timeout';
type IWebHucodeShellCommandService = Pick<ICommandService, 'executeCommand'>;
type IWebHucodeShellHostSurfaceService = Pick<
	IHucodeWebOmniHostSurfaceService,
	'onDidChangeSurface' | 'getSurface'
>;

const REQUEST_TIMEOUT = Symbol('hucodeOmniWebRequestTimeout');

/**
 * Server routing configuration the web shell needs to build workbench URLs.
 */
export interface IWebHucodeShellOptions {
	readonly workbenchRoute: string;
	readonly hostedWorkbenchRoute: string;
	readonly serverPathCaseSensitive: boolean;
}

/**
 * Browser and DOM seams used by the web shell, injectable so the controller
 * can be unit-tested without a live window.
 */
export interface IWebHucodeShellBrowserAdapter {
	readonly windowId: number;
	readonly origin: string;
	createIframe(): HTMLIFrameElement;
	addMessageListener(listener: (event: MessageEvent) => void): IDisposable;
	setTimeout(callback: () => void, timeout: number): WebHucodeShellTimer;
	clearTimeout(handle: WebHucodeShellTimer): void;
	open(url: string): void;
	focusIframe(iframe: HTMLIFrameElement): void;
	focusIframeContent(iframe: HTMLIFrameElement): void;
	reloadIframe(iframe: HTMLIFrameElement): void;
	createMessageChannel(): MessageChannel;
	postPortMessage(
		iframe: HTMLIFrameElement,
		message: object,
		port: MessagePort
	): void;
}

function defaultWebHucodeShellBrowserAdapter():
	IWebHucodeShellBrowserAdapter {
	return {
		windowId: getWindowId(mainWindow),
		origin: mainWindow.location.origin,
		createIframe: () => document.createElement('iframe'),
		addMessageListener: listener => {
			mainWindow.addEventListener('message', listener);
			return toDisposable(() => {
				mainWindow.removeEventListener('message', listener);
			});
		},
		setTimeout: (callback, timeout) => setTimeout(callback, timeout),
		clearTimeout: handle => clearTimeout(handle),
		open: url => {
			mainWindow.open(url);
		},
		focusIframe: iframe => iframe.focus(),
		focusIframeContent: iframe => iframe.contentWindow?.focus(),
		reloadIframe: iframe => iframe.contentWindow?.location.reload(),
		createMessageChannel: () => new MessageChannel(),
		postPortMessage: (iframe, message, port) => {
			iframe.contentWindow?.postMessage(
				message,
				mainWindow.location.origin,
				[port]
			);
		},
	};
}

/**
 * Browser implementation of the Hucode Omni shell service.
 *
 * Hosted iframes bootstrap over window messages (`Ready`/`Focus`) and are
 * then driven over a per-instance MessagePort IPC connection: the shell
 * exposes itself as the shell channel and calls back into the hosted
 * workbench through the workbench channel.
 */
export class WebHucodeShellController extends Disposable
	implements IHucodeShellService {

	declare readonly _serviceBrand: undefined;
	readonly supportsWorkspaceScreenshotOverlay = false;
	private static readonly READY_TIMEOUT_MS = 30000;
	private static readonly COMMAND_TIMEOUT_MS = 5000;
	private static readonly UNLOAD_TIMEOUT_MS = 1500;

	private readonly windowId: number;
	private readonly workbenchRoute: string;
	private readonly hostedWorkbenchRoute: string;
	private readonly serverPathCaseSensitive: boolean;
	private readonly hostedWorkspaces: HostedWorkspaceStateModel<
		IHostedIframeInstance
	>;
	private readonly retainedWorkbenches: RetainedWorkbenchCatalog;
	private restorePolicy: HucodeHostedWorkbenchRestorePolicy;
	private readonly initialization: Promise<void>;
	private shuttingDown = false;
	private stateEmissionDeferrals = 0;
	private stateEmissionPending = false;
	private activationIntentGeneration = 0;
	private lifecycleGeneration = 0;

	private readonly pendingConnectionDisposals = new Set<DisposableStore>();

	private readonly _onDidChangeWindowState =
		this._register(new Emitter<IHucodeShellWindowStateChange>());
	readonly onDidChangeWindowState = this._onDidChangeWindowState.event;

	constructor(
		options: IWebHucodeShellOptions,
		private readonly commandService: IWebHucodeShellCommandService,
		private readonly hostSurfaceService: IWebHucodeShellHostSurfaceService,
		private readonly browser: IWebHucodeShellBrowserAdapter =
			defaultWebHucodeShellBrowserAdapter(),
		private readonly persistence: IWebHucodeShellPersistenceAdapter =
			emptyWebPersistence,
		restorePolicy: HucodeHostedWorkbenchRestorePolicy = 'active',
		private readonly folderAccess: IWebHucodeShellFolderAccess =
			assumeFoldersExist,
	) {
		super();

		this.windowId = browser.windowId;
		this.workbenchRoute = options.workbenchRoute;
		this.hostedWorkbenchRoute = options.hostedWorkbenchRoute;
		this.serverPathCaseSensitive = options.serverPathCaseSensitive;
		this.hostedWorkspaces = new HostedWorkspaceStateModel(
			path => this.toPathKey(path)
		);
		this.restorePolicy = restorePolicy;
		const persisted = sanitizeWebHucodeShellPersistedState(
			this.persistence.load()
		);
		this.retainedWorkbenches = new RetainedWorkbenchCatalog(
			persisted?.retainedWorkbenches,
			uri => this.toPathKey(uri.fsPath),
			generateUuid
		);
		this.initialization = this.restorePersistedWorkbenches(persisted);
		this._register(this.hostSurfaceService.onDidChangeSurface(surface => {
			if (surface) {
				this.attachIframes(surface);
			}
		}));
		this._register(this.browser.addMessageListener(this.onMessage));
		this._register(toDisposable(() => {
			for (const instance of this.instancesById.values()) {
				this.disposeConnection(instance);
			}
		}));
	}

	async getWindowState(
		windowId: number
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		return windowId === this.windowId ? this.getState() : emptyState();
	}

	async findHostedWorkspaceByPath(
		worktreePath: string
	): Promise<IHucodeHostedWorkspaceOwner | undefined> {
		await this.initialization;
		const candidate = this.getInstanceByPath(worktreePath);
		const instance = candidate && isHostedWorkspaceRestorable(candidate)
			? candidate
			: undefined;
		return instance
			? {
				windowId: this.windowId,
				instanceId: instance.instanceId,
				projectId: instance.projectId,
				worktreePath: instance.worktreePath,
			}
			: undefined;
	}

	async focusHostedWorkspaceByPath(
		worktreePath: string,
		projectId?: string
	): Promise<boolean> {
		await this.initialization;
		let instance = this.getInstanceByPath(worktreePath);
		if (!instance || !isHostedWorkspaceRestorable(instance)) {
			return false;
		}

		if (instance.state === 'dormant') {
			await this.openWorkspace(
				this.windowId,
				worktreePath,
				projectId ?? instance.projectId
			);
			instance = this.getAvailableInstanceByPath(worktreePath);
			if (!instance) {
				return false;
			}
		}
		instance.projectId = projectId ?? instance.projectId;
		this.activateInstance(instance);
		this.focusIframe(instance);
		return true;
	}

	async focusNormalWindowByPath(_worktreePath: string): Promise<boolean> {
		return false;
	}

	async openWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return this.getState();
		}
		const activationIntent = ++this.activationIntentGeneration;
		let retained = this.retainedWorkbenches.getByUri(
			URI.file(worktreePath)
		);
		if (projectId && retained) {
			this.retainedWorkbenches.dismiss(retained.id);
			retained = undefined;
		} else if (!projectId) {
			retained = this.retainedWorkbenches.retain(
				URI.file(worktreePath),
				'loaded',
				Date.now()
			);
		}

		const retainedWorkbenchId = retained?.id;
		const existing = this.getInstanceByPath(worktreePath);
		if (existing && isHostedWorkspaceAvailable(existing)) {
			existing.projectId = projectId ?? existing.projectId;
			existing.retainedWorkbenchId = retained?.id;
			if (retained?.folderStatus === 'missing') {
				this.retainedWorkbenches.update(retained.id, {
					folderStatus: undefined,
				});
			}
			this.activateInstance(existing);
			return this.getState();
		}

		const folderExists = await this.folderAccess.exists(worktreePath);
		retained = this.retainedWorkbenches.getByUri(URI.file(worktreePath));
		const currentInstance = this.getInstanceByPath(worktreePath);
		if (currentInstance && isHostedWorkspaceAvailable(currentInstance)) {
			currentInstance.projectId = projectId ?? currentInstance.projectId;
			currentInstance.retainedWorkbenchId = retained?.id;
			if (retained?.folderStatus === 'missing') {
				this.retainedWorkbenches.update(retained.id, {
					folderStatus: undefined,
				});
			}
			if (activationIntent === this.activationIntentGeneration) {
				this.activateInstance(currentInstance);
			}
			return this.getState();
		}
		if (!projectId && (
			!retained ||
			retained.id !== retainedWorkbenchId ||
			retained.desiredState !== 'loaded'
		)) {
			return this.getState();
		}

		if (!folderExists) {
			await this.deferStateEmission(async () => {
				if (currentInstance) {
					this.removeInstance(currentInstance);
				}
				if (retained) {
					this.retainedWorkbenches.update(retained.id, {
						folderStatus: 'missing',
					});
				}
				this.emitState();
			});
			return this.getState();
		}
		if (retained?.folderStatus === 'missing') {
			this.retainedWorkbenches.update(retained.id, {
				folderStatus: undefined,
			});
		}

		if (currentInstance) {
			if (currentInstance.state === 'dormant') {
				this.hostedWorkspaces.removeInstance(currentInstance);
			} else {
				this.removeInstance(currentInstance);
			}
		}

		const instance = this.createInstance(
			worktreePath,
			projectId,
			retained?.id
		);
		this.hostedWorkspaces.addInstance(instance);
		this.attachIframe(instance);
		if (activationIntent === this.activationIntentGeneration) {
			this.activateInstance(instance);
		} else {
			this.emitState();
		}
		return this.getState();
	}

	async retainAndOpenWorkbench(
		windowId: number,
		folderUri: UriComponents
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return this.getState();
		}
		return this.openWorkspace(windowId, URI.revive(folderUri).fsPath);
	}

	async unloadRetainedWorkbench(
		windowId: number,
		workbenchId: string
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return this.getState();
		}
		const record = this.retainedWorkbenches.getById(workbenchId);
		if (!record) {
			return this.getState();
		}
		await this.deferStateEmission(async () => {
			const instance = this.getInstanceByPath(
				URI.revive(record.folderUri).fsPath
			);
			if (instance && instance.state !== 'dormant' &&
				!await this.unloadAndRemoveInstance(instance)
			) {
				return;
			}
			if (instance?.state === 'dormant') {
				this.hostedWorkspaces.removeInstance(instance);
			}
			this.retainedWorkbenches.update(workbenchId, {
				desiredState: 'unloaded',
			});
			this.emitState();
		});
		return this.getState();
	}

	async dismissRetainedWorkbench(
		windowId: number,
		workbenchId: string
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return this.getState();
		}
		const record = this.retainedWorkbenches.getById(workbenchId);
		if (!record) {
			return this.getState();
		}
		await this.deferStateEmission(async () => {
			const instance = this.getInstanceByPath(
				URI.revive(record.folderUri).fsPath
			);
			if (instance && instance.state !== 'dormant' &&
				!await this.unloadAndRemoveInstance(instance)
			) {
				return;
			}
			if (instance?.state === 'dormant') {
				this.hostedWorkspaces.removeInstance(instance);
			}
			this.retainedWorkbenches.dismiss(workbenchId);
			this.emitState();
		});
		return this.getState();
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

	async reorderRetainedWorkbenches(
		windowId: number,
		orderedWorkbenchIds: readonly string[]
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId === this.windowId &&
			this.retainedWorkbenches.reorder(orderedWorkbenchIds)
		) {
			this.emitState();
		}
		return this.getState();
	}

	async reconcileRetainedWorkbenches(
		windowId: number,
		projectFolders: readonly {
			readonly projectId: string;
			readonly folderUri: UriComponents;
		}[]
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return this.getState();
		}
		for (const projectFolder of projectFolders) {
			const instance = this.getInstanceByPath(
				URI.revive(projectFolder.folderUri).fsPath
			);
			if (instance) {
				instance.projectId = projectFolder.projectId;
			}
		}
		if (this.retainedWorkbenches.reconcileProjectPaths(
			projectFolders.map(folder => URI.revive(folder.folderUri))
		)) {
			this.emitState();
		}
		return this.getState();
	}

	async setHostedWorkbenchRestorePolicy(
		windowId: number,
		policy: HucodeHostedWorkbenchRestorePolicy
	): Promise<void> {
		await this.initialization;
		if (windowId === this.windowId) {
			this.restorePolicy = policy;
		}
	}

	async openFilesInWorkspace(
		windowId: number,
		worktreePath: string,
		request: INativeOpenFileRequest,
		projectId?: string
	): Promise<boolean> {
		if (windowId !== this.windowId) {
			return false;
		}

		await this.openWorkspace(windowId, worktreePath, projectId);

		const instance = this.getAvailableInstanceByPath(worktreePath);
		if (!instance || instance.instanceId !== this.activeInstanceId) {
			return false;
		}

		return this.openFilesInInstance(instance, request);
	}

	async openFilesInActiveWorkspace(
		windowId: number,
		request: INativeOpenFileRequest
	): Promise<boolean> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return false;
		}

		const instance = this.getAvailableActiveInstance();
		return instance
			? this.openFilesInInstance(instance, request)
			: false;
	}

	async closeWorkspace(
		windowId: number,
		instanceId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return this.getState();
		}

		const instance = instanceId
			? this.instancesById.get(instanceId)
			: this.getActiveInstance();
		if (!instance) {
			return this.getState();
		}

		const retained = this.retainedWorkbenches.getByUri(
			URI.file(instance.worktreePath)
		);
		if (!retained) {
			await this.unloadAndRemoveInstance(instance);
			return this.getState();
		}
		await this.deferStateEmission(async () => {
			if (await this.unloadAndRemoveInstance(instance)) {
				this.retainedWorkbenches.update(retained.id, {
					desiredState: 'unloaded',
				});
				this.emitState();
			}
		});
		return this.getState();
	}

	async reopenWorkspaceInNormalWindow(
		windowId: number,
		instanceId: string
	): Promise<boolean> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return false;
		}

		return reopenHucodeHostedWorkspaceInNormalWindow({
			getState: () => this.getState(),
			closeWorkspace: targetInstanceId =>
				this.closeWorkspace(this.windowId, targetInstanceId),
			focusNormalWindowByPath: worktreePath =>
				this.focusNormalWindowByPath(worktreePath),
			openNormalWindow: worktreePath => {
				this.browser.open(this.toNormalWorkbenchUrl(worktreePath));
			},
		}, instanceId);
	}

	async notifyHostedWorkspaceReady(
		windowId: number,
		instanceId: string
	): Promise<void> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return;
		}

		const instance = this.instancesById.get(instanceId);
		if (!instance || !isHostedWorkspaceAvailable(instance)) {
			return;
		}

		this.hostedWorkspaces.markInstanceReady(instance);
		this.emitState();
	}

	async focusWorkspace(_windowId: number): Promise<void> {
		await this.initialization;
		const instance = this.getAvailableActiveInstance();
		if (instance) {
			this.focusIframe(instance);
		}
	}

	async focusShell(_windowId: number): Promise<void> {
		await this.commandService.executeCommand(FOCUS_PROJECT_PANE_COMMAND_ID);
	}

	async setProjectsSidebarVisible(
		_windowId: number,
		visible: boolean
	): Promise<void> {
		await this.initialization;
		this.hostedWorkspaces.setProjectsSidebarVisible(
			visible,
			hasLoadedHostedWorkspace(this.instancesById.values())
		);
		this.emitState();
	}

	async setProjectSwitcherNavigationState(
		_windowId: number,
		canGoBack: boolean,
		canGoForward: boolean
	): Promise<void> {
		await this.initialization;
		if (!this.hostedWorkspaces.setProjectSwitcherNavigationState(
			canGoBack,
			canGoForward
		)) {
			return;
		}

		this.emitState();
	}

	async setProjectSwitcherSectionOrder(
		_windowId: number,
		order: readonly ProjectSwitcherOmniSection[]
	): Promise<void> {
		await this.initialization;
		if (!this.hostedWorkspaces.setProjectSwitcherSectionOrder(order)) {
			return;
		}

		this.emitState();
	}

	async runActionInShell(
		_windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		await this.commandService.executeCommand(
			request.id,
			...(request.args ?? [])
		);
		return true;
	}

	async runActionInWorkspace(
		_windowId: number,
		request: INativeRunActionInWindowRequest
	): Promise<boolean> {
		await this.initialization;
		const instance = this.getAvailableActiveInstance();
		if (!instance) {
			return false;
		}

		return this.runCommandInInstance(
			instance,
			request.id,
			request.args ?? []
		);
	}

	async runKeybindingInWorkspace(
		_windowId: number,
		_request: INativeRunKeybindingInWindowRequest
	): Promise<boolean> {
		await this.initialization;
		const instance = this.getAvailableActiveInstance();
		if (instance?.iframe) {
			this.browser.focusIframeContent(instance.iframe);
		}
		return false;
	}

	async triggerPasteInWorkspace(_windowId: number): Promise<boolean> {
		await this.initialization;
		const instance = this.getAvailableActiveInstance();
		if (instance?.iframe) {
			this.browser.focusIframeContent(instance.iframe);
		}
		return false;
	}

	async reloadWorkspace(_windowId: number): Promise<void> {
		await this.initialization;
		const instance = this.getAvailableActiveInstance();
		if (!instance) {
			return;
		}

		instance.state = 'loading';
		void this.runCommandInInstance(
			instance,
			'workbench.action.reloadWindow',
			[]
		);
		this.browser.setTimeout(() => {
			if (instance.state === 'loading' && instance.iframe) {
				this.browser.reloadIframe(instance.iframe);
			}
		}, 500);
		this.emitState();
	}

	async toggleWorkspaceDevTools(_windowId: number): Promise<boolean> {
		return false;
	}

	async layoutWorkspace(
		_windowId: number,
		_bounds: IRectangle
	): Promise<void> {
		// Hosted iframes fill the host surface through CSS, so the shell has no
		// per-bounds layout work to do in the web surface.
	}

	async captureWorkspaceScreenshot(
		_windowId: number,
		_rect?: IRectangle,
		_quality?: number
	): Promise<VSBuffer | undefined> {
		return undefined;
	}

	async setWorkspaceOverlayOcclusion(
		_windowId: number,
		_occluded: boolean
	): Promise<void> {
		// Web overlays are normal DOM and can layer above same-origin iframes.
	}

	async shutdownWindowWorkspaces(
		windowId: number,
		_reason: ShutdownReason
	): Promise<void> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return;
		}

		// Teardown must not rewrite the resident set used for the next startup.
		this.shuttingDown = true;
		for (const instance of [...this.instancesById.values()]) {
			await this.unloadAndRemoveInstance(instance);
		}
	}

	private readonly onMessage = (event: MessageEvent): void => {
		if (
			event.origin !== this.browser.origin ||
			!isHucodeOmniWebChildMessage(event.data)
		) {
			return;
		}

		const instance = this.instancesById.get(event.data.instanceId);
		if (!instance?.iframe ||
			event.source !== instance.iframe.contentWindow
		) {
			return;
		}

		this.handleChildMessage(instance, event.data);
	};

	private handleChildMessage(
		instance: IHostedIframeInstance,
		message: HucodeOmniWebChildMessage
	): void {
		if (!isHostedWorkspaceAvailable(instance)) {
			return;
		}

		switch (message.type) {
			case HucodeOmniWebChildMessageType.Ready:
				this.connectInstance(instance);
				void this.notifyHostedWorkspaceReady(
					this.windowId,
					message.instanceId
				);
				break;
			case HucodeOmniWebChildMessageType.Focus:
				instance.focused = message.focused && instance.visible;
				if (instance.focused) {
					this.activateInstance(instance);
				} else {
					this.emitState();
				}
				break;
		}
	}

	/**
	 * Establishes the per-instance MessagePort IPC connection. A repeated
	 * ready signal means the iframe document reloaded, so any previous
	 * connection is replaced.
	 */
	private connectInstance(instance: IHostedIframeInstance): void {
		this.disposeConnection(instance);

		const disposables = new DisposableStore();
		const channel = this.browser.createMessageChannel();
		const client = disposables.add(new MessagePortClient(
			channel.port1,
			`hucodeOmniWebShell:${instance.instanceId}`
		));
		client.registerChannel(
			HUCODE_OMNI_WEB_SHELL_CHANNEL,
			ProxyChannel.fromService(this, disposables)
		);
		instance.connection = {
			workbench: ProxyChannel.toService<IHucodeOmniWebWorkbenchClient>(
				client.getChannel(HUCODE_OMNI_WEB_WORKBENCH_CHANNEL)
			),
			disposables,
		};
		if (!instance.iframe) {
			return;
		}
		this.browser.postPortMessage(instance.iframe, {
			type: HucodeOmniWebParentMessageType.Port,
			instanceId: instance.instanceId,
			windowId: this.windowId,
		}, channel.port2);
	}

	private disposeConnection(instance: IHostedIframeInstance): void {
		const connection = instance.connection;
		if (!connection) {
			return;
		}

		instance.connection = undefined;
		// Closing a workspace over its own shell channel must not close the
		// port before the pending response has been flushed to the iframe.
		this.pendingConnectionDisposals.add(connection.disposables);
		this.browser.setTimeout(() => {
			if (this.pendingConnectionDisposals.delete(connection.disposables)) {
				connection.disposables.dispose();
			}
		}, 0);
	}

	override dispose(): void {
		super.dispose();

		for (const disposables of this.pendingConnectionDisposals) {
			disposables.dispose();
		}
		this.pendingConnectionDisposals.clear();
	}

	private async restorePersistedWorkbenches(
		persisted: IWebHucodeShellPersistedState | undefined
	): Promise<void> {
		if (!persisted) {
			return;
		}
		const retainedCandidates = this.retainedWorkbenches.all
			.filter(record => record.desiredState === 'loaded')
			.map(record => ({
				worktreePath: URI.revive(record.folderUri).fsPath,
				retainedWorkbenchId: record.id,
				lastActiveAt: record.lastActiveAt,
			}));
		const availableCandidates = await this.filterAvailableRestoreCandidates([
			...retainedCandidates,
			...persisted.residentWorkspaces.filter(entry => !!entry.projectId),
		]);
		const plan = createHostedWorkbenchRestorePlan(
			availableCandidates,
			persisted.activeWorktreePath,
			this.restorePolicy,
			(a, b) =>
				this.toPathKey(a) === this.toPathKey(b));

		for (const candidate of plan.dormant) {
			this.hostedWorkspaces.addInstance({
				instanceId: generateUuid(),
				projectId: candidate.projectId,
				retainedWorkbenchId: candidate.retainedWorkbenchId,
				worktreePath: candidate.worktreePath,
				state: 'dormant',
				visible: false,
				focused: false,
				lastActiveAt: candidate.lastActiveAt,
				lifecycleGeneration: 0,
			});
		}

		let activeInstance: IHostedIframeInstance | undefined;
		for (const [index, candidate] of plan.eager.entries()) {
			const instance = this.createInstance(
				candidate.worktreePath,
				candidate.projectId,
				candidate.retainedWorkbenchId
			);
			instance.lastActiveAt = candidate.lastActiveAt;
			this.hostedWorkspaces.addInstance(instance);
			this.attachIframe(instance);
			if (index === 0) {
				activeInstance = instance;
			}
		}
		if (activeInstance) {
			this.activateInstance(activeInstance);
		}
		if (!activeInstance) {
			this.emitState();
		}
	}

	private async filterAvailableRestoreCandidates(
		candidates: readonly {
			readonly worktreePath: string;
			readonly projectId?: string;
			readonly retainedWorkbenchId?: string;
			readonly lastActiveAt?: number;
		}[]
	): Promise<typeof candidates> {
		const available = [];
		for (const candidate of candidates) {
			if (await this.folderAccess.exists(candidate.worktreePath)) {
				if (candidate.retainedWorkbenchId) {
					this.retainedWorkbenches.update(
						candidate.retainedWorkbenchId,
						{ folderStatus: undefined }
					);
				}
				available.push(candidate);
				continue;
			}
			if (candidate.retainedWorkbenchId) {
				this.retainedWorkbenches.update(candidate.retainedWorkbenchId, {
					folderStatus: 'missing',
				});
			}
		}
		return available;
	}

	private createInstance(
		worktreePath: string,
		projectId: string | undefined,
		retainedWorkbenchId?: string
	): IHostedIframeInstance {
		const instanceId = generateUuid();
		const iframe = this.browser.createIframe();
		iframe.className = 'hucode-omni-host-iframe hidden';
		iframe.title = worktreePath;
		iframe.dataset.hucodeHostedInstanceId = instanceId;
		iframe.src = this.toWorkbenchUrl(instanceId, worktreePath);

		return {
			instanceId,
			projectId,
			retainedWorkbenchId,
			worktreePath,
			state: 'loading',
			iframe,
			visible: false,
			focused: false,
			lastActiveAt: Date.now(),
			lifecycleGeneration: 0,
		};
	}

	private activateInstance(instance: IHostedIframeInstance): void {
		instance.lifecycleGeneration = ++this.lifecycleGeneration;
		this.hostedWorkspaces.activateInstance(instance);
		const retained = this.retainedWorkbenches.getByUri(
			URI.file(instance.worktreePath)
		);
		if (retained) {
			this.retainedWorkbenches.update(retained.id, {
				desiredState: 'loaded',
				lastActiveAt: instance.lastActiveAt,
			});
		}
		for (const candidate of this.instancesById.values()) {
			const visible = candidate.instanceId === instance.instanceId;
			candidate.visible = visible;
			candidate.focused = visible ? candidate.focused : false;
			candidate.iframe?.classList.toggle('hidden', !visible);
		}
		this.emitState();
	}

	private removeInstance(instance: IHostedIframeInstance): void {
		const wasActive = this.activeInstanceId === instance.instanceId;
		instance.state = 'unloaded';
		this.disposeConnection(instance);
		instance.iframe?.remove();
		this.hostedWorkspaces.removeInstance(instance);
		if (wasActive) {
			const next = getMostRecentHostedWorkspace(this.instancesById.values());
			if (next) {
				this.activateInstance(next);
				return;
			}
		}
		this.emitState();
	}

	private async unloadAndRemoveInstance(
		instance: IHostedIframeInstance
	): Promise<boolean> {
		const lifecycleGeneration = instance.lifecycleGeneration;
		// Pending-ready workbenches close directly: a never-connected iframe
		// cannot hold unsaved state and is not listening yet, and a reloading
		// one is already running its own beforeunload handling, where a
		// handshake would only hang until the unload timeout.
		if (
			isHostedWorkspaceAvailable(instance) &&
			!isHostedWorkspacePendingReady(instance) &&
			await this.requestUnload(instance) !== 'ready'
		) {
			return false;
		}
		if (
			instance.lifecycleGeneration !== lifecycleGeneration ||
			this.getInstanceByPath(instance.worktreePath) !== instance
		) {
			return false;
		}

		this.removeInstance(instance);
		return true;
	}

	private async requestUnload(
		instance: IHostedIframeInstance
	): Promise<HostedUnloadResult> {
		const workbench = instance.connection?.workbench;
		if (!workbench) {
			return 'ready';
		}

		const result = await this.raceTimeout(
			workbench.prepareUnload().then(
				ready => ready ? 'ready' as const : 'vetoed' as const,
				() => 'vetoed' as const
			),
			WebHucodeShellController.UNLOAD_TIMEOUT_MS
		);
		return result === REQUEST_TIMEOUT ? 'timeout' : result;
	}

	private async openFilesInInstance(
		instance: IHostedIframeInstance,
		request: INativeOpenFileRequest
	): Promise<boolean> {
		if (!await this.waitForInstanceReady(instance)) {
			return false;
		}

		const workbench = instance.connection?.workbench;
		if (!workbench) {
			return false;
		}

		const result = await this.raceTimeout(
			workbench.openFiles(request).catch(() => false),
			WebHucodeShellController.COMMAND_TIMEOUT_MS
		);
		return result === true;
	}

	private waitForInstanceReady(instance: IHostedIframeInstance): Promise<boolean> {
		return waitForHostedWorkspaceReady(
			instance,
			this.onDidChangeWindowState,
			WebHucodeShellController.READY_TIMEOUT_MS
		);
	}

	/**
	 * Runs a workbench command in an instance. Completed results also settle
	 * a pending `loading` state: success marks the workbench ready, failure
	 * marks it crashed. Timeouts leave the state untouched so an in-flight
	 * reload keeps its iframe-level fallback.
	 */
	private async runCommandInInstance(
		instance: IHostedIframeInstance,
		commandId: string,
		args: readonly unknown[]
	): Promise<boolean> {
		const workbench = instance.connection?.workbench;
		if (!workbench) {
			return false;
		}

		const result = await this.raceTimeout(
			workbench.runCommand(commandId, args).catch(() => false),
			WebHucodeShellController.COMMAND_TIMEOUT_MS
		);
		if (result === REQUEST_TIMEOUT) {
			return false;
		}

		if (instance.state === 'loading') {
			if (result) {
				this.hostedWorkspaces.markInstanceReady(instance);
			} else {
				instance.state = 'crashed';
				if (instance.retainedWorkbenchId) {
					this.retainedWorkbenches.update(
						instance.retainedWorkbenchId,
						{ desiredState: 'unloaded' }
					);
				}
			}
			this.emitState();
		}
		return result;
	}

	private raceTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number
	): Promise<T | typeof REQUEST_TIMEOUT> {
		return new Promise(resolve => {
			const handle = this.browser.setTimeout(
				() => resolve(REQUEST_TIMEOUT),
				timeoutMs
			);
			void promise.then(value => {
				this.browser.clearTimeout(handle);
				resolve(value);
			});
		});
	}

	private focusIframe(instance: IHostedIframeInstance): void {
		if (!instance.iframe) {
			return;
		}
		this.browser.focusIframe(instance.iframe);
		this.browser.focusIframeContent(instance.iframe);
	}

	private attachIframes(surface: HTMLElement): void {
		for (const instance of this.instancesById.values()) {
			if (instance.iframe && instance.iframe.parentElement !== surface) {
				surface.append(instance.iframe);
			}
		}
	}

	private attachIframe(instance: IHostedIframeInstance): void {
		const surface = this.hostSurfaceService.getSurface();
		if (surface && instance.iframe) {
			surface.append(instance.iframe);
		}
	}

	private toWorkbenchUrl(instanceId: string, worktreePath: string): string {
		const workbenchUrl = new URL(
			this.hostedWorkbenchRoute,
			this.browser.origin
		);
		workbenchUrl.searchParams.set('folder', worktreePath);
		workbenchUrl.searchParams.set('payload', JSON.stringify([
			['isHostedOmniWorkspace', 'true'],
			['hostedInstanceId', instanceId],
		]));
		return workbenchUrl.toString();
	}

	private toNormalWorkbenchUrl(worktreePath: string): string {
		const workbenchUrl = new URL(this.workbenchRoute, this.browser.origin);
		workbenchUrl.searchParams.set('folder', worktreePath);
		return workbenchUrl.toString();
	}

	private getActiveInstance(): IHostedIframeInstance | undefined {
		return this.activeInstanceId
			? this.instancesById.get(this.activeInstanceId)
			: undefined;
	}

	private getAvailableActiveInstance(): IHostedIframeInstance | undefined {
		const instance = this.getActiveInstance();
		return instance && isHostedWorkspaceAvailable(instance)
			? instance
			: undefined;
	}

	private getInstanceByPath(
		worktreePath: string
	): IHostedIframeInstance | undefined {
		return this.hostedWorkspaces.getInstanceByPath(worktreePath);
	}

	private getAvailableInstanceByPath(
		worktreePath: string
	): IHostedIframeInstance | undefined {
		const instance = this.getInstanceByPath(worktreePath);
		return instance && isHostedWorkspaceAvailable(instance)
			? instance
			: undefined;
	}

	private getState(): IHucodeHostedWorkspaceState {
		return {
			...this.hostedWorkspaces.toState(),
			retainedWorkbenches: this.retainedWorkbenches.all,
		};
	}

	private emitState(): void {
		if (this.stateEmissionDeferrals > 0) {
			this.stateEmissionPending = true;
			return;
		}
		this.hostedWorkspaces.setProjectsSidebarVisible(
			this.hostedWorkspaces.projectsSidebarVisible,
			hasLoadedHostedWorkspace(this.instancesById.values())
		);
		if (!this.shuttingDown) {
			this.persistence.save({
				retainedWorkbenches: this.retainedWorkbenches.all,
				residentWorkspaces: Array.from(this.instancesById.values())
					.filter(instance => !!instance.projectId &&
						instance.state !== 'unloaded' &&
						instance.state !== 'crashed')
					.map(instance => ({
						projectId: instance.projectId,
						worktreePath: instance.worktreePath,
						lastActiveAt: instance.lastActiveAt,
					})),
				activeWorktreePath: this.getActiveInstance()?.worktreePath,
			});
		}
		this._onDidChangeWindowState.fire({
			windowId: this.windowId,
			state: this.getState(),
		});
	}

	private toPathKey(path: string): string {
		return getProjectManagerPathComparisonKey(
			path,
			this.serverPathCaseSensitive
		);
	}

	private get instancesById(): Map<string, IHostedIframeInstance> {
		return this.hostedWorkspaces.instancesById;
	}

	private get activeInstanceId(): string | undefined {
		return this.hostedWorkspaces.activeInstanceId;
	}
}

function isHucodeOmniWebChildMessage(
	value: unknown
): value is HucodeOmniWebChildMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const type = (value as { readonly type?: unknown }).type;
	return type === HucodeOmniWebChildMessageType.Ready ||
		type === HucodeOmniWebChildMessageType.Focus;
}

function emptyState(): IHucodeHostedWorkspaceState {
	return createEmptyHostedWorkspaceState();
}

/**
 * Dependency-injected web shell service that wires the shell controller to the
 * serve-web environment configuration and host surface.
 */
export class WebHucodeShellService extends WebHucodeShellController {
	constructor(
		@IBrowserWorkbenchEnvironmentService
		environmentService: IBrowserWorkbenchEnvironmentService,
		@ICommandService commandService: ICommandService,
		@IHucodeWebOmniHostSurfaceService
		hostSurfaceService: IHucodeWebOmniHostSurfaceService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IFileService fileService: IFileService,
	) {
		super({
			workbenchRoute: getHucodeOmniWorkbenchRoute(
				environmentService.options
			),
			hostedWorkbenchRoute: getHucodeOmniHostedWorkbenchRoute(
				environmentService.options
			),
			serverPathCaseSensitive: getHucodeServerPathCaseSensitive(
				environmentService.options
			),
		}, commandService, hostSurfaceService, undefined,
			new StorageServiceWebHucodeShellPersistence(storageService),
			configurationService.getValue<HucodeHostedWorkbenchRestorePolicy>(
				HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING
			) ?? 'active', createWebHucodeShellFolderAccess(
				environmentService.remoteAuthority,
				resource => fileService.stat(resource)
			));
	}
}

registerSingleton(
	IHucodeShellService,
	WebHucodeShellService,
	InstantiationType.Delayed
);
