/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, getWindowId } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { isObject } from '../../base/common/types.js';
import { Action2 } from '../../platform/actions/common/actions.js';
import { registerOmniShellAction2 } from './omniShellCommandRegistration.js';
import { ICommandActionTitle } from '../../platform/action/common/action.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
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
import { IHucodeOmniWebWorkbenchClient } from
	'../../platform/window/common/hucodeOmniWebMessages.js';
import { IHucodeHostedOmniWebConnectionService } from
	'./hostedOmniWebConnection.js';
import { IHucodeShellService } from '../common/omniWindow.js';
import { openHucodeFilesRequest } from
	'../../workbench/browser/hucodeOpenFilesRequest.js';
import './hostedOmniWebShellService.js';
import './projectManager/webProjectManagerService.js';
import './hostedOmniWorkspace.contribution.js';

/**
 * Connects a hosted iframe workbench to its Omni web shell: it exposes the
 * workbench-side channel, signals restore readiness, and relays focus.
 */
class HostedOmniWebBridgeContribution extends Disposable
	implements IWorkbenchContribution, IHucodeOmniWebWorkbenchClient {

	static readonly ID = 'hucode.hostedOmniWebBridge';

	constructor(
		@IWorkbenchEnvironmentService
		environmentService: IWorkbenchEnvironmentService,
		@IHucodeHostedOmniWebConnectionService
		private readonly connectionService: IHucodeHostedOmniWebConnectionService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		if (
			!environmentService.isHostedOmniWorkspace ||
			!environmentService.hostedInstanceId ||
			!this.connectionService.isHosted
		) {
			return;
		}

		this.registerHostedShellCommands();
		this.connectionService.registerWorkbenchClient(this);
		this.connectionService.signalReady();

		this._register(addDisposableListener(
			mainWindow,
			'focus',
			() => this.connectionService.notifyFocus(true)
		));
		this._register(addDisposableListener(
			mainWindow,
			'blur',
			() => this.connectionService.notifyFocus(false)
		));
	}

	async runCommand(
		commandId: string,
		args: readonly unknown[]
	): Promise<boolean> {
		try {
			await this.commandService.executeCommand(commandId, ...args);
			return true;
		} catch (error) {
			this.logService.error(error);
			return false;
		}
	}

	async openFiles(request: INativeOpenFileRequest): Promise<boolean> {
		if (!isNativeOpenFileRequest(request)) {
			return false;
		}

		try {
			return await openHucodeFilesRequest(request, {
				editorService: this.editorService,
				fileService: this.fileService,
				instantiationService: this.instantiationService,
				logService: this.logService,
			});
		} catch (error) {
			this.logService.error(error);
			return false;
		}
	}

	async prepareUnload(): Promise<boolean> {
		try {
			await this.lifecycleService.shutdown();
			return true;
		} catch (error) {
			this.logService.error(error);
			return false;
		}
	}

	private registerHostedShellCommands(): void {
		this._register(registerHostedOmniWebShellCommand(
			FOCUS_PROJECT_PANE_COMMAND_ID,
			localize2(
				'hostedOmniWebShellFocusProjects',
				'Omni-Window: Focus Projects'
			),
			(shellService, windowId) => shellService.focusShell(windowId)
		));
		this._register(registerHostedOmniWebShellCommand(
			FOCUS_WORKSPACE_COMMAND_ID,
			localize2(
				'hostedOmniWebShellFocusWorkbench',
				'Omni-Window: Focus Workbench'
			),
			(shellService, windowId) => shellService.focusWorkspace(windowId)
		));
		this._register(registerHostedOmniWebShellCommand(
			RELOAD_WORKSPACE_COMMAND_ID,
			localize2(
				'hostedOmniWebShellReloadWorkbench',
				'Omni-Window: Reload Workbench'
			),
			(shellService, windowId) => shellService.reloadWorkspace(windowId)
		));
		this._register(registerHostedOmniWebShellCommand(
			CLOSE_WORKSPACE_COMMAND_ID,
			localize2(
				'hostedOmniWebShellCloseWorkbench',
				'Omni-Window: Close Workbench'
			),
			(shellService, windowId, instanceId) =>
				shellService.closeWorkspace(windowId, instanceId)
					.then(() => undefined)
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
	title: ICommandActionTitle,
	run: (
		shellService: IHucodeShellService,
		windowId: number,
		instanceId: string
	) => Promise<void>
) {
	return registerOmniShellAction2(id, class extends Action2 {
		constructor() {
			super({
				id,
				title,
				f1: true,
				precondition: IsHostedOmniWorkspaceContext,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const environmentService = accessor.get(IWorkbenchEnvironmentService);
			const instanceId = environmentService.hostedInstanceId;
			if (!environmentService.isHostedOmniWorkspace || !instanceId) {
				return;
			}

			await run(
				accessor.get(IHucodeShellService),
				getWindowId(mainWindow),
				instanceId
			);
		}
	});
}
