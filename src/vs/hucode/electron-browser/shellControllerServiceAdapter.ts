/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../base/common/async.js';
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
	'../../base/parts/ipc/electron-browser/ipc.mp.js';
import { SyncDescriptor } from
	'../../platform/instantiation/common/descriptors.js';
import { registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import { INativeWorkbenchEnvironmentService } from
	'../../workbench/services/environment/electron-browser/environmentService.js';
import {
	createHucodeShellControllerClient,
	HUCODE_SHELL_CONTROLLER_CHANNEL,
	HUCODE_SHELL_CONTROLLER_PORT_REQUEST_CHANNEL,
	HUCODE_SHELL_CONTROLLER_PORT_RESPONSE_CHANNEL,
	HucodeShellControllerUnavailableError,
	IHucodeShellControllerService,
} from '../../platform/window/common/hucodeShellControllerService.js';

/** One cancellable attempt to acquire the privileged controller capability. */
export interface IDesktopShellControllerConnectionAttempt extends IDisposable {
	readonly promise: Promise<IHucodeShellControllerService | undefined>;
}

export type DesktopShellControllerConnector = () =>
	IDesktopShellControllerConnectionAttempt;

/** Bounds privileged connection acquisition and shutdown joining. */
interface IDesktopShellControllerAdapterOptions {
	/** Overall budget for calls waiting on the initial connection. */
	readonly connectionTimeoutMs?: number;
	/** Budget for each individual port acquisition attempt. */
	readonly acquisitionTimeoutMs?: number;
	/** Budget for one dispatched controller operation. */
	readonly operationTimeoutMs?: number;
	readonly shutdownConnectionTimeoutMs?: number;
	readonly retryDelaysMs?: readonly number[];
}

const defaultRetryDelaysMs = [100, 250, 500, 1_000, 2_000];

/** Desktop client for the privileged capability bound to one Omni shell. */
export class DesktopShellControllerServiceAdapter extends Disposable
	implements IHucodeShellControllerService {

	declare readonly _serviceBrand: undefined;
	readonly supportsWorkspaceScreenshotOverlay: boolean;

	private readonly initialConnection =
		new DeferredPromise<IHucodeShellControllerService | undefined>();
	private shell: IHucodeShellControllerService | undefined;
	private readonly shellDisposables =
		this._register(new MutableDisposable<DisposableStore>());
	private connectionAttempt:
		IDesktopShellControllerConnectionAttempt | undefined;
	private acquisitionTimer: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private initialConnectionTimer: ReturnType<typeof setTimeout> | undefined;
	private retryIndex = 0;
	private disposed = false;
	private readonly acquisitionTimeoutMs: number;
	private readonly operationTimeoutMs: number;
	private readonly shutdownConnectionTimeoutMs: number;
	private readonly retryDelaysMs: readonly number[];
	private readonly _onDidChangeState = this._register(new Emitter<
		Awaited<ReturnType<IHucodeShellControllerService['getState']>>
	>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		private readonly connect: DesktopShellControllerConnector,
		options: IDesktopShellControllerAdapterOptions = {},
		@INativeWorkbenchEnvironmentService
		environmentService: INativeWorkbenchEnvironmentService
	) {
		super();
		this.acquisitionTimeoutMs = options.acquisitionTimeoutMs ?? 5_000;
		this.operationTimeoutMs = options.operationTimeoutMs ?? 15_000;
		this.shutdownConnectionTimeoutMs =
			options.shutdownConnectionTimeoutMs ?? 1000;
		this.retryDelaysMs = (options.retryDelaysMs ?? defaultRetryDelaysMs)
			.filter(delay => Number.isFinite(delay) && delay >= 0);
		this.supportsWorkspaceScreenshotOverlay =
			!!environmentService.isOmniShellWindow;
		if (!environmentService.isOmniShellWindow) {
			void this.initialConnection.complete(undefined);
			return;
		}

		this._register({ dispose: () => this.shutdown() });
		this.initialConnectionTimer = setTimeout(() => {
			this.initialConnectionTimer = undefined;
			void this.initialConnection.complete(undefined);
		}, options.connectionTimeoutMs ?? 10_000);
		this.beginConnectionAttempt();
	}

	private async withShell<T>(
		run: (shell: IHucodeShellControllerService) => Promise<T>
	): Promise<T> {
		const shell = this.shell ?? await this.initialConnection.p;
		if (!shell || this.shell !== shell) {
			throw new HucodeShellControllerUnavailableError();
		}
		try {
			return await this.invokeBounded(shell, () => run(shell));
		} catch (error) {
			this.invalidateConnection(shell);
			throw error;
		}
	}

	private beginConnectionAttempt(): void {
		if (this.disposed || this.shell || this.connectionAttempt) {
			return;
		}

		let attempt: IDesktopShellControllerConnectionAttempt;
		try {
			attempt = this.connect();
		} catch {
			this.scheduleRetry();
			return;
		}
		this.connectionAttempt = attempt;
		this.acquisitionTimer = setTimeout(() => {
			if (this.connectionAttempt !== attempt) {
				return;
			}
			this.connectionAttempt = undefined;
			this.acquisitionTimer = undefined;
			attempt.dispose();
			this.scheduleRetry();
		}, this.acquisitionTimeoutMs);

		void attempt.promise.then(shell => {
			this.finishConnectionAttempt(attempt, shell);
		}, () => {
			this.finishConnectionAttempt(attempt, undefined);
		});
	}

	private finishConnectionAttempt(
		attempt: IDesktopShellControllerConnectionAttempt,
		shell: IHucodeShellControllerService | undefined
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

	private installConnection(
		shell: IHucodeShellControllerService
	): void {
		const publishRecoveredState = this.initialConnection.isSettled;
		const disposables = new DisposableStore();
		if (isDisposable(shell)) {
			disposables.add(shell);
		}
		disposables.add(shell.onDidChangeState(state => {
			if (this.shell === shell) {
				this._onDidChangeState.fire(state);
			}
		}));
		this.shellDisposables.value = disposables;
		this.shell = shell;
		this.retryIndex = 0;
		this.clearInitialConnectionTimer();
		void this.initialConnection.complete(shell);
		if (publishRecoveredState) {
			void this.refreshState(shell);
		}
	}

	private async refreshState(
		shell: IHucodeShellControllerService
	): Promise<void> {
		try {
			const state = await this.invokeBounded(shell, () => shell.getState());
			if (this.shell === shell) {
				this._onDidChangeState.fire(state);
			}
		} catch {
			this.invalidateConnection(shell);
		}
	}

	private async invokeBounded<T>(
		shell: IHucodeShellControllerService,
		operation: () => Promise<T>
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				Promise.resolve().then(operation).then(
					value => ({ kind: 'value' as const, value }),
					error => ({ kind: 'failure' as const, error })
				),
				new Promise<{ readonly kind: 'timeout' }>(resolve => {
					timer = setTimeout(
						() => resolve({ kind: 'timeout' }),
						this.operationTimeoutMs
					);
				}),
			]);
			if (result.kind === 'value' && this.shell === shell) {
				return result.value;
			}
			if (result.kind === 'failure') {
				throw result.error;
			}
			throw new HucodeShellControllerUnavailableError();
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}

	private invalidateConnection(
		shell: IHucodeShellControllerService
	): void {
		if (this.shell !== shell) {
			return;
		}
		this.shell = undefined;
		this.shellDisposables.clear();
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.disposed || this.shell || this.connectionAttempt ||
			this.retryTimer) {
			return;
		}
		const delay = this.retryDelaysMs.length === 0
			? 0
			: this.retryDelaysMs[Math.min(
				this.retryIndex,
				this.retryDelaysMs.length - 1
			)];
		this.retryIndex++;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.beginConnectionAttempt();
		}, delay);
	}

	private clearAcquisitionTimer(): void {
		if (this.acquisitionTimer !== undefined) {
			clearTimeout(this.acquisitionTimer);
			this.acquisitionTimer = undefined;
		}
	}

	private clearInitialConnectionTimer(): void {
		if (this.initialConnectionTimer !== undefined) {
			clearTimeout(this.initialConnectionTimer);
			this.initialConnectionTimer = undefined;
		}
	}

	private shutdown(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearAcquisitionTimer();
		this.clearInitialConnectionTimer();
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		this.connectionAttempt?.dispose();
		this.connectionAttempt = undefined;
		this.shell = undefined;
		this.shellDisposables.clear();
		void this.initialConnection.complete(undefined);
	}

	getState() { return this.withShell(shell => shell.getState()); }
	focusHostedWorkspaceByPath(path: string, projectId?: string) {
		return this.withShell(shell =>
			shell.focusHostedWorkspaceByPath(path, projectId));
	}
	focusNormalWindowByPath(path: string) {
		return this.withShell(shell => shell.focusNormalWindowByPath(path));
	}
	openWorkspace(path: string, projectId?: string) {
		return this.withShell(shell => shell.openWorkspace(path, projectId));
	}
	openAndFocusWorkspace(path: string, projectId?: string) {
		return this.withShell(shell =>
			shell.openAndFocusWorkspace(path, projectId));
	}
	suspendWorkspace(instanceId: string) {
		return this.withShell(shell => shell.suspendWorkspace(instanceId));
	}
	retainAndOpenWorkbench(folderUri: Parameters<
		IHucodeShellControllerService['retainAndOpenWorkbench']
	>[0]) {
		return this.withShell(shell => shell.retainAndOpenWorkbench(folderUri));
	}
	unloadRetainedWorkbench(id: string) {
		return this.withShell(shell => shell.unloadRetainedWorkbench(id));
	}
	dismissRetainedWorkbench(id: string) {
		return this.withShell(shell => shell.dismissRetainedWorkbench(id));
	}
	reorderRetainedWorkbenches(ids: readonly string[]) {
		return this.withShell(shell => shell.reorderRetainedWorkbenches(ids));
	}
	setRetainedWorkbenchLabel(id: string, label: string | undefined) {
		return this.withShell(shell =>
			shell.setRetainedWorkbenchLabel(id, label));
	}
	reconcileRetainedWorkbenchesWithCompleteProjectCatalog(projects: Parameters<
		IHucodeShellControllerService[
		'reconcileRetainedWorkbenchesWithCompleteProjectCatalog'
		]
	>[0]) {
		return this.withShell(shell =>
			shell.reconcileRetainedWorkbenchesWithCompleteProjectCatalog(projects));
	}
	promoteRetainedWorkbenchProjectFolders(folders: Parameters<
		IHucodeShellControllerService['promoteRetainedWorkbenchProjectFolders']
	>[0]) {
		return this.withShell(shell =>
			shell.promoteRetainedWorkbenchProjectFolders(folders));
	}
	setHostedWorkbenchRestorePolicy(policy: Parameters<
		IHucodeShellControllerService['setHostedWorkbenchRestorePolicy']
	>[0]) {
		return this.withShell(shell =>
			shell.setHostedWorkbenchRestorePolicy(policy));
	}
	openFilesInWorkspace(path: string, request: Parameters<
		IHucodeShellControllerService['openFilesInWorkspace']
	>[1], projectId?: string) {
		return this.withShell(shell =>
			shell.openFilesInWorkspace(path, request, projectId));
	}
	openFilesInActiveWorkspace(request: Parameters<
		IHucodeShellControllerService['openFilesInActiveWorkspace']
	>[0]) {
		return this.withShell(shell => shell.openFilesInActiveWorkspace(request));
	}
	closeWorkspace(instanceId?: string) {
		return this.withShell(shell => shell.closeWorkspace(instanceId));
	}
	reopenWorkspaceInNormalWindow(instanceId: string) {
		return this.withShell(shell =>
			shell.reopenWorkspaceInNormalWindow(instanceId));
	}
	prepareWorkspaceForStandaloneOpen(request: Parameters<
		IHucodeShellControllerService['prepareWorkspaceForStandaloneOpen']
	>[0]) {
		return this.withShell(shell =>
			shell.prepareWorkspaceForStandaloneOpen(request));
	}
	focusWorkspace() { return this.withShell(shell => shell.focusWorkspace()); }
	focusShell() { return this.withShell(shell => shell.focusShell()); }
	setProjectsSidebarVisible(visible: boolean) {
		return this.withShell(shell => shell.setProjectsSidebarVisible(visible));
	}
	setProjectSwitcherNavigationState(back: boolean, forward: boolean) {
		return this.withShell(shell =>
			shell.setProjectSwitcherNavigationState(back, forward));
	}
	setProjectSwitcherSectionOrder(order: Parameters<
		IHucodeShellControllerService['setProjectSwitcherSectionOrder']
	>[0]) {
		return this.withShell(shell => shell.setProjectSwitcherSectionOrder(order));
	}
	runActionInWorkspace(request: Parameters<
		IHucodeShellControllerService['runActionInWorkspace']
	>[0]) {
		return this.withShell(shell => shell.runActionInWorkspace(request));
	}
	runKeybindingInWorkspace(request: Parameters<
		IHucodeShellControllerService['runKeybindingInWorkspace']
	>[0]) {
		return this.withShell(shell => shell.runKeybindingInWorkspace(request));
	}
	triggerPasteInWorkspace() {
		return this.withShell(shell => shell.triggerPasteInWorkspace());
	}
	reloadWorkspace() { return this.withShell(shell => shell.reloadWorkspace()); }
	toggleWorkspaceDevTools() {
		return this.withShell(shell => shell.toggleWorkspaceDevTools());
	}
	layoutWorkspace(bounds: Parameters<
		IHucodeShellControllerService['layoutWorkspace']
	>[0]) {
		return this.withShell(shell => shell.layoutWorkspace(bounds));
	}
	captureWorkspaceScreenshot(rect?: Parameters<
		IHucodeShellControllerService['captureWorkspaceScreenshot']
	>[0], quality?: number) {
		return this.withShell(shell =>
			shell.captureWorkspaceScreenshot(rect, quality));
	}
	setWorkspaceOverlayOcclusion(occluded: boolean) {
		return this.withShell(shell =>
			shell.setWorkspaceOverlayOcclusion(occluded));
	}
	async shutdownWindowWorkspaces(reason: Parameters<
		IHucodeShellControllerService['shutdownWindowWorkspaces']
	>[0]): Promise<void> {
		try {
			const shell = await raceTimeout(
				this.shell
					? Promise.resolve(this.shell)
					: this.initialConnection.p,
				this.shutdownConnectionTimeoutMs
			);
			if (!shell || this.shell !== shell) {
				return;
			}
			await raceTimeout(
				shell.shutdownWindowWorkspaces(reason),
				this.shutdownConnectionTimeoutMs
			);
		} catch {
			// A renderer teardown can dispose the port before shutdown joins settle.
		}
	}
}

/** Acquires the owner-bound privileged controller port for an Omni shell. */
export function connectDesktopShellController():
	IDesktopShellControllerConnectionAttempt {
	const acquisition = acquirePortOrUndefinedCancellable(
		HUCODE_SHELL_CONTROLLER_PORT_REQUEST_CHANNEL,
		HUCODE_SHELL_CONTROLLER_PORT_RESPONSE_CHANNEL
	);
	return {
		promise: acquisition.promise.then(port => {
			if (!port) {
				return undefined;
			}
			const disposables = new DisposableStore();
			const client = disposables.add(new MessagePortClient(
				port,
				'hucodeDesktopShellController'
			));
			const shell = createHucodeShellControllerClient(
				client.getChannel(HUCODE_SHELL_CONTROLLER_CHANNEL)
			);
			return Object.assign(shell, {
				dispose: () => disposables.dispose(),
			});
		}),
		dispose: () => acquisition.dispose(),
	};
}

registerSingleton(
	IHucodeShellControllerService,
	new SyncDescriptor(
		DesktopShellControllerServiceAdapter,
		[connectDesktopShellController, {}],
		true
	)
);
