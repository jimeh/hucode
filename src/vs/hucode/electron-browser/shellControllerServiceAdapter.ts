/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../base/common/async.js';
import { Emitter } from '../../base/common/event.js';
import {
	Disposable,
	DisposableStore,
	isDisposable,
} from '../../base/common/lifecycle.js';
import { Client as MessagePortClient } from
	'../../base/parts/ipc/common/ipc.mp.js';
import { acquirePortOrUndefined } from
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
	IHucodeShellControllerService,
} from '../../platform/window/common/hucodeShellControllerService.js';

export type DesktopShellControllerConnector = () =>
	Promise<IHucodeShellControllerService | undefined>;

/** Desktop client for the privileged capability bound to one Omni shell. */
export class DesktopShellControllerServiceAdapter extends Disposable
	implements IHucodeShellControllerService {

	declare readonly _serviceBrand: undefined;
	readonly supportsWorkspaceScreenshotOverlay: boolean;

	private readonly connection =
		new DeferredPromise<IHucodeShellControllerService | undefined>();
	private readonly _onDidChangeState = this._register(new Emitter<
		Awaited<ReturnType<IHucodeShellControllerService['getState']>>
	>());
	readonly onDidChangeState = this._onDidChangeState.event;

	constructor(
		connect: DesktopShellControllerConnector,
		@INativeWorkbenchEnvironmentService
		environmentService: INativeWorkbenchEnvironmentService
	) {
		super();
		this.supportsWorkspaceScreenshotOverlay =
			!!environmentService.isOmniShellWindow;
		if (!environmentService.isOmniShellWindow) {
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
				this._register(shell.onDidChangeState(state =>
					this._onDidChangeState.fire(state)
				));
			}
			void this.connection.complete(shell);
		}, () => void this.connection.complete(undefined));
	}

	private async withShell<T>(
		run: (shell: IHucodeShellControllerService) => Promise<T>
	): Promise<T> {
		const shell = await this.connection.p;
		if (!shell) {
			throw new Error('Desktop Omni shell capability is unavailable.');
		}
		return run(shell);
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
			await this.withShell(shell => shell.shutdownWindowWorkspaces(reason));
		} catch {
			// A renderer teardown can dispose the port before shutdown joins settle.
		}
	}
}

export async function connectDesktopShellController():
	Promise<IHucodeShellControllerService> {
	const port = await acquirePortOrUndefined(
		HUCODE_SHELL_CONTROLLER_PORT_REQUEST_CHANNEL,
		HUCODE_SHELL_CONTROLLER_PORT_RESPONSE_CHANNEL
	);
	if (!port) {
		throw new Error('Desktop Omni shell capability was denied.');
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
}

registerSingleton(
	IHucodeShellControllerService,
	new SyncDescriptor(
		DesktopShellControllerServiceAdapter,
		[connectDesktopShellController],
		true
	)
);
