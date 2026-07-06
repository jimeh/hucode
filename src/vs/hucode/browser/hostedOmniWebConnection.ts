/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { DeferredPromise } from '../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from
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
	HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
	IHucodeOmniWebPortMessage,
	IHucodeOmniWebWorkbenchClient,
} from '../../platform/window/common/hucodeOmniWebMessages.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';

export const IHucodeHostedOmniWebConnectionService =
	createDecorator<IHucodeHostedOmniWebConnectionService>(
		'hucodeHostedOmniWebConnectionService'
	);

/**
 * Established IPC connection from a hosted iframe workbench to its shell.
 */
export interface IHucodeHostedOmniWebConnection {
	readonly ipcClient: MessagePortClient;
	readonly shellWindowId: number;
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

	/**
	 * Resolves once the shell has transferred its IPC port. Never resolves
	 * outside a hosted iframe.
	 */
	whenConnected(): Promise<IHucodeHostedOmniWebConnection>;

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
}

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
	private readonly connection =
		new DeferredPromise<IHucodeHostedOmniWebConnection>();

	constructor(
		private readonly browser: IHostedOmniWebConnectionBrowserAdapter,
		@IWorkbenchEnvironmentService
		environmentService: IHostedOmniWebConnectionEnvironment,
	) {
		super();

		this.instanceId = environmentService.isHostedOmniWorkspace &&
			this.browser.hasParent()
			? environmentService.hostedInstanceId
			: undefined;
		if (!this.instanceId) {
			return;
		}

		this._register(this.browser.addMessageListener(event => {
			if (
				event.origin !== this.browser.origin ||
				!this.browser.isParentSource(event.source) ||
				!isPortMessage(event.data, this.instanceId!) ||
				!(event.ports[0] instanceof MessagePort)
			) {
				return;
			}

			const ipcClient = this._register(new MessagePortClient(
				event.ports[0],
				`hucodeHostedOmniWorkbench:${this.instanceId}`
			));
			void this.connection.complete({
				ipcClient,
				shellWindowId: event.data.windowId,
			});
		}));
	}

	get isHosted(): boolean {
		return !!this.instanceId;
	}

	whenConnected(): Promise<IHucodeHostedOmniWebConnection> {
		return this.connection.p;
	}

	registerWorkbenchClient(client: IHucodeOmniWebWorkbenchClient): void {
		const disposables = this._register(new DisposableStore());
		void this.connection.p.then(connection => {
			connection.ipcClient.registerChannel(
				HUCODE_OMNI_WEB_WORKBENCH_CHANNEL,
				ProxyChannel.fromService(client, disposables)
			);
		});
	}

	signalReady(): void {
		this.postToShell({
			type: HucodeOmniWebChildMessageType.Ready,
			instanceId: this.instanceId,
		});
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
}

function isPortMessage(
	value: unknown,
	instanceId: string
): value is IHucodeOmniWebPortMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const message = value as {
		readonly type?: unknown;
		readonly instanceId?: unknown;
		readonly windowId?: unknown;
	};
	return message.type === HucodeOmniWebParentMessageType.Port &&
		message.instanceId === instanceId &&
		typeof message.windowId === 'number';
}

registerSingleton(
	IHucodeHostedOmniWebConnectionService,
	new SyncDescriptor(
		HucodeHostedOmniWebConnectionService,
		[createMainWindowConnectionAdapter()],
		true
	)
);
