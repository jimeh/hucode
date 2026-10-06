/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { DeferredPromise } from '../../base/common/async.js';
import { Emitter, Event } from '../../base/common/event.js';
import { getServerProductSegment } from '../../base/common/network.js';
import { generateUuid } from '../../base/common/uuid.js';
import {
	Disposable,
	DisposableStore,
	IDisposable,
	MutableDisposable,
	toDisposable,
} from
	'../../base/common/lifecycle.js';
import { Client as MessagePortClient } from
	'../../base/parts/ipc/browser/ipc.mp.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { createDecorator } from
	'../../platform/instantiation/common/instantiation.js';
import { registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from
	'../../platform/instantiation/common/descriptors.js';
import {
	HUCODE_HOSTED_SHELL_CAPABILITIES,
	HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
	HucodeHostedShellCapability,
	negotiateHucodeHostedShellCapabilities,
} from '../../platform/window/common/hucodeHostedShellService.js';
import {
	HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION,
	HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
	getHucodeOmniWebBuildCompatibility,
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
	isHucodeOmniWebConnectionBootstrapMetadata,
	IHucodeOmniWebPortMessage,
	IHucodeOmniWebWorkbenchClient,
} from '../../platform/window/common/hucodeOmniWebMessages.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';
import product from '../../platform/product/common/product.js';
import { showHucodeWebVersionMismatchBlocker } from
	'./hucodeWebVersionMismatch.js';

export const IHucodeHostedOmniWebConnectionService =
	createDecorator<IHucodeHostedOmniWebConnectionService>(
		'hucodeHostedOmniWebConnectionService'
	);

/**
 * Established IPC connection from a hosted iframe workbench to its shell.
 */
export interface IHucodeHostedOmniWebConnection {
	readonly ipcClient: MessagePortClient;
	readonly hostedShellProtocolVersion: number;
	readonly hostedShellCapabilities: readonly HucodeHostedShellCapability[];
}

/**
 * Owns the hosted iframe side of the Omni web shell handshake: it receives
 * the shell's MessagePort, exposes the resulting IPC connection, and relays
 * the window-message bootstrap signals.
 */
export interface IHucodeHostedOmniWebConnectionService {
	readonly _serviceBrand: undefined;

	/**
	 * Whether this workbench runs as a hosted Omni iframe.
	 */
	readonly isHosted: boolean;
	readonly onDidConnect: Event<IHucodeHostedOmniWebConnection>;

	/**
	 * Resolves with the first connection, or `undefined` outside a hosted iframe
	 * and when the initial wait expires. Later connections are reported through
	 * {@link onDidConnect}.
	 */
	whenConnected(): Promise<IHucodeHostedOmniWebConnection | undefined>;

	/**
	 * Registers the workbench-side service callable by the shell.
	 */
	registerWorkbenchClient(client: IHucodeOmniWebWorkbenchClient): void;

	/**
	 * Signals the shell that this hosted workbench has restored.
	 */
	signalReady(): void;

	/**
	 * Relays window focus changes to the shell.
	 */
	notifyFocus(focused: boolean): void;
}

/**
 * Browser window seams used by the hosted connection service, injectable so
 * the parent-source trust checks are unit-testable.
 */
export interface IHostedOmniWebConnectionBrowserAdapter {
	readonly origin: string;
	hasParent(): boolean;
	isParentSource(source: MessageEventSource | null): boolean;
	postToParent(message: object): void;
	addMessageListener(listener: (event: MessageEvent) => void): IDisposable;
	setTimeout(
		callback: () => void,
		delay: number
	): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
	showVersionMismatch(): void;
}

/** Retry and deadline values for the hosted iframe bootstrap. */
export interface IHostedOmniWebConnectionOptions {
	readonly initialConnectionTimeoutMs: number;
	readonly readyRetryDelaysMs: readonly number[];
}

const defaultConnectionOptions: IHostedOmniWebConnectionOptions = {
	initialConnectionTimeoutMs: 5_000,
	readyRetryDelaysMs: [250, 500, 1_000, 2_000],
};

function createMainWindowConnectionAdapter():
	IHostedOmniWebConnectionBrowserAdapter {
	return {
		get origin() {
			return mainWindow.location.origin;
		},
		hasParent: () => mainWindow.parent !== mainWindow,
		isParentSource: source => source === mainWindow.parent,
		postToParent: message =>
			mainWindow.parent.postMessage(message, mainWindow.location.origin),
		addMessageListener: listener => {
			mainWindow.addEventListener('message', listener);
			return toDisposable(() =>
				mainWindow.removeEventListener('message', listener));
		},
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: handle => clearTimeout(handle),
		showVersionMismatch: () => showHucodeWebVersionMismatchBlocker(),
	};
}

type IHostedOmniWebConnectionEnvironment = Pick<
	IWorkbenchEnvironmentService,
	'_serviceBrand' | 'isHostedOmniWorkspace' | 'hostedInstanceId'
>;

export class HucodeHostedOmniWebConnectionService extends Disposable
	implements IHucodeHostedOmniWebConnectionService {

	declare readonly _serviceBrand: undefined;

	private readonly instanceId: string | undefined;
	private readonly initialConnection =
		new DeferredPromise<IHucodeHostedOmniWebConnection | undefined>();
	private readonly connectionDisposables =
		this._register(new MutableDisposable<DisposableStore>());
	private connection: IHucodeHostedOmniWebConnection | undefined;
	private workbenchClient: IHucodeOmniWebWorkbenchClient | undefined;
	private readonly bootstrapId = generateUuid();
	private readyStarted = false;
	private connectionAttempt = 0;
	private readyRetryIndex = 0;
	private readonly readyRetryDelaysMs: readonly number[];
	private readyRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private initialConnectionTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private versionMismatchBlocked = false;
	private readonly buildIdentity = getServerProductSegment(product);
	private readonly _onDidConnect =
		this._register(new Emitter<IHucodeHostedOmniWebConnection>());
	readonly onDidConnect = this._onDidConnect.event;

	constructor(
		private readonly browser: IHostedOmniWebConnectionBrowserAdapter,
		@IWorkbenchEnvironmentService
		environmentService: IHostedOmniWebConnectionEnvironment,
		private readonly options = defaultConnectionOptions,
	) {
		super();
		this.readyRetryDelaysMs = options.readyRetryDelaysMs.filter(delay =>
			Number.isFinite(delay) && delay > 0
		);

		this.instanceId = environmentService.isHostedOmniWorkspace &&
			this.browser.hasParent()
			? environmentService.hostedInstanceId
			: undefined;
		if (!this.instanceId) {
			void this.initialConnection.complete(undefined);
			return;
		}
		this._register({ dispose: () => this.shutdown() });
		this.initialConnectionTimer = this.browser.setTimeout(() => {
			this.initialConnectionTimer = undefined;
			void this.initialConnection.complete(undefined);
		}, this.options.initialConnectionTimeoutMs);

		this._register(this.browser.addMessageListener(event => {
			if (
				event.origin !== this.browser.origin ||
				!this.browser.isParentSource(event.source) ||
				!(event.ports[0] instanceof MessagePort)
			) {
				return;
			}
			const port = event.ports[0];
			if (!isPortMessageTarget(event.data, this.instanceId!)) {
				return;
			}
			if (this.versionMismatchBlocked) {
				port.close();
				return;
			}
			if (!isPortMessageWireShape(event.data, this.instanceId!)) {
				port.close();
				return;
			}
			const bootstrap = event.data.connectionBootstrap;
			if (bootstrap.id !== this.bootstrapId ||
				bootstrap.attempt !== this.connectionAttempt) {
				port.close();
				return;
			}
			const compatibility = getHucodeOmniWebBuildCompatibility(
				event.data,
				this.buildIdentity
			);
			if (compatibility === 'mismatch') {
				port.close();
				this.blockForVersionMismatch();
				return;
			}
			if (compatibility !== 'match') {
				port.close();
				return;
			}
			const hostedShellCapabilities =
				negotiateHucodeHostedShellCapabilities(
					event.data.hostedShellProtocolVersion,
					event.data.hostedShellCapabilities
				);
			if (!hostedShellCapabilities) {
				port.close();
				return;
			}
			if (this.connection) {
				port.close();
				return;
			}

			this.clearReadyRetryTimer();
			const disposables = new DisposableStore();
			const ipcClient = disposables.add(new MessagePortClient(
				port,
				`hucodeHostedOmniWorkbench:${this.instanceId}`
			));
			if (this.workbenchClient) {
				this.registerWorkbenchClientOnConnection(
					ipcClient,
					this.workbenchClient,
					disposables
				);
			}
			const connection = this.connection = {
				ipcClient,
				hostedShellProtocolVersion:
					event.data.hostedShellProtocolVersion,
				hostedShellCapabilities,
			};
			this.connectionDisposables.value = disposables;
			this.clearInitialConnectionTimer();
			void this.initialConnection.complete(connection);
			this._onDidConnect.fire(connection);
		}));
	}

	get isHosted(): boolean {
		return !!this.instanceId;
	}

	whenConnected(): Promise<IHucodeHostedOmniWebConnection | undefined> {
		return this.initialConnection.p;
	}

	registerWorkbenchClient(client: IHucodeOmniWebWorkbenchClient): void {
		this.workbenchClient = client;
		if (this.connection) {
			this.registerWorkbenchClientOnConnection(
				this.connection.ipcClient,
				client,
				this.connectionDisposables.value!
			);
		}
	}

	signalReady(): void {
		if (!this.instanceId || this.connection || this.readyStarted ||
			this.versionMismatchBlocked) {
			return;
		}
		this.readyStarted = true;
		this.sendReadyAttempt();
	}

	private sendReadyAttempt(): void {
		if (this.disposed || this.connection) {
			return;
		}
		this.connectionAttempt++;
		this.postToShell({
			type: HucodeOmniWebChildMessageType.Ready,
			instanceId: this.instanceId,
			connectionBootstrap: {
				id: this.bootstrapId,
				attempt: this.connectionAttempt,
			},
			buildIdentity: this.buildIdentity,
			protocolVersion: HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION,
			hostedShellProtocolVersion:
				HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			hostedShellCapabilities: HUCODE_HOSTED_SHELL_CAPABILITIES,
		});
		const delays = this.readyRetryDelaysMs;
		if (delays.length === 0) {
			return;
		}
		// Keep retrying at the final capped delay so a late shell can recover.
		const delay = delays[Math.min(
			this.readyRetryIndex,
			delays.length - 1
		)];
		this.readyRetryIndex++;
		this.readyRetryTimer = this.browser.setTimeout(() => {
			this.readyRetryTimer = undefined;
			this.sendReadyAttempt();
		}, delay);
	}

	notifyFocus(focused: boolean): void {
		this.postToShell({
			type: HucodeOmniWebChildMessageType.Focus,
			instanceId: this.instanceId,
			focused,
		});
	}

	private postToShell(message: object): void {
		if (!this.instanceId) {
			return;
		}

		this.browser.postToParent(message);
	}

	private registerWorkbenchClientOnConnection(
		ipcClient: MessagePortClient,
		client: IHucodeOmniWebWorkbenchClient,
		disposables: DisposableStore
	): void {
		ipcClient.registerChannel(
			HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
			ProxyChannel.fromService(client, disposables)
		);
	}

	private clearReadyRetryTimer(): void {
		if (this.readyRetryTimer !== undefined) {
			this.browser.clearTimeout(this.readyRetryTimer);
			this.readyRetryTimer = undefined;
		}
	}

	private clearInitialConnectionTimer(): void {
		if (this.initialConnectionTimer !== undefined) {
			this.browser.clearTimeout(this.initialConnectionTimer);
			this.initialConnectionTimer = undefined;
		}
	}

	private blockForVersionMismatch(): void {
		if (this.versionMismatchBlocked) {
			return;
		}
		this.versionMismatchBlocked = true;
		this.clearReadyRetryTimer();
		this.clearInitialConnectionTimer();
		void this.initialConnection.complete(undefined);
		this.browser.showVersionMismatch();
	}

	private shutdown(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearReadyRetryTimer();
		this.clearInitialConnectionTimer();
		this.connection = undefined;
		this.connectionDisposables.clear();
		void this.initialConnection.complete(undefined);
	}
}

function isPortMessageTarget(value: unknown, instanceId: string): boolean {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as {
		readonly type?: unknown;
		readonly instanceId?: unknown;
	};
	return message.type === HucodeOmniWebParentMessageType.Port &&
		message.instanceId === instanceId;
}

/**
 * Validates required port-message fields while leaving the optional build
 * identity untyped for compatibility classification.
 */
function isPortMessageWireShape(
	value: unknown,
	instanceId: string
): value is Omit<IHucodeOmniWebPortMessage, 'buildIdentity'> & {
	readonly buildIdentity?: unknown;
} {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const message = value as {
		readonly type?: unknown;
		readonly instanceId?: unknown;
		readonly connectionBootstrap?: unknown;
		readonly buildIdentity?: unknown;
		readonly hostedShellProtocolVersion?: unknown;
		readonly hostedShellCapabilities?: unknown;
	};
	return message.type === HucodeOmniWebParentMessageType.Port &&
		message.instanceId === instanceId &&
		isHucodeOmniWebConnectionBootstrapMetadata(message) &&
		typeof message.hostedShellProtocolVersion === 'number' &&
		Array.isArray(message.hostedShellCapabilities);
}

registerSingleton(
	IHucodeHostedOmniWebConnectionService,
	new SyncDescriptor(
		HucodeHostedOmniWebConnectionService,
		[createMainWindowConnectionAdapter()],
		true
	)
);
