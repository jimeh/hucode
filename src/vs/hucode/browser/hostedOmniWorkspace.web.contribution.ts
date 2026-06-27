/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { addDisposableListener } from '../../base/browser/dom.js';
import { coalesce } from '../../base/common/arrays.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { isObject } from '../../base/common/types.js';
import { URI } from '../../base/common/uri.js';
import { Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { ICommandActionTitle } from '../../platform/action/common/action.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { IResourceEditorInput } from
	'../../platform/editor/common/editor.js';
import { IFileService } from '../../platform/files/common/files.js';
import {
	IInstantiationService,
	ServicesAccessor,
} from '../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';
import {
	INativeOpenFileRequest,
} from '../../platform/window/common/window.js';
import { localize2 } from '../../nls.js';
import { whenEditorClosed } from '../../workbench/browser/editor.js';
import {
	IEditorPane,
	IResourceDiffEditorInput,
	IResourceMergeEditorInput,
	isResourceEditorInput,
	IUntitledTextResourceEditorInput,
	IUntypedEditorInput,
	pathsToEditors,
} from '../../workbench/common/editor.js';
import {
	CLOSE_WORKSPACE_COMMAND_ID,
	FOCUS_PROJECT_PANE_COMMAND_ID,
	FOCUS_WORKSPACE_COMMAND_ID,
	RELOAD_WORKSPACE_COMMAND_ID,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import { IsHostedOmniWorkspaceContext } from '../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { IEditorService } from
	'../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
import { ILifecycleService } from '../../workbench/services/lifecycle/common/lifecycle.js';
import {
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
} from '../../platform/window/common/hucodeOmniWebMessages.js';
import './hostedOmniWebShellService.js';
import './projectManager/webProjectManagerService.js';
import './hostedOmniWorkspace.contribution.js';

interface HucodeHostedOmniWebMessage {
	readonly type?: unknown;
	readonly instanceId?: unknown;
	readonly requestId?: unknown;
	readonly commandId?: unknown;
	readonly args?: unknown;
}

class HostedOmniWebBridgeContribution extends Disposable
	implements IWorkbenchContribution {

	static readonly ID = 'hucode.hostedOmniWebBridge';

	constructor(
		@IWorkbenchEnvironmentService
		environmentService: IWorkbenchEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const instanceId = environmentService.hostedInstanceId;
		if (!environmentService.isHostedOmniWorkspace || !instanceId) {
			return;
		}

		this.registerHostedShellCommands();
		this.postToShell({
			type: HucodeOmniWebChildMessageType.Ready,
			instanceId,
		});

		this._register(addDisposableListener(
			mainWindow,
			'focus',
			() => this.postFocus(instanceId, true)
		));
		this._register(addDisposableListener(
			mainWindow,
			'blur',
			() => this.postFocus(instanceId, false)
		));
		this._register(addDisposableListener(mainWindow, 'message', event => {
			if (event.origin !== mainWindow.location.origin) {
				return;
			}
			void this.handleMessage(instanceId, event.data);
		}));
	}

	private postFocus(instanceId: string, focused: boolean): void {
		this.postToShell({
			type: HucodeOmniWebChildMessageType.Focus,
			instanceId,
			focused,
		});
	}

	private async handleMessage(
		instanceId: string,
		rawMessage: unknown
	): Promise<void> {
		if (!isObject(rawMessage)) {
			return;
		}

		const message = rawMessage as HucodeHostedOmniWebMessage;
		if (message.instanceId !== instanceId) {
			return;
		}

		switch (message.type) {
			case HucodeOmniWebParentMessageType.BeforeUnload:
				await this.lifecycleService.shutdown();
				this.postToShell({
					type: HucodeOmniWebChildMessageType.UnloadReady,
					instanceId,
				});
				return;
			case HucodeOmniWebParentMessageType.RunCommand:
				await this.runCommand(instanceId, message);
				return;
		}
	}

	private async runCommand(
		instanceId: string,
		message: HucodeHostedOmniWebMessage
	): Promise<void> {
		if (typeof message.commandId !== 'string') {
			return;
		}

		try {
			const args = Array.isArray(message.args) ? message.args : [];
			const ok = message.commandId === 'vscode:openFiles'
				? await this.openFiles(args[0] as INativeOpenFileRequest)
				: await this.runWorkbenchCommand(message.commandId, args);
			this.postToShell({
				type: HucodeOmniWebChildMessageType.CommandResult,
				instanceId,
				requestId: typeof message.requestId === 'string'
					? message.requestId
					: undefined,
				commandId: message.commandId,
				ok,
			});
		} catch (error) {
			this.postToShell({
				type: HucodeOmniWebChildMessageType.CommandResult,
				instanceId,
				requestId: typeof message.requestId === 'string'
					? message.requestId
					: undefined,
				commandId: message.commandId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async runWorkbenchCommand(
		commandId: string,
		args: readonly unknown[]
	): Promise<boolean> {
		await this.commandService.executeCommand(commandId, ...args);
		return true;
	}

	private async openFiles(request: INativeOpenFileRequest): Promise<boolean> {
		if (!isNativeOpenFileRequest(request)) {
			return false;
		}

		const diffMode = !!(request.filesToDiff?.length === 2);
		const mergeMode = !!(request.filesToMerge?.length === 4);
		const paths = mergeMode
			? request.filesToMerge
			: diffMode
				? request.filesToDiff
				: request.filesToOpenOrCreate;
		const inputs = coalesce(await pathsToEditors(
			paths,
			this.fileService,
			this.logService
		));
		if (!inputs.length) {
			await this.deleteWaitMarker(request);
			return false;
		}

		const openedEditorPanes = await this.openResources(
			inputs,
			diffMode,
			mergeMode
		);
		if (request.filesToWait) {
			if (openedEditorPanes.length) {
				void this.trackClosedWaitFiles(
					URI.revive(request.filesToWait.waitMarkerFileUri),
					coalesce(request.filesToWait.paths.map(path =>
						URI.revive(path.fileUri)
					))
				);
			} else {
				await this.deleteWaitMarker(request);
			}
		}

		return openedEditorPanes.length > 0;
	}

	private async openResources(
		resources: Array<IResourceEditorInput | IUntitledTextResourceEditorInput>,
		diffMode: boolean,
		mergeMode: boolean
	): Promise<readonly IEditorPane[]> {
		const editors: IUntypedEditorInput[] = [];

		if (
			mergeMode &&
			isResourceEditorInput(resources[0]) &&
			isResourceEditorInput(resources[1]) &&
			isResourceEditorInput(resources[2]) &&
			isResourceEditorInput(resources[3])
		) {
			const mergeEditor: IResourceMergeEditorInput = {
				input1: { resource: resources[0].resource },
				input2: { resource: resources[1].resource },
				base: { resource: resources[2].resource },
				result: { resource: resources[3].resource },
				options: { pinned: true },
			};
			editors.push(mergeEditor);
		} else if (
			diffMode &&
			isResourceEditorInput(resources[0]) &&
			isResourceEditorInput(resources[1])
		) {
			const diffEditor: IResourceDiffEditorInput = {
				original: { resource: resources[0].resource },
				modified: { resource: resources[1].resource },
				options: { pinned: true },
			};
			editors.push(diffEditor);
		} else {
			editors.push(...resources);
		}

		return this.editorService.openEditors(
			editors,
			undefined,
			{ validateTrust: true }
		);
	}

	private async trackClosedWaitFiles(
		waitMarkerFile: URI,
		resourcesToWaitFor: URI[]
	): Promise<void> {
		await this.instantiationService.invokeFunction(accessor =>
			whenEditorClosed(accessor, resourcesToWaitFor)
		);
		await this.fileService.del(waitMarkerFile);
	}

	private async deleteWaitMarker(
		request: INativeOpenFileRequest
	): Promise<void> {
		if (request.filesToWait) {
			await this.fileService.del(URI.revive(
				request.filesToWait.waitMarkerFileUri
			));
		}
	}

	private postToShell(message: object): void {
		if (mainWindow.parent === mainWindow) {
			return;
		}

		mainWindow.parent.postMessage(message, mainWindow.location.origin);
	}

	private registerHostedShellCommands(): void {
		this._register(registerHostedOmniWebShellCommand(
			FOCUS_PROJECT_PANE_COMMAND_ID,
			localize2(
				'hostedOmniWebShellFocusProjects',
				'Omni-Window: Focus Projects'
			)
		));
		this._register(registerHostedOmniWebShellCommand(
			FOCUS_WORKSPACE_COMMAND_ID,
			localize2(
				'hostedOmniWebShellFocusWorkbench',
				'Omni-Window: Focus Workbench'
			)
		));
		this._register(registerHostedOmniWebShellCommand(
			RELOAD_WORKSPACE_COMMAND_ID,
			localize2(
				'hostedOmniWebShellReloadWorkbench',
				'Omni-Window: Reload Workbench'
			)
		));
		this._register(registerHostedOmniWebShellCommand(
			CLOSE_WORKSPACE_COMMAND_ID,
			localize2(
				'hostedOmniWebShellCloseWorkbench',
				'Omni-Window: Close Workbench'
			)
		));
	}
}

function isNativeOpenFileRequest(
	value: unknown
): value is INativeOpenFileRequest {
	return isObject(value);
}

registerWorkbenchContribution2(
	HostedOmniWebBridgeContribution.ID,
	HostedOmniWebBridgeContribution,
	WorkbenchPhase.AfterRestored
);

function registerHostedOmniWebShellCommand(
	id: string,
	title: ICommandActionTitle
) {
	return registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				title,
				f1: true,
				precondition: IsHostedOmniWorkspaceContext,
			});
		}

		override run(accessor: ServicesAccessor): void {
			const environmentService = accessor.get(IWorkbenchEnvironmentService);
			if (
				!environmentService.isHostedOmniWorkspace ||
				!environmentService.hostedInstanceId ||
				mainWindow.parent === mainWindow
			) {
				return;
			}

			mainWindow.parent.postMessage({
				type: HucodeOmniWebChildMessageType.ShellCommand,
				instanceId: environmentService.hostedInstanceId,
				commandId: id,
			}, mainWindow.location.origin);
		}
	});
}
