/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../base/common/async.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import {
	Disposable,
	DisposableStore,
	isDisposable,
} from '../../base/common/lifecycle.js';
import { Client as MessagePortClient } from
	'../../base/parts/ipc/common/ipc.mp.js';
import { acquirePort } from '../../base/parts/ipc/electron-browser/ipc.mp.js';
import { registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from
	'../../platform/instantiation/common/descriptors.js';
import {
	createHucodeHostedShellClient,
	HUCODE_HOSTED_SHELL_CHANNEL,
	HUCODE_HOSTED_SHELL_PORT_REQUEST_CHANNEL,
	HUCODE_HOSTED_SHELL_PORT_RESPONSE_CHANNEL,
	HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedNavigationRequest,
	IHucodeHostedReadyResult,
	IHucodeHostedShellService,
	IHucodeHostedShellState,
} from '../../platform/window/common/hucodeHostedShellService.js';
import { IRectangle } from '../../platform/window/common/window.js';
import { INativeWorkbenchEnvironmentService } from
	'../../workbench/services/environment/electron-browser/environmentService.js';
import { observeHucodeHostedShellState } from
	'../browser/hostedShellStateObserver.js';

export type DesktopHostedShellConnector = () =>
	Promise<IHucodeHostedShellService | undefined>;

/**
 * Desktop hosted-workbench client for the narrow, main-process-bound shell
 * capability. Connection is deliberately deferred and never falls back to the
 * broad legacy shell channel.
 */
export class DesktopHostedShellServiceAdapter extends Disposable
	implements IHucodeHostedShellService {

	declare readonly _serviceBrand: undefined;

	private readonly connection =
		new DeferredPromise<IHucodeHostedShellService | undefined>();
	private state = HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
	private readonly _onDidChangeState =
		this._register(new Emitter<IHucodeHostedShellState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		connect: DesktopHostedShellConnector,
		@INativeWorkbenchEnvironmentService
		environmentService: INativeWorkbenchEnvironmentService
	) {
		super();

		if (!environmentService.isHostedOmniWorkspace ||
			!environmentService.hostedInstanceId) {
			void this.connection.complete(undefined);
			return;
		}

		let disposed = false;
		this._register({
			dispose: () => {
				disposed = true;
				void this.connection.complete(undefined);
			},
		});
		void connect().then(shell => {
			if (disposed) {
				if (isDisposable(shell)) {
					shell.dispose();
				}
				return;
			}
			if (shell) {
				if (isDisposable(shell)) {
					this._register(shell);
				}
				this._register(observeHucodeHostedShellState(shell, state => {
					this.state = state;
					this._onDidChangeState.fire(state);
				}));
			}
			void this.connection.complete(shell);
		}, () => {
			void this.connection.complete(undefined);
		});
	}

	private async withShell<T>(
		fallback: () => T,
		run: (shell: IHucodeHostedShellService) => Promise<T>
	): Promise<T> {
		const shell = await this.connection.p;
		return shell ? run(shell) : fallback();
	}

	getState(): Promise<IHucodeHostedShellState> {
		return this.withShell(() => this.state, async shell => {
			this.state = await shell.getState();
			return this.state;
		});
	}

	notifyReady(): Promise<IHucodeHostedReadyResult> {
		return this.withShell(
			() => ({ outcome: HucodeHostedShellOperationOutcome.Unavailable }),
			shell => shell.notifyReady()
		);
	}

	closeSelf() { return this.runOperation(shell => shell.closeSelf()); }
	reopenSelfInNormalWindow() {
		return this.runOperation(shell => shell.reopenSelfInNormalWindow());
	}
	reloadSelf() { return this.runOperation(shell => shell.reloadSelf()); }
	focusSelf() { return this.runOperation(shell => shell.focusSelf()); }
	focusShell() { return this.runOperation(shell => shell.focusShell()); }
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

async function connectDesktopHostedShell():
	Promise<IHucodeHostedShellService> {
	const port = await acquirePort(
		HUCODE_HOSTED_SHELL_PORT_REQUEST_CHANNEL,
		HUCODE_HOSTED_SHELL_PORT_RESPONSE_CHANNEL
	);
	const disposables = new DisposableStore();
	const client = disposables.add(new MessagePortClient(
		port,
		'hucodeHostedDesktopWorkbench'
	));
	const shell = createHucodeHostedShellClient(
		client.getChannel(HUCODE_HOSTED_SHELL_CHANNEL)
	);
	return Object.assign(shell, {
		dispose: () => disposables.dispose(),
	});
}

registerSingleton(
	IHucodeHostedShellService,
	new SyncDescriptor(
		DesktopHostedShellServiceAdapter,
		[connectDesktopHostedShell],
		true
	)
);
