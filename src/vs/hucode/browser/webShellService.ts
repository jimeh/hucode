/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter, Event } from '../../base/common/event.js';
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
import {
	FileOperationResult,
	IFileService,
	toFileOperationResult,
} from '../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../platform/log/common/log.js';
import {
	INativeOpenFileRequest,
	INativeRunActionInWindowRequest,
	INativeRunKeybindingInWindowRequest,
	IRectangle,
} from '../../platform/window/common/window.js';
import {
	FOCUS_PROJECT_PANE_COMMAND_ID,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import {
	formatHucodeHostedShellActionCommandIdForLog,
	getHucodeHostedShellAction,
	getHucodeHostedShellActionCommandId,
} from '../../platform/window/common/hucodeHostedShellActions.js';
import {
	createBoundHucodeHostedShellFacade,
	HUCODE_HOSTED_SHELL_CHANNEL,
	HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
	HucodeHostedShellCapability,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedNavigationRequest,
	IHucodeHostedShellAuthorityState,
	IHucodeHostedShellBinding,
	IHucodeHostedShellContinuationAuthorization,
	IHucodeHostedShellDelegate,
	IHucodeHostedShellState,
	negotiateHucodeHostedShellCapabilities,
} from '../../platform/window/common/hucodeHostedShellService.js';
import { ShutdownReason } from
	'../../workbench/services/lifecycle/common/lifecycle.js';
import { IBrowserWorkbenchEnvironmentService } from
	'../../workbench/services/environment/browser/environmentService.js';
import {
	HucodeHostedWorkbenchLifecycleState,
	IHucodeCompleteProjectCatalogEntry,
	IHucodeHostedWorkspaceOwner,
	IHucodeHostedWorkspaceState,
	IHucodeProjectFolderPromotion,
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
	HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION,
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
import { IProjectManagerService } from
	'../../platform/projectManager/common/projectManager.js';

interface IHostedIframeConnection {
	readonly workbench: IHucodeOmniWebWorkbenchClient;
	readonly disposables: DisposableStore;
}

interface ITimedOutLegacyUnloadClaim {
	readonly workbench: IHucodeOmniWebWorkbenchClient;
	disposition: HostedUnloadDisposition;
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
	protocolVersion?: number;
	hostedShellProtocolVersion?: number;
	hostedShellCapabilities?: readonly HucodeHostedShellCapability[];
	connectionGeneration: number;
	pendingUnload?: Promise<boolean>;
	pendingUnloadDisposition?: HostedUnloadDisposition;
	timedOutLegacyUnload?: ITimedOutLegacyUnloadClaim;
}

interface IProjectCatalogSnapshot {
	readonly generation: number;
	readonly liveProjectIds: ReadonlySet<string> | undefined;
	readonly projectIdsByPath: ReadonlyMap<string, string>;
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
			} catch (error) {
				if (toFileOperationResult(error) ===
					FileOperationResult.FILE_NOT_FOUND) {
					return false;
				}
				throw error;
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

const silentWebShellLog: IWebHucodeShellLogService = {
	info: () => { },
	warn: () => { },
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
/**
 * Outcome of one phase of the hosted unload handshake.
 *
 * The two phases fail in opposite directions, so an unknown outcome means
 * something different in each. Before the commit there is a live workbench to
 * protect, so `prepare-failed` and `prepare-timeout` keep it. After the commit
 * has been sent there is not: it is irreversible and preparation already found
 * no objection, so `commit-failed` and `commit-timeout` remove the workbench
 * rather than leave the page wrapping one that has gone. Only `refused` is an
 * answer rather than a silence, and it keeps the workbench.
 */
type HostedUnloadResult =
	| 'ready'
	| 'vetoed'
	| 'prepare-failed'
	| 'prepare-timeout'
	| 'refused'
	| 'commit-failed'
	| 'commit-timeout';

/**
 * What a caller wants to become of a workbench once its unload succeeds.
 *
 * Concurrent requests share one handshake, so they also share one outcome:
 * the strongest disposition any of them asked for is applied once, centrally,
 * when the handshake completes. Without that, a workbench somebody closed
 * comes back as a dormant record because somebody else asked to suspend it at
 * the same moment, and which of the two wins depends on arrival order.
 */
type HostedUnloadDisposition = 'shutdown' | 'suspend' | 'unload' | 'dismiss';

const HOSTED_UNLOAD_DISPOSITION_RANK:
	Record<HostedUnloadDisposition, number> = {
	// Page teardown must not rewrite the restore set at all, so it is the
	// weakest; anything a user asked for outranks it.
	shutdown: 0,
	suspend: 1,
	unload: 2,
	dismiss: 3,
};

/** Picks the disposition a shared unload has to honour. */
function strongestUnloadDisposition(
	a: HostedUnloadDisposition,
	b: HostedUnloadDisposition
): HostedUnloadDisposition {
	return HOSTED_UNLOAD_DISPOSITION_RANK[a] >= HOSTED_UNLOAD_DISPOSITION_RANK[b]
		? a
		: b;
}

type IWebHucodeShellCommandService = Pick<ICommandService, 'executeCommand'>;
type IWebHucodeShellLogService = Pick<ILogService, 'info' | 'warn'>;
type IWebHucodeShellHostSurfaceService = Pick<
	IHucodeWebOmniHostSurfaceService,
	'onDidChangeSurface' | 'getSurface'
>;

const REQUEST_TIMEOUT = Symbol('hucodeOmniWebRequestTimeout');
const COMMAND_DELIVERY_UNKNOWN =
	Symbol('hucodeOmniWebCommandDeliveryUnknown');
const HUCODE_OMNI_CLIPBOARD_COMMANDS = new Set([
	'editor.action.clipboardCopyAction',
	'editor.action.clipboardCutAction',
]);
type IHucodeHostedWebShellConnectionFacade = Pick<
	IHucodeShellService,
	| 'onDidChangeWindowState'
	| 'getWindowState'
	| 'openAndFocusWorkspace'
	| 'closeWorkspace'
	| 'reopenWorkspaceInNormalWindow'
	| 'notifyHostedWorkspaceReady'
	| 'focusWorkspace'
	| 'focusShell'
	| 'runActionInShell'
	| 'reloadWorkspace'
>;

/**
 * Server routing configuration the web shell needs to build workbench URLs.
 */
export interface IWebHucodeShellOptions {
	readonly workbenchRoute: string;
	readonly hostedWorkbenchRoute: string;
	readonly serverPathCaseSensitive: boolean;
	readonly remoteAuthority?: string;
}

/** Project authority used by hosted navigation after URI validation. */
export interface IWebHucodeHostedNavigationProjectManager {
	getProjects(): Promise<readonly {
		readonly id: string;
		readonly worktrees: readonly { readonly path: string }[];
	}[]>;
	setLastActiveWorktree(
		projectId: string,
		worktreePath: string
	): Promise<void>;
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
	// Neither phase can block on the user: the web lifecycle service treats a
	// pending veto answer as a veto and never awaits one. What both phases do
	// await is a storage flush against IndexedDB, which under contention is
	// the only part that takes real time — `onWillShutdown` joiners are
	// invoked without being awaited, so no budget here has ever protected
	// them. Neither budget can be tight: a timeout does not cancel the phase
	// it gave up on, and a preparation that lands late has already run
	// shutdown listeners that do not all reset themselves.
	private static readonly PREPARE_UNLOAD_TIMEOUT_MS = 5000;
	private static readonly COMMIT_UNLOAD_TIMEOUT_MS = 5000;

	private readonly windowId: number;
	private readonly workbenchRoute: string;
	private readonly hostedWorkbenchRoute: string;
	private readonly serverPathCaseSensitive: boolean;
	private readonly remoteAuthority: string | undefined;
	private readonly hostedWorkspaces: HostedWorkspaceStateModel<
		IHostedIframeInstance
	>;
	private readonly retainedWorkbenches: RetainedWorkbenchCatalog;
	private restorePolicy: HucodeHostedWorkbenchRestorePolicy;
	private readonly initialization: Promise<void>;
	private initializationCancelled = false;
	private shuttingDown = false;
	private shutdownPromise: Promise<void> | undefined;
	private stateEmissionDeferrals = 0;
	private stateEmissionPending = false;
	private activationIntentGeneration = 0;
	private lifecycleGeneration = 0;
	private projectCatalogSnapshot: IProjectCatalogSnapshot | undefined;

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
		private readonly logService: IWebHucodeShellLogService =
			silentWebShellLog,
		private readonly navigationProjectManager?:
			IWebHucodeHostedNavigationProjectManager,
	) {
		super();

		this.windowId = browser.windowId;
		this.workbenchRoute = options.workbenchRoute;
		this.hostedWorkbenchRoute = options.hostedWorkbenchRoute;
		this.serverPathCaseSensitive = options.serverPathCaseSensitive;
		this.remoteAuthority = options.remoteAuthority;
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

		let effectiveProjectId = this.resolveProjectIdAgainstCatalog(
			worktreePath,
			projectId ?? instance.projectId
		);
		if (instance.state === 'dormant') {
			await this.openWorkspace(
				this.windowId,
				worktreePath,
				effectiveProjectId
			);
			instance = this.getAvailableInstanceByPath(worktreePath);
			if (!instance) {
				return false;
			}
		}
		effectiveProjectId = this.resolveProjectIdAgainstCatalog(
			worktreePath,
			projectId ?? instance.projectId
		);
		let retained = this.retainedWorkbenches.getByUri(
			URI.file(worktreePath)
		);
		if (effectiveProjectId && retained) {
			this.retainedWorkbenches.dismiss(retained.id);
			retained = undefined;
		} else if (!effectiveProjectId && !retained) {
			retained = this.retainedWorkbenches.retain(
				URI.file(worktreePath),
				'loaded'
			);
		}
		instance.projectId = effectiveProjectId;
		instance.retainedWorkbenchId = retained?.id;
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
		return this.doOpenWorkspace(
			windowId,
			worktreePath,
			projectId,
			false
		);
	}

	async openAndFocusWorkspace(
		windowId: number,
		worktreePath: string,
		projectId?: string
	): Promise<IHucodeHostedWorkspaceState> {
		return this.doOpenWorkspace(
			windowId,
			worktreePath,
			projectId,
			true
		);
	}

	private async navigateToFolderFromHosted(
		instance: IHostedIframeInstance,
		binding: IHucodeHostedShellBinding,
		request: IHucodeHostedNavigationRequest,
		authorization: IHucodeHostedShellContinuationAuthorization
	): Promise<HucodeHostedShellOperationOutcome> {
		await this.initialization;
		if (!this.isBoundInstanceActiveVisible(instance, binding)) {
			return HucodeHostedShellOperationOutcome.Rejected;
		}

		const resource = URI.revive(request.folderUri);
		if (
			resource.scheme !== Schemas.file &&
			(
				resource.scheme !== Schemas.vscodeRemote ||
				!this.optionsRemoteAuthorityMatches(resource)
			)
		) {
			return HucodeHostedShellOperationOutcome.Unsupported;
		}

		const activationIntent = ++this.activationIntentGeneration;
		let worktreePath = resource.fsPath;
		let projectId: string | undefined;
		if (this.navigationProjectManager) {
			let projects: Awaited<ReturnType<
				IWebHucodeHostedNavigationProjectManager['getProjects']
			>> = [];
			try {
				projects = await this.navigationProjectManager.getProjects();
			} catch {
				// An unavailable project catalog leaves the path eligible as an
				// arbitrary retained workbench.
			}
			if (!await authorization.isCurrentAndActiveVisible() ||
				activationIntent !== this.activationIntentGeneration) {
				return HucodeHostedShellOperationOutcome.Superseded;
			}
			const pathKey = this.toPathKey(worktreePath);
			for (const project of projects) {
				const worktree = project.worktrees.find(candidate =>
					this.toPathKey(candidate.path) === pathKey);
				if (worktree) {
					projectId = project.id;
					worktreePath = worktree.path;
					try {
						await this.navigationProjectManager.setLastActiveWorktree(
							project.id,
							worktree.path
						);
					} catch {
						// MRU persistence is best-effort; ownership remains the
						// authoritative catalog match above.
					}
					if (!await authorization.isCurrentAndActiveVisible() ||
						activationIntent !== this.activationIntentGeneration) {
						return HucodeHostedShellOperationOutcome.Superseded;
					}
					break;
				}
			}
		}

		if (!await authorization.isCurrentAndActiveVisible() ||
			activationIntent !== this.activationIntentGeneration) {
			return HucodeHostedShellOperationOutcome.Superseded;
		}
		const folderExists = this.getAvailableInstanceByPath(worktreePath)
			? undefined
			: await this.folderAccess.exists(worktreePath);
		if (!await authorization.isCurrentAndActiveVisible() ||
			activationIntent !== this.activationIntentGeneration) {
			return HucodeHostedShellOperationOutcome.Superseded;
		}
		const canApply = () =>
			activationIntent === this.activationIntentGeneration &&
			this.isBoundInstanceActiveVisible(instance, binding);
		let activationAuthorized = false;
		const canActivate = () => {
			activationAuthorized = canApply();
			return activationAuthorized;
		};
		await this.doOpenWorkspace(
			this.windowId,
			worktreePath,
			projectId,
			true,
			activationIntent,
			canActivate,
			folderExists,
			canApply
		);
		return activationAuthorized &&
			activationIntent === this.activationIntentGeneration
			? HucodeHostedShellOperationOutcome.Accepted
			: HucodeHostedShellOperationOutcome.Superseded;
	}

	private optionsRemoteAuthorityMatches(resource: URI): boolean {
		return !!this.remoteAuthority &&
			resource.authority === this.remoteAuthority;
	}

	/**
	 * Opens a workspace and optionally transfers browser focus while this
	 * request remains the latest activation intent.
	 */
	private async doOpenWorkspace(
		windowId: number,
		worktreePath: string,
		projectId: string | undefined,
		focus: boolean,
		activationIntent = ++this.activationIntentGeneration,
		canActivate: () => boolean = () => true,
		knownFolderExists: boolean | undefined = undefined,
		canApply: () => boolean = () => true
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return this.getState();
		}
		if (!canApply()) {
			return this.getState();
		}
		const existing = this.getInstanceByPath(worktreePath);
		const projectCatalogGeneration =
			this.projectCatalogSnapshot?.generation;
		let effectiveProjectId = this.resolveProjectIdAgainstCatalog(
			worktreePath,
			projectId ?? existing?.projectId
		);
		const wasProjectBacked = effectiveProjectId !== undefined;
		let retained = this.retainedWorkbenches.getByUri(
			URI.file(worktreePath)
		);
		if (effectiveProjectId && retained) {
			this.retainedWorkbenches.dismiss(retained.id);
			retained = undefined;
		} else if (!effectiveProjectId) {
			retained = this.retainedWorkbenches.retain(
				URI.file(worktreePath),
				'loaded'
			);
		}

		const retainedWorkbenchId = retained?.id;
		if (existing && isHostedWorkspaceAvailable(existing)) {
			existing.projectId = effectiveProjectId;
			existing.retainedWorkbenchId = retained?.id;
			if (retained?.folderStatus === 'missing') {
				this.retainedWorkbenches.update(retained.id, {
					folderStatus: undefined,
				});
			}
			if (
				activationIntent === this.activationIntentGeneration &&
				canActivate()
			) {
				this.activateInstance(existing);
				if (focus) {
					this.focusIframe(existing);
				}
			}
			return this.getState();
		}

		const folderExists = knownFolderExists ??
			await this.folderAccess.exists(worktreePath);
		if (!canApply()) {
			return this.getState();
		}
		retained = this.retainedWorkbenches.getByUri(URI.file(worktreePath));
		const currentInstance = this.getInstanceByPath(worktreePath);
		effectiveProjectId = this.resolveProjectIdAgainstCatalog(
			worktreePath,
			projectId ?? currentInstance?.projectId
		);
		const invalidatedByNewCatalog =
			wasProjectBacked &&
			effectiveProjectId === undefined &&
			this.projectCatalogSnapshot?.generation !== projectCatalogGeneration;
		if (effectiveProjectId && retained) {
			this.retainedWorkbenches.dismiss(retained.id);
			retained = undefined;
		} else if (invalidatedByNewCatalog && !retained) {
			retained = this.retainedWorkbenches.retain(
				URI.file(worktreePath),
				'loaded'
			);
		}
		if (currentInstance && isHostedWorkspaceAvailable(currentInstance)) {
			currentInstance.projectId = effectiveProjectId;
			currentInstance.retainedWorkbenchId = retained?.id;
			if (retained?.folderStatus === 'missing') {
				this.retainedWorkbenches.update(retained.id, {
					folderStatus: undefined,
				});
			}
			if (activationIntent === this.activationIntentGeneration &&
				canActivate()) {
				this.activateInstance(currentInstance);
				if (focus) {
					this.focusIframe(currentInstance);
				}
			}
			return this.getState();
		}
		if (!effectiveProjectId && (
			!retained ||
			retained.id !== retainedWorkbenchId ||
			retained.desiredState !== 'loaded'
		) && !invalidatedByNewCatalog) {
			this.focusActiveInstanceIfCurrent(
				activationIntent,
				focus,
				canActivate
			);
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
			this.focusActiveInstanceIfCurrent(
				activationIntent,
				focus,
				canActivate
			);
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
			effectiveProjectId,
			retained?.id
		);
		this.hostedWorkspaces.addInstance(instance);
		this.attachIframe(instance);
		if (activationIntent === this.activationIntentGeneration &&
			canActivate()) {
			this.activateInstance(instance);
			if (focus) {
				this.focusIframe(instance);
			}
		} else {
			this.emitState();
		}
		return this.getState();
	}

	/**
	 * Restores browser focus to the available active instance when this request
	 * still owns the latest activation intent.
	 */
	private focusActiveInstanceIfCurrent(
		activationIntent: number,
		focus: boolean,
		canActivate: () => boolean = () => true
	): void {
		if (!focus || activationIntent !== this.activationIntentGeneration ||
			!canActivate()) {
			return;
		}
		const active = this.getAvailableActiveInstance();
		if (active) {
			this.focusIframe(active);
		}
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

	/** Gracefully unloads a ready iframe and leaves it dormant. */
	async suspendWorkspace(
		windowId: number,
		instanceId: string,
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return this.getState();
		}
		const instance = this.instancesById.get(instanceId);
		if (!instance || (
			instance.state !== 'active' && instance.state !== 'loaded'
		)) {
			return this.getState();
		}

		await this.deferStateEmission(
			() => this.unloadAndRemoveInstance(instance, 'suspend')
		);
		return this.getState();
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
			const worktreePath = URI.revive(record.folderUri).fsPath;
			const instance = this.getInstanceByPath(worktreePath);
			if (instance && instance.state !== 'dormant') {
				await this.unloadAndRemoveInstance(instance, 'unload');
				return;
			}
			this.applyTerminalUnloadDisposition(
				worktreePath,
				'unload',
				workbenchId
			);
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
			const worktreePath = URI.revive(record.folderUri).fsPath;
			const instance = this.getInstanceByPath(worktreePath);
			if (instance && instance.state !== 'dormant') {
				await this.unloadAndRemoveInstance(instance, 'dismiss');
				return;
			}
			this.applyTerminalUnloadDisposition(
				worktreePath,
				'dismiss',
				workbenchId
			);
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

	async setRetainedWorkbenchLabel(
		windowId: number,
		workbenchId: string,
		label: string | undefined,
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId === this.windowId &&
			this.retainedWorkbenches.setLabel(workbenchId, label)
		) {
			this.emitState();
		}
		return this.getState();
	}

	async reconcileRetainedWorkbenchesWithCompleteProjectCatalog(
		windowId: number,
		projects: readonly IHucodeCompleteProjectCatalogEntry[]
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return this.getState();
		}
		const liveProjectIds = new Set(projects.map(project =>
			project.projectId
		));
		const projectFolders = projects.flatMap(project =>
			project.folderUris.map(folderUri => ({
				projectId: project.projectId,
				folderUri: URI.revive(folderUri),
			}))
		);
		const projectIdsByPath = new Map(projectFolders.map(folder => [
			this.toPathKey(folder.folderUri.fsPath),
			folder.projectId,
		]));
		this.projectCatalogSnapshot = {
			generation: (this.projectCatalogSnapshot?.generation ?? 0) + 1,
			liveProjectIds,
			projectIdsByPath,
		};
		let changed = false;
		for (const instance of this.instancesById.values()) {
			const claimedProjectId = projectIdsByPath.get(
				this.toPathKey(instance.worktreePath)
			);
			if (claimedProjectId) {
				changed ||= instance.projectId !== claimedProjectId ||
					instance.retainedWorkbenchId !== undefined;
				instance.projectId = claimedProjectId;
				instance.retainedWorkbenchId = undefined;
				continue;
			}
			if (
				!isHostedWorkspaceRestorable(instance) ||
				!instance.projectId ||
				liveProjectIds.has(instance.projectId)
			) {
				continue;
			}

			const retained = this.retainedWorkbenches.retain(
				URI.file(instance.worktreePath),
				'loaded',
				instance.lastActiveAt
			);
			instance.projectId = undefined;
			instance.retainedWorkbenchId = retained.id;
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
		return this.getState();
	}

	async promoteRetainedWorkbenchProjectFolders(
		windowId: number,
		projectFolders: readonly IHucodeProjectFolderPromotion[]
	): Promise<IHucodeHostedWorkspaceState> {
		await this.initialization;
		if (windowId !== this.windowId) {
			return this.getState();
		}
		const revivedProjectFolders = projectFolders.map(folder => ({
			projectId: folder.projectId,
			folderUri: URI.revive(folder.folderUri),
		}));
		this.recordProjectFolderPromotions(revivedProjectFolders);
		if (this.applyProjectFolderPromotions(revivedProjectFolders)) {
			this.emitState();
		}
		return this.getState();
	}

	private applyProjectFolderPromotions(projectFolders: readonly {
		readonly projectId: string;
		readonly folderUri: URI;
	}[]): boolean {
		let changed = false;
		for (const projectFolder of projectFolders) {
			const instance = this.getInstanceByPath(
				projectFolder.folderUri.fsPath
			);
			if (instance) {
				changed ||= instance.projectId !== projectFolder.projectId ||
					instance.retainedWorkbenchId !== undefined;
				instance.projectId = projectFolder.projectId;
				instance.retainedWorkbenchId = undefined;
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
				this.toPathKey(projectFolder.folderUri.fsPath),
				projectFolder.projectId
			);
		}
		this.projectCatalogSnapshot = {
			generation: (current?.generation ?? 0) + 1,
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
			this.toPathKey(worktreePath)
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

		await this.deferStateEmission(
			() => this.unloadAndRemoveInstance(instance, 'unload')
		);
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

		const result = await this.runCommandInInstance(
			instance,
			request.id,
			request.args ?? []
		);
		if (result !== COMMAND_DELIVERY_UNKNOWN) {
			return result;
		}

		if (!HUCODE_OMNI_CLIPBOARD_COMMANDS.has(request.id)) {
			return false;
		}
		// A timed-out request may still execute in the child after this point.
		// Treat clipboard delivery as consumed: retrying copy/cut locally can
		// duplicate a destructive cut. The tradeoff is that an actually lost
		// request leaves the clipboard operation unapplied.
		this.logService.warn(
			`[hucode] Hosted clipboard command ${request.id} timed out; ` +
			'delivery is unconfirmed, so it will not be retried locally.'
		);
		return true;
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

		this.reloadInstance(instance);
	}

	private reloadInstance(instance: IHostedIframeInstance): void {
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
		if (windowId !== this.windowId) {
			return;
		}

		// Page teardown must not wait forever for a slow remote folder stat.
		// Restore checks cancellation after every asynchronous preflight, so
		// no iframe can be attached after this shutdown snapshots its batch.
		this.initializationCancelled = true;
		if (this.shutdownPromise) {
			await this.shutdownPromise;
			return;
		}

		const shutdown = this.runWindowWorkspaceShutdown();
		this.shutdownPromise = shutdown;
		let failed = false;
		try {
			await shutdown;
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			// Complete teardown keeps the settled promise and frozen restore
			// snapshot. Recovery or a failed task makes a later request start
			// a fresh batch, including when persistence failed or no live
			// workbench survived the task failure.
			if (
				(failed || !this.shuttingDown) &&
				this.shutdownPromise === shutdown
			) {
				this.shutdownPromise = undefined;
			}
		}
	}

	private async runWindowWorkspaceShutdown(): Promise<void> {
		// Teardown must not rewrite the resident set used for the next startup.
		this.shuttingDown = true;
		const batch = [...this.instancesById.values()];
		let taskFailure: { readonly error: unknown } | undefined;
		let reconciliationFailure: { readonly error: unknown } | undefined;
		let recoveryFailure: { readonly error: unknown } | undefined;
		try {
			await this.deferStateEmission(async () => {
				const results = await Promise.allSettled(batch.map(instance =>
					this.unloadAndRemoveInstance(instance, 'shutdown')
				));
				const rejected = results.find(
					(result): result is PromiseRejectedResult =>
						result.status === 'rejected'
				);
				if (rejected) {
					taskFailure = { error: rejected.reason };
				}

				const survivors = [...this.instancesById.values()];
				if (survivors.length === 0) {
					return;
				}

				try {
					this.reconcileRetainedShutdownBatch(batch, survivors);
					if (!this.getAvailableActiveInstance()) {
						const next = getMostRecentHostedWorkspace(survivors);
						if (next) {
							this.activateInstance(next);
						}
					}
				} catch (error) {
					reconciliationFailure = { error };
				} finally {
					// A retained workbench means page teardown did not finish.
					// Resume persistence once with the coherent surviving set,
					// then allow a later shutdown request to start a fresh batch.
					this.shuttingDown = false;
					this.emitState();
				}
			});
		} catch (error) {
			recoveryFailure = { error };
		}

		if (taskFailure) {
			throw taskFailure.error;
		}
		if (reconciliationFailure) {
			throw reconciliationFailure.error;
		}
		if (recoveryFailure) {
			throw recoveryFailure.error;
		}
	}

	private reconcileRetainedShutdownBatch(
		batch: readonly IHostedIframeInstance[],
		survivors: readonly IHostedIframeInstance[]
	): void {
		const batchRetainedIds = new Set(batch.flatMap(instance =>
			instance.retainedWorkbenchId
				? [instance.retainedWorkbenchId]
				: []
		));
		const survivorRetainedIds = new Set(survivors.flatMap(instance =>
			instance.retainedWorkbenchId &&
				isHostedWorkspaceRestorable(instance)
				? [instance.retainedWorkbenchId]
				: []
		));
		for (const retainedId of batchRetainedIds) {
			if (!survivorRetainedIds.has(retainedId)) {
				this.retainedWorkbenches.update(retainedId, {
					desiredState: 'unloaded',
				});
			}
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
				// A workbench that announces nothing predates the two-phase
				// unload handshake.
				instance.protocolVersion = message.protocolVersion ?? 1;
				instance.hostedShellProtocolVersion =
					message.hostedShellProtocolVersion;
				instance.hostedShellCapabilities =
					message.hostedShellCapabilities;
				this.connectInstance(instance);
				void this.notifyHostedWorkspaceReady(
					this.windowId,
					message.instanceId
				);
				break;
			case HucodeOmniWebChildMessageType.Focus:
				instance.focused = message.focused && instance.visible;
				if (instance.focused) {
					if (this.activeInstanceId === instance.instanceId) {
						this.emitState();
					} else {
						this.activateInstance(instance);
					}
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
		instance.connectionGeneration++;

		const disposables = new DisposableStore();
		const channel = this.browser.createMessageChannel();
		const client = disposables.add(new MessagePortClient(
			channel.port1,
			`hucodeOmniWebShell:${instance.instanceId}`
		));
		const negotiatedCapabilities =
			negotiateHucodeHostedShellCapabilities(
				instance.hostedShellProtocolVersion,
				instance.hostedShellCapabilities
			);
		if (negotiatedCapabilities) {
			client.registerChannel(
				HUCODE_HOSTED_SHELL_CHANNEL,
				ProxyChannel.fromService(
					this.createHostedConnectionFacade(instance),
					disposables
				)
			);
		} else if (instance.hostedShellProtocolVersion === undefined) {
			// One-generation compatibility for cached children predating the
			// typed hosted capability. It retains the old wire shape but remains
			// bound to this connection's authoritative instance.
			client.registerChannel(
				HUCODE_OMNI_WEB_SHELL_CHANNEL,
				ProxyChannel.fromService(
					this.createLegacyHostedConnectionFacade(instance),
					disposables
				)
			);
		}
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
			hostedShellProtocolVersion: negotiatedCapabilities
				? HUCODE_HOSTED_SHELL_PROTOCOL_VERSION
				: instance.hostedShellProtocolVersion === undefined
					? undefined
					: 0,
			hostedShellCapabilities: negotiatedCapabilities,
		}, channel.port2);
	}

	/** Builds the shared least-authority facade for a current web connection. */
	private createHostedConnectionFacade(instance: IHostedIframeInstance) {
		const binding: IHucodeHostedShellBinding = {
			windowId: this.windowId,
			instanceId: instance.instanceId,
			connectionGeneration: instance.connectionGeneration,
		};
		const delegate: IHucodeHostedShellDelegate = {
			onDidChangeState: Event.map(
				this.onDidChangeWindowState,
				() => this.getHostedAuthorityState(instance)
			),
			getState: async () => {
				await this.initialization;
				return this.getHostedAuthorityState(instance);
			},
			notifyReady: async current => {
				await this.initialization;
				if (!this.isCurrentHostedBinding(instance, current) ||
					!isHostedWorkspaceAvailable(instance)) {
					return;
				}
				this.hostedWorkspaces.markInstanceReady(instance);
				this.emitState();
			},
			closeSelf: async current => {
				await this.initialization;
				if (!this.isCurrentHostedBinding(instance, current)) {
					return false;
				}
				return this.deferStateEmission(() =>
					this.unloadAndRemoveInstance(
						instance,
						'unload',
						current.connectionGeneration
					)
				);
			},
			reopenSelfInNormalWindow: async current => {
				await this.initialization;
				if (!this.isCurrentHostedBinding(instance, current)) {
					return false;
				}
				return reopenHucodeHostedWorkspaceInNormalWindow({
					getState: () => this.getState(),
					closeWorkspace: async targetInstanceId => {
						if (targetInstanceId !== current.instanceId ||
							!this.isCurrentHostedBinding(instance, current)) {
							return this.getState();
						}
						await this.deferStateEmission(() =>
							this.unloadAndRemoveInstance(
								instance,
								'unload',
								current.connectionGeneration
							)
						);
						return this.getState();
					},
					focusNormalWindowByPath: worktreePath =>
						this.focusNormalWindowByPath(worktreePath),
					openNormalWindow: worktreePath => {
						this.browser.open(this.toNormalWorkbenchUrl(worktreePath));
					},
				}, current.instanceId);
			},
			reloadSelf: async current => {
				if (!this.isCurrentHostedBinding(instance, current)) {
					return false;
				}
				this.reloadInstance(instance);
				return true;
			},
			focusSelf: async current => {
				if (!this.isCurrentHostedBinding(instance, current) ||
					!isHostedWorkspaceAvailable(instance)) {
					return false;
				}
				this.activateInstance(instance);
				this.focusIframe(instance);
				return true;
			},
			focusShell: async current => {
				if (!this.isBoundInstanceActiveVisible(instance, current)) {
					return false;
				}
				await this.focusShell(current.windowId);
				return true;
			},
			requestShellAction: async (current, action) => {
				if (!this.isBoundInstanceActiveVisible(instance, current)) {
					return false;
				}
				await this.commandService.executeCommand(
					getHucodeHostedShellActionCommandId(action)
				);
				return true;
			},
			navigateToFolder: (current, request, authorization) =>
				this.navigateToFolderFromHosted(
					instance,
					current,
					request,
					authorization
				),
			triggerPasteInSelf: async () => false,
			captureSelfScreenshot: async () => undefined,
		};
		return createBoundHucodeHostedShellFacade(binding, delegate);
	}

	private getHostedAuthorityState(
		instance: IHostedIframeInstance
	): IHucodeHostedShellAuthorityState {
		const state = this.getState();
		return {
			connectionGeneration: instance.connectionGeneration,
			disposed: this.instancesById.get(instance.instanceId) !== instance ||
				!instance.connection,
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

	private isCurrentHostedBinding(
		instance: IHostedIframeInstance,
		binding: IHucodeHostedShellBinding
	): boolean {
		return binding.windowId === this.windowId &&
			binding.instanceId === instance.instanceId &&
			binding.connectionGeneration === instance.connectionGeneration &&
			this.instancesById.get(instance.instanceId) === instance &&
			!!instance.connection;
	}

	private isBoundInstanceActiveVisible(
		instance: IHostedIframeInstance,
		binding: IHucodeHostedShellBinding
	): boolean {
		return this.isCurrentHostedBinding(instance, binding) &&
			this.activeInstanceId === instance.instanceId &&
			instance.visible &&
			isHostedWorkspaceAvailable(instance);
	}

	/**
	 * Creates the only shell operations callable over one hosted workbench's
	 * connection. Legacy wire signatures are retained, but caller-supplied
	 * window and instance identifiers are ignored in favour of the identities
	 * established by the trusted MessagePort handshake.
	 */
	private createLegacyHostedConnectionFacade(
		instance: IHostedIframeInstance
	): IHucodeHostedWebShellConnectionFacade {
		const hosted = this.createHostedConnectionFacade(instance);
		const toLegacyState = (
			state: IHucodeHostedShellState
		): IHucodeHostedWorkspaceState => ({
			activeInstanceId: state.available && state.active
				? instance.instanceId
				: undefined,
			projectsSidebarVisible: state.projectsSidebarVisible,
			projectSwitcherCanGoBack: state.projectSwitcherCanGoBack,
			projectSwitcherCanGoForward: state.projectSwitcherCanGoForward,
			instances: state.available ? [{
				instanceId: instance.instanceId,
				worktreePath: '',
				state: state.lifecycleState ?? 'loading',
				visible: state.visible,
				focused: false,
			}] : [],
		});
		const getLegacyState = async () => toLegacyState(await hosted.getState());
		const onDidChangeWindowState = Event.map(
			hosted.onDidChangeState,
			state => ({
				windowId: this.windowId,
				state: toLegacyState(state),
			})
		);
		return {
			onDidChangeWindowState,
			getWindowState: async _windowId => getLegacyState(),
			openAndFocusWorkspace: async (_windowId, worktreePath, _projectId) => {
				await hosted.navigateToFolder({
					folderUri: URI.file(worktreePath).toJSON(),
				});
				return getLegacyState();
			},
			closeWorkspace: async _windowId => {
				await hosted.closeSelf();
				return getLegacyState();
			},
			reopenWorkspaceInNormalWindow: async _windowId =>
				await hosted.reopenSelfInNormalWindow() ===
				HucodeHostedShellOperationOutcome.Accepted,
			notifyHostedWorkspaceReady: async _windowId => {
				await hosted.notifyReady();
			},
			focusWorkspace: async _windowId => { await hosted.focusSelf(); },
			focusShell: async _windowId => { await hosted.focusShell(); },
			runActionInShell: async (_windowId, request) => {
				const action = getHucodeHostedShellAction(request.id);
				if (!action) {
					this.logService.warn(
						'[hucode] Rejected hosted shell action for ' +
						`window ${this.windowId}, instance ${instance.instanceId}: ` +
						'unsupported command id ' +
						`${formatHucodeHostedShellActionCommandIdForLog(request.id)}.`
					);
					return false;
				}
				return await hosted.requestShellAction(action) ===
					HucodeHostedShellOperationOutcome.Accepted;
			},
			reloadWorkspace: async _windowId => { await hosted.reloadSelf(); },
		};
	}

	private disposeConnection(instance: IHostedIframeInstance): void {
		const connection = instance.connection;
		if (!connection) {
			return;
		}

		if (
			instance.timedOutLegacyUnload?.workbench === connection.workbench
		) {
			instance.timedOutLegacyUnload = undefined;
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
		if (!persisted || this.initializationCancelled) {
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
			...persisted.residentWorkspaces.filter(entry => !!entry.projectId),
			...retainedCandidates,
		]);
		if (this.initializationCancelled) {
			return;
		}
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
				connectionGeneration: 0,
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
			if (this.initializationCancelled) {
				break;
			}
			let exists: boolean;
			try {
				exists = await this.folderAccess.exists(candidate.worktreePath);
			} catch {
				continue;
			}
			if (this.initializationCancelled) {
				break;
			}
			if (exists) {
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
					desiredState: 'unloaded',
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
			lifecycleGeneration: 0,
			connectionGeneration: 0,
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
		if (wasActive && !this.shuttingDown) {
			const next = getMostRecentHostedWorkspace(this.instancesById.values());
			if (next) {
				this.activateInstance(next);
				return;
			}
		}
		this.emitState();
	}

	/**
	 * Unloads a hosted workbench and removes it once removal is certain.
	 *
	 * Concurrent requests for the same workbench share one handshake and one
	 * outcome. The commit sits between the shell's checks and the removal, so
	 * without sharing two callers both pass the checks, both remove, the
	 * workbench is asked to shut down twice, and each caller then applies its
	 * own follow-up to a workbench the other has already disposed of
	 * differently. The disposition each caller wants is merged here and
	 * applied once, by the handshake that owns the claim.
	 */
	private unloadAndRemoveInstance(
		instance: IHostedIframeInstance,
		disposition: HostedUnloadDisposition,
		expectedConnectionGeneration?: number
	): Promise<boolean> {
		if (expectedConnectionGeneration !== undefined &&
			(instance.connectionGeneration !== expectedConnectionGeneration ||
				this.instancesById.get(instance.instanceId) !== instance)) {
			return Promise.resolve(false);
		}
		const pending = instance.pendingUnload;
		if (pending) {
			instance.pendingUnloadDisposition = strongestUnloadDisposition(
				instance.pendingUnloadDisposition ?? disposition,
				disposition
			);
			return pending;
		}

		const timedOutLegacyUnload = instance.timedOutLegacyUnload;
		if (timedOutLegacyUnload) {
			if (
				this.instancesById.get(instance.instanceId) === instance &&
				instance.connection?.workbench ===
				timedOutLegacyUnload.workbench
			) {
				timedOutLegacyUnload.disposition =
					strongestUnloadDisposition(
						timedOutLegacyUnload.disposition,
						disposition
					);
				return Promise.resolve(false);
			}
			instance.timedOutLegacyUnload = undefined;
		}

		instance.pendingUnloadDisposition = disposition;
		const unload = this.runUnloadHandshake(
			instance,
			expectedConnectionGeneration
		).finally(() => {
			// A failed handshake still holds the claim, and a later request
			// may already have replaced it.
			if (instance.pendingUnload === unload) {
				instance.pendingUnload = undefined;
			}
		});
		instance.pendingUnload = unload;
		return unload;
	}

	private async runUnloadHandshake(
		instance: IHostedIframeInstance,
		expectedConnectionGeneration?: number
	): Promise<boolean> {
		const lifecycleGeneration = instance.lifecycleGeneration;
		// Pending-ready workbenches close directly: a never-connected iframe
		// cannot hold unsaved state and is not listening yet, and a reloading
		// one is already running its own beforeunload handling, where a
		// handshake would only hang until the unload timeout.
		//
		// Both phases address the connection captured here. A workbench that
		// connects part-way through would be asked to commit an unload it
		// never prepared, and would rightly refuse.
		const workbench = isHostedWorkspaceAvailable(instance) &&
			!isHostedWorkspacePendingReady(instance)
			? instance.connection?.workbench
			: undefined;
		// A workbench from before the handshake was split shuts itself down
		// during preparation, so for those there is nothing left to decide
		// afterwards and nothing to commit. Skipping the supersession
		// re-check also gives up the guarantee it provides the disposition
		// step — that this instance still owns its path — which is why the
		// disposition is applied under its own identity check below.
		const singlePhase = (instance.protocolVersion ?? 1) <
			HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION;
		if (
			workbench &&
			await this.prepareUnload(
				instance,
				workbench,
				singlePhase
			) !== 'ready'
		) {
			return false;
		}
		if (expectedConnectionGeneration !== undefined &&
			(instance.connectionGeneration !== expectedConnectionGeneration ||
				this.instancesById.get(instance.instanceId) !== instance)) {
			return false;
		}
		if (
			!singlePhase && (
				instance.lifecycleGeneration !== lifecycleGeneration ||
				this.getInstanceByPath(instance.worktreePath) !== instance
			)
		) {
			return false;
		}
		// The workbench shuts down only now that its removal is decided: a
		// preparation the shell abandons above leaves it running.
		if (
			workbench && !singlePhase &&
			await this.commitUnload(instance, workbench) === 'refused'
		) {
			return false;
		}
		if (expectedConnectionGeneration !== undefined &&
			(instance.connectionGeneration !== expectedConnectionGeneration ||
				this.instancesById.get(instance.instanceId) !== instance)) {
			return false;
		}

		return this.removeUnloadedInstance(instance);
	}

	/**
	 * Removes an instance whose workbench has irreversibly shut down and applies
	 * the strongest disposition requested for it.
	 */
	private removeUnloadedInstance(
		instance: IHostedIframeInstance,
		disposition =
			instance.pendingUnloadDisposition ?? 'shutdown'
	): boolean {
		// Applying the disposition needs an identity this old the checks above
		// no longer vouch for: a replacement created during the handshake owns
		// the path now, and parking a dormant placeholder over it would evict a
		// live workbench from the model while leaving its iframe running.
		const ownsPath =
			this.getInstanceByPath(instance.worktreePath) === instance;
		// Release the claim before removing rather than in the `finally` that
		// follows the handshake: a request arriving from here on gets its own
		// handshake. Once a current-protocol workbench commits, removal is
		// unconditional; the workbench has already shut down irreversibly.
		instance.pendingUnload = undefined;
		this.removeInstance(instance);
		if (ownsPath) {
			this.applyUnloadDisposition(instance, disposition);
		}
		return true;
	}

	/**
	 * Applies the outcome the callers of a completed unload agreed on. Every
	 * follow-up lives here so that a workbench several requests raced for
	 * ends up in one state rather than the last writer's.
	 */
	private applyUnloadDisposition(
		instance: IHostedIframeInstance,
		disposition: HostedUnloadDisposition
	): void {
		if (disposition === 'shutdown') {
			return; // teardown must not rewrite the restore set
		}

		if (disposition === 'suspend') {
			this.hostedWorkspaces.addInstance({
				instanceId: generateUuid(),
				projectId: instance.projectId,
				retainedWorkbenchId: instance.retainedWorkbenchId,
				worktreePath: instance.worktreePath,
				state: 'dormant',
				visible: false,
				focused: false,
				lastActiveAt: instance.lastActiveAt,
				lifecycleGeneration: 0,
				connectionGeneration: 0,
			});
			this.emitState();
			return;
		}

		this.applyTerminalUnloadDisposition(
			instance.worktreePath,
			disposition,
			instance.retainedWorkbenchId
		);
	}

	/**
	 * Applies a disposition that ends a workbench rather than parking it. No
	 * dormant placeholder may survive one: it would offer to restore a
	 * workbench the user closed or dismissed.
	 */
	private applyTerminalUnloadDisposition(
		worktreePath: string,
		disposition: 'unload' | 'dismiss',
		retainedWorkbenchId?: string
	): void {
		const dormant = this.getInstanceByPath(worktreePath);
		if (dormant?.state === 'dormant') {
			this.hostedWorkspaces.removeInstance(dormant);
		}
		// Resolve the record the caller meant, not whichever record holds
		// this path by the time the handshake ends. A record that has since
		// been dismissed leaves nothing to act on, which is the safe answer;
		// acting by path would instead unload or dismiss a record somebody
		// created for the same folder in the meantime.
		const retained = retainedWorkbenchId
			? this.retainedWorkbenches.getById(retainedWorkbenchId)
			: this.retainedWorkbenches.getByUri(URI.file(worktreePath));
		if (retained) {
			if (disposition === 'dismiss') {
				this.retainedWorkbenches.dismiss(retained.id);
			} else {
				this.retainedWorkbenches.update(retained.id, {
					desiredState: 'unloaded',
				});
			}
		}
		this.emitState();
	}

	/**
	 * Asks a hosted workbench to prepare for unload. Preparation leaves the
	 * lifecycle service untouched, so the shell can still abandon the unload
	 * afterwards, and it fails closed: a veto, a lost answer or a silent
	 * workbench all keep the workbench. Its shutdown listeners do run, and
	 * not all of them are idempotent.
	 */
	private async prepareUnload(
		instance: IHostedIframeInstance,
		workbench: IHucodeOmniWebWorkbenchClient,
		singlePhase: boolean,
	): Promise<HostedUnloadResult> {
		const answer = (
			singlePhase
				? workbench.prepareUnload()
				: workbench.prepareUnloadForCommit()
		).then(
			ready => ready ? 'ready' as const : 'vetoed' as const,
			() => 'prepare-failed' as const
		);
		const result = await this.raceTimeout(
			answer,
			WebHucodeShellController.PREPARE_UNLOAD_TIMEOUT_MS
		);
		if (result === REQUEST_TIMEOUT) {
			const legacyClaim: ITimedOutLegacyUnloadClaim | undefined =
				singlePhase
					? {
						workbench,
						disposition:
							instance.pendingUnloadDisposition ?? 'shutdown',
					}
					: undefined;
			if (legacyClaim) {
				instance.timedOutLegacyUnload = legacyClaim;
			}
			this.logService.warn(
				'[hucode] Hosted workbench did not answer the unload ' +
				`preparation for ${instance.worktreePath}; keeping it.`
			);
			// The preparation cannot be called off, and the workbench being
			// kept is not the untouched one the caller assumes: its shutdown
			// listeners run whenever the answer finally arrives.
			void answer.then(late => {
				this.logService.warn(
					'[hucode] Hosted workbench unload preparation for ' +
					`${instance.worktreePath} completed (${late}) after the ` +
					'shell gave up on it; its shutdown listeners have run.'
				);
				// Protocol-v1 preparation is the shutdown itself. Once it
				// eventually succeeds, keeping the iframe would retain a dead
				// workbench. Only the exact connection asked to shut down may
				// remove the instance; a reloaded child must survive an old
				// connection's delayed answer. Do not release a newer unload
				// claim that may now own the same instance.
				if (
					legacyClaim &&
					instance.timedOutLegacyUnload === legacyClaim
				) {
					instance.timedOutLegacyUnload = undefined;
					if (
						late === 'ready' &&
						this.instancesById.get(instance.instanceId) ===
						instance &&
						instance.connection?.workbench === workbench
					) {
						this.removeUnloadedInstance(
							instance,
							legacyClaim.disposition
						);
					}
				}
			});
			return 'prepare-timeout';
		}
		if (result === 'vetoed') {
			this.logService.info(
				'[hucode] Hosted workbench vetoed its unload for ' +
				`${instance.worktreePath}.`
			);
		}
		if (result === 'prepare-failed') {
			this.logService.warn(
				'[hucode] Hosted workbench unload preparation failed for ' +
				`${instance.worktreePath}; keeping it.`
			);
		}
		return result;
	}

	/**
	 * Commits a prepared unload. This phase fails open: the request is
	 * irreversible and already sent, and preparation established that the
	 * workbench had no objection, so a silence or a lost reply says nothing
	 * about whether the workbench survived. Keeping its iframe would leave
	 * the page holding a workbench that has already gone. An answered
	 * refusal is different — the workbench is still running and said so.
	 */
	private async commitUnload(
		instance: IHostedIframeInstance,
		workbench: IHucodeOmniWebWorkbenchClient
	): Promise<HostedUnloadResult> {
		const result = await this.raceTimeout(
			workbench.commitUnload().then(
				committed => committed ? 'ready' as const : 'refused' as const,
				() => 'commit-failed' as const
			),
			WebHucodeShellController.COMMIT_UNLOAD_TIMEOUT_MS
		);
		if (result === REQUEST_TIMEOUT) {
			this.logService.warn(
				'[hucode] Hosted workbench did not confirm its unload commit ' +
				`for ${instance.worktreePath}; removing it anyway.`
			);
			return 'commit-timeout';
		}
		if (result === 'commit-failed') {
			this.logService.warn(
				'[hucode] Hosted workbench lost its connection during the ' +
				`unload commit for ${instance.worktreePath}; removing it ` +
				'anyway.'
			);
		}
		return result;
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
	): Promise<boolean | typeof COMMAND_DELIVERY_UNKNOWN> {
		const workbench = instance.connection?.workbench;
		if (!workbench) {
			return false;
		}

		const result = await this.raceTimeout(
			workbench.runCommand(commandId, args).catch(() => false),
			WebHucodeShellController.COMMAND_TIMEOUT_MS
		);
		if (result === REQUEST_TIMEOUT) {
			return COMMAND_DELIVERY_UNKNOWN;
		}

		if (instance.state === 'loading') {
			if (result) {
				this.hostedWorkspaces.markInstanceReady(instance);
			} else {
				instance.state = 'crashed';
				const retained = this.retainedWorkbenches.getByUri(
					URI.file(instance.worktreePath)
				);
				if (retained) {
					this.retainedWorkbenches.update(
						retained.id,
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
		@ILogService logService: ILogService,
		@IProjectManagerService projectManagerService: IProjectManagerService,
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
			remoteAuthority: environmentService.remoteAuthority,
		}, commandService, hostSurfaceService, undefined,
			new StorageServiceWebHucodeShellPersistence(storageService),
			configurationService.getValue<HucodeHostedWorkbenchRestorePolicy>(
				HUCODE_OMNI_RESTORE_HOSTED_WORKBENCHES_SETTING
			) ?? 'active', createWebHucodeShellFolderAccess(
				environmentService.remoteAuthority,
				resource => fileService.stat(resource)
			), logService, projectManagerService);
	}
}

registerSingleton(
	IHucodeShellService,
	WebHucodeShellService,
	InstantiationType.Delayed
);
