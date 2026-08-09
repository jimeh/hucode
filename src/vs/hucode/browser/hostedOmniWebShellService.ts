/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from
	'../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import {
	createHucodeHostedShellClient,
	HUCODE_HOSTED_SHELL_CHANNEL,
	HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedNavigationRequest,
	IHucodeHostedNavigationSnapshot,
	IHucodeHostedReadyResult,
	IHucodeHostedShellService,
	IHucodeHostedShellState,
	negotiateHucodeHostedShellCapabilities,
	withHucodeHostedShellCachedAvailability,
} from '../../platform/window/common/hucodeHostedShellService.js';
import { IRectangle } from '../../platform/window/common/window.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';
import {
	IHucodeHostedOmniWebConnection,
	IHucodeHostedOmniWebConnectionService,
} from './hostedOmniWebConnection.js';

/**
 * Hosted iframe client for the narrow shell capability.
 *
 * Protocol and capability metadata are mandatory. A client whose server was
 * updated underneath it must reload the whole page before reconnecting.
 */
export class HostedOmniWebShellService extends Disposable
	implements IHucodeHostedShellService {

	declare readonly _serviceBrand: undefined;

	private shell: IHucodeHostedShellService | undefined;
	private readonly shellDisposables =
		this._register(new MutableDisposable<DisposableStore>());
	private state = HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
	private available = false;
	private readyRequested = false;
	private disposed = false;
	private readonly _onDidChangeState =
		this._register(new Emitter<IHucodeHostedShellState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		@IHucodeHostedOmniWebConnectionService
		connectionService: IHucodeHostedOmniWebConnectionService,
		@IWorkbenchEnvironmentService
		environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		withHucodeHostedShellCachedAvailability(
			this,
			() => this.available
		);
		this._register({
			dispose: () => {
				this.disposed = true;
				this.available = false;
				this.shell = undefined;
				this.shellDisposables.clear();
			},
		});

		const instanceId = environmentService.hostedInstanceId;
		if (!connectionService.isHosted || !instanceId) {
			return;
		}

		this._register(connectionService.onDidConnect(connection => {
			this.installConnection(connection);
		}));
		void connectionService.whenConnected().then(connection => {
			if (connection) {
				this.installConnection(connection);
			}
		});
	}

	private installConnection(
		connection: IHucodeHostedOmniWebConnection
	): void {
		if (this.disposed || this.shell) {
			return;
		}
		const capabilities = negotiateHucodeHostedShellCapabilities(
			connection.hostedShellProtocolVersion,
			connection.hostedShellCapabilities
		);
		const shell = capabilities
			? createHucodeHostedShellClient(connection.ipcClient.getChannel(
				HUCODE_HOSTED_SHELL_CHANNEL
			), capabilities)
			: createUnavailableHostedShellClient();
		this.available = !!capabilities;
		this.shell = shell;
		const disposables = new DisposableStore();
		disposables.add(shell.onDidChangeState(state => {
			this.state = state;
			this._onDidChangeState.fire(state);
		}));
		this.shellDisposables.value = disposables;
		if (this.readyRequested && this.available) {
			void shell.notifyReady().catch(() => undefined);
		}
	}

	private async withShell<T>(
		fallback: () => T,
		run: (shell: IHucodeHostedShellService) => Promise<T>
	): Promise<T> {
		return this.shell ? run(this.shell) : fallback();
	}

	async getState(): Promise<IHucodeHostedShellState> {
		return this.withShell(() => this.state, async shell => {
			this.state = await shell.getState();
			return this.state;
		});
	}

	getNavigationSnapshot(): Promise<
		IHucodeHostedNavigationSnapshot | undefined
	> {
		return this.withShell(
			() => undefined,
			shell => shell.getNavigationSnapshot?.() ?? Promise.resolve(undefined)
		);
	}

	notifyReady(): Promise<IHucodeHostedReadyResult> {
		this.readyRequested = true;
		return this.withShell(
			() => ({ outcome: HucodeHostedShellOperationOutcome.Unavailable }),
			shell => shell.notifyReady()
		);
	}

	closeSelf() {
		return this.runOperation(shell => shell.closeSelf());
	}

	reopenSelfInNormalWindow() {
		return this.runOperation(shell => shell.reopenSelfInNormalWindow());
	}

	reloadSelf() {
		return this.runOperation(shell => shell.reloadSelf());
	}

	focusSelf() {
		return this.runOperation(shell => shell.focusSelf());
	}

	focusShell() {
		return this.runOperation(shell => shell.focusShell());
	}

	requestShellAction(action: Parameters<
		IHucodeHostedShellService['requestShellAction']
	>[0]) {
		return this.runOperation(shell => shell.requestShellAction(action));
	}

	navigateToFolder(request: IHucodeHostedNavigationRequest) {
		return this.runOperation(shell => shell.navigateToFolder(request));
	}

	triggerPasteInSelf() {
		return this.runOperation(shell => shell.triggerPasteInSelf());
	}

	captureSelfScreenshot(
		rect?: IRectangle,
		quality?: number
	): Promise<VSBuffer | undefined> {
		return this.withShell(
			() => undefined,
			shell => shell.captureSelfScreenshot(rect, quality)
		);
	}

	private runOperation(
		run: (
			shell: IHucodeHostedShellService
		) => Promise<HucodeHostedShellOperationOutcome>
	): Promise<HucodeHostedShellOperationOutcome> {
		return this.withShell(
			() => HucodeHostedShellOperationOutcome.Unavailable,
			run
		);
	}
}

function createUnavailableHostedShellClient(): IHucodeHostedShellService {
	const unavailable = () => Promise.resolve(
		HucodeHostedShellOperationOutcome.Unavailable
	);
	return {
		_serviceBrand: undefined,
		onDidChangeState: Event.None,
		getState: async () => HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
		getNavigationSnapshot: async () => undefined,
		notifyReady: async () => ({
			outcome: HucodeHostedShellOperationOutcome.Unavailable,
		}),
		closeSelf: unavailable,
		reopenSelfInNormalWindow: unavailable,
		reloadSelf: unavailable,
		focusSelf: unavailable,
		focusShell: unavailable,
		requestShellAction: unavailable,
		navigateToFolder: unavailable,
		triggerPasteInSelf: unavailable,
		captureSelfScreenshot: async () => undefined,
	};
}

registerSingleton(
	IHucodeHostedShellService,
	HostedOmniWebShellService,
	InstantiationType.Delayed
);
