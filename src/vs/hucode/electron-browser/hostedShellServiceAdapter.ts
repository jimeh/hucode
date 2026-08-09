/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { isCancellationError } from '../../base/common/errors.js';
import { Emitter } from '../../base/common/event.js';
import {
	Disposable,
	DisposableStore,
	IDisposable,
	isDisposable,
	MutableDisposable,
} from '../../base/common/lifecycle.js';
import { Client as MessagePortClient } from
	'../../base/parts/ipc/common/ipc.mp.js';
import { acquirePortOrUndefinedCancellable } from
	'./messagePortAcquisition.js';
import { registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from
	'../../platform/instantiation/common/descriptors.js';
import {
	areHucodeHostedShellStatesEqual,
	createHucodeHostedShellClient,
	HUCODE_HOSTED_SHELL_CHANNEL,
	HUCODE_HOSTED_SHELL_PORT_REQUEST_CHANNEL,
	HUCODE_HOSTED_SHELL_PORT_RESPONSE_CHANNEL,
	HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedNavigationRequest,
	IHucodeHostedNavigationSnapshot,
	IHucodeHostedReadyResult,
	IHucodeHostedShellService,
	IHucodeHostedShellState,
	withHucodeHostedShellCachedAvailability,
} from '../../platform/window/common/hucodeHostedShellService.js';
import { IRectangle } from '../../platform/window/common/window.js';
import { INativeWorkbenchEnvironmentService } from
	'../../workbench/services/environment/electron-browser/environmentService.js';

/** One cancellable attempt to acquire the desktop hosted capability. */
export interface IDesktopHostedShellConnectionAttempt extends IDisposable {
	readonly promise: Promise<IHucodeHostedShellService | undefined>;
}

export type DesktopHostedShellConnector = () =>
	IDesktopHostedShellConnectionAttempt;

/** Timing seams for deterministic connection-lifecycle tests. */
export interface IDesktopHostedShellConnectionOptions {
	readonly acquisitionTimeoutMs: number;
	readonly operationTimeoutMs: number;
	readonly retryDelaysMs: readonly number[];
	readonly setTimeout: (
		callback: () => void,
		delay: number
	) => ReturnType<typeof setTimeout>;
	readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const defaultConnectionOptions: IDesktopHostedShellConnectionOptions = {
	acquisitionTimeoutMs: 5_000,
	operationTimeoutMs: 15_000,
	retryDelaysMs: [100, 250, 500, 1_000, 2_000],
	setTimeout: (callback, delay) => setTimeout(callback, delay),
	clearTimeout: handle => clearTimeout(handle),
};

type DesktopHostedShellInvocationResult<T> =
	| { readonly kind: 'value'; readonly value: T }
	| { readonly kind: 'rejected' }
	| { readonly kind: 'unavailable' };

/**
 * Desktop hosted-workbench client for the narrow, main-process-bound shell
 * capability. Connection establishment and calls are bounded, recover through
 * reacquisition, and never fall back to the broad legacy shell channel.
 */
export class DesktopHostedShellServiceAdapter extends Disposable
	implements IHucodeHostedShellService {

	declare readonly _serviceBrand: undefined;

	private state = HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
	private shell: IHucodeHostedShellService | undefined;
	private readonly shellDisposables =
		this._register(new MutableDisposable<DisposableStore>());
	private connectionAttempt: IDesktopHostedShellConnectionAttempt | undefined;
	private acquisitionTimer: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryIndex = 0;
	private readyRequested = false;
	private disposed = false;
	private readonly _onDidChangeState =
		this._register(new Emitter<IHucodeHostedShellState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		private readonly connect: DesktopHostedShellConnector,
		@INativeWorkbenchEnvironmentService
		environmentService: INativeWorkbenchEnvironmentService,
		private readonly options = defaultConnectionOptions
	) {
		super();
		withHucodeHostedShellCachedAvailability(
			this,
			() => !!this.shell
		);
		this._register({ dispose: () => this.shutdown() });

		if (!environmentService.isHostedOmniWorkspace ||
			!environmentService.hostedInstanceId) {
			return;
		}

		this.beginConnectionAttempt();
	}

	private async withShell<T>(
		fallback: () => T,
		run: (shell: IHucodeHostedShellService) => Promise<T>
	): Promise<T> {
		const shell = this.shell;
		if (!shell) {
			return fallback();
		}
		const result = await this.invokeBounded(shell, () => run(shell));
		return result.kind === 'value' ? result.value : fallback();
	}

	async getState(): Promise<IHucodeHostedShellState> {
		const shell = this.shell;
		if (!shell) {
			return this.markUnavailable();
		}
		const result = await this.invokeBounded(shell, () => shell.getState());
		if (result.kind === 'value' && this.shell === shell) {
			this.updateState(result.value);
		}
		return this.state;
	}

	getNavigationSnapshot(): Promise<
		IHucodeHostedNavigationSnapshot | undefined
	> {
		return this.withShell(
			() => undefined,
			shell => shell.getNavigationSnapshot?.() ?? Promise.resolve(undefined)
		);
	}

	async notifyReady(): Promise<IHucodeHostedReadyResult> {
		this.readyRequested = true;
		const shell = this.shell;
		if (!shell) {
			return {
				outcome: HucodeHostedShellOperationOutcome.Unavailable,
			};
		}
		const result = await this.invokeBounded(
			shell,
			() => shell.notifyReady()
		);
		if (result.kind === 'rejected') {
			return {
				outcome: HucodeHostedShellOperationOutcome.Rejected,
			};
		}
		if (result.kind === 'unavailable') {
			return {
				outcome: HucodeHostedShellOperationOutcome.Unavailable,
			};
		}
		if (result.value.outcome ===
			HucodeHostedShellOperationOutcome.Stale) {
			this.invalidateConnection(shell);
		}
		return result.value;
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

	private async runOperation(
		run: (
			shell: IHucodeHostedShellService
		) => Promise<HucodeHostedShellOperationOutcome>
	): Promise<HucodeHostedShellOperationOutcome> {
		const shell = this.shell;
		if (!shell) {
			return HucodeHostedShellOperationOutcome.Unavailable;
		}
		const result = await this.invokeBounded(shell, () => run(shell));
		if (result.kind === 'rejected') {
			return HucodeHostedShellOperationOutcome.Rejected;
		}
		if (result.kind === 'unavailable') {
			return HucodeHostedShellOperationOutcome.Unavailable;
		}
		if (result.value === HucodeHostedShellOperationOutcome.Stale) {
			this.invalidateConnection(shell);
		}
		return result.value;
	}

	private markUnavailable(): IHucodeHostedShellState {
		if (!areHucodeHostedShellStatesEqual(
			this.state,
			HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE
		)) {
			this.state = HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE;
			this._onDidChangeState.fire(this.state);
		}
		return this.state;
	}

	private beginConnectionAttempt(): void {
		if (this.disposed || this.connectionAttempt || this.shell) {
			return;
		}

		let attempt: IDesktopHostedShellConnectionAttempt;
		try {
			attempt = this.connect();
		} catch {
			this.scheduleRetry();
			return;
		}
		this.connectionAttempt = attempt;
		this.acquisitionTimer = this.options.setTimeout(() => {
			if (this.connectionAttempt !== attempt) {
				return;
			}
			this.connectionAttempt = undefined;
			this.acquisitionTimer = undefined;
			attempt.dispose();
			this.scheduleRetry();
		}, this.options.acquisitionTimeoutMs);

		void attempt.promise.then(shell => {
			this.finishConnectionAttempt(attempt, shell);
		}, () => {
			this.finishConnectionAttempt(attempt, undefined);
		});
	}

	private finishConnectionAttempt(
		attempt: IDesktopHostedShellConnectionAttempt,
		shell: IHucodeHostedShellService | undefined
	): void {
		if (this.connectionAttempt !== attempt) {
			if (isDisposable(shell)) {
				shell.dispose();
			}
			return;
		}
		this.connectionAttempt = undefined;
		this.clearAcquisitionTimer();
		attempt.dispose();
		if (this.disposed || !shell) {
			if (isDisposable(shell)) {
				shell.dispose();
			}
			if (!this.disposed) {
				this.scheduleRetry();
			}
			return;
		}

		this.installConnection(shell);
	}

	private installConnection(shell: IHucodeHostedShellService): void {
		const disposables = new DisposableStore();
		if (isDisposable(shell)) {
			disposables.add(shell);
		}
		disposables.add(shell.onDidChangeState(state => {
			if (this.shell === shell) {
				this.updateState(state);
			}
		}));
		this.shellDisposables.value = disposables;
		this.shell = shell;
		this.retryIndex = 0;
		void this.refreshState(shell);
		if (this.readyRequested) {
			void this.retryReadiness(shell);
		}
	}

	private async refreshState(shell: IHucodeHostedShellService): Promise<void> {
		const result = await this.invokeBounded(shell, () => shell.getState());
		if (result.kind === 'value' && this.shell === shell) {
			this.updateState(result.value);
		}
	}

	private async retryReadiness(
		shell: IHucodeHostedShellService
	): Promise<void> {
		const result = await this.invokeBounded(shell, () => shell.notifyReady());
		if (result.kind === 'value' && result.value.outcome ===
			HucodeHostedShellOperationOutcome.Stale) {
			this.invalidateConnection(shell);
		}
	}

	private async invokeBounded<T>(
		shell: IHucodeHostedShellService,
		operation: () => Promise<T>
	): Promise<DesktopHostedShellInvocationResult<T>> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const operationResult = Promise.resolve().then(operation).then(
				value => ({ kind: 'value' as const, value }),
				error => ({ kind: 'failure' as const, error })
			);
			const timeoutResult = new Promise<{ readonly kind: 'timeout' }>(resolve => {
				timer = this.options.setTimeout(
					() => resolve({ kind: 'timeout' }),
					this.options.operationTimeoutMs
				);
			});
			const result = await Promise.race([operationResult, timeoutResult]);
			if (result.kind === 'value') {
				return result;
			}
			if (result.kind === 'failure') {
				// A non-cancellation rejection from the current port proves the
				// response path remains live.
				return this.shell === shell &&
					!isCancellationError(result.error)
					? { kind: 'rejected' }
					: { kind: 'unavailable' };
			}
			this.invalidateConnection(shell);
			return { kind: 'unavailable' };
		} finally {
			if (timer !== undefined) {
				this.options.clearTimeout(timer);
			}
		}
	}

	private invalidateConnection(shell: IHucodeHostedShellService): void {
		if (this.shell !== shell) {
			return;
		}
		this.shell = undefined;
		this.shellDisposables.clear();
		this.markUnavailable();
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.disposed || this.retryTimer || this.shell ||
			this.connectionAttempt) {
			return;
		}
		const delays = this.options.retryDelaysMs;
		const delay = delays.length === 0
			? 0
			: delays[Math.min(this.retryIndex, delays.length - 1)];
		this.retryIndex++;
		this.retryTimer = this.options.setTimeout(() => {
			this.retryTimer = undefined;
			this.beginConnectionAttempt();
		}, delay);
	}

	private updateState(state: IHucodeHostedShellState): void {
		if (areHucodeHostedShellStatesEqual(this.state, state)) {
			return;
		}
		this.state = state;
		this._onDidChangeState.fire(state);
	}

	private clearAcquisitionTimer(): void {
		if (this.acquisitionTimer !== undefined) {
			this.options.clearTimeout(this.acquisitionTimer);
			this.acquisitionTimer = undefined;
		}
	}

	private shutdown(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearAcquisitionTimer();
		if (this.retryTimer !== undefined) {
			this.options.clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		this.connectionAttempt?.dispose();
		this.connectionAttempt = undefined;
		this.shell = undefined;
		this.shellDisposables.clear();
		this.markUnavailable();
	}
}

function connectDesktopHostedShell(): IDesktopHostedShellConnectionAttempt {
	const acquisition = acquirePortOrUndefinedCancellable(
		HUCODE_HOSTED_SHELL_PORT_REQUEST_CHANNEL,
		HUCODE_HOSTED_SHELL_PORT_RESPONSE_CHANNEL
	);
	return {
		promise: acquisition.promise.then(port => {
			if (!port) {
				return undefined;
			}
			const disposables = new DisposableStore();
			const client = disposables.add(new MessagePortClient(
				port,
				'hucodeHostedDesktopWorkbench'
			));
			const shell = withHucodeHostedShellCachedAvailability(
				createHucodeHostedShellClient(
					client.getChannel(HUCODE_HOSTED_SHELL_CHANNEL)
				),
				() => true
			);
			return Object.assign(shell, {
				dispose: () => disposables.dispose(),
			});
		}),
		dispose: () => acquisition.dispose(),
	};
}

registerSingleton(
	IHucodeHostedShellService,
	new SyncDescriptor(
		DesktopHostedShellServiceAdapter,
		[connectDesktopHostedShell],
		true
	)
);
