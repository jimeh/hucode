/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isObject } from '../../../../base/common/types.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandActionTitle } from '../../../../platform/action/common/action.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import {
	CLOSE_WORKSPACE_COMMAND_ID,
	FOCUS_PROJECT_PANE_COMMAND_ID,
	FOCUS_WORKSPACE_COMMAND_ID,
	RELOAD_WORKSPACE_COMMAND_ID,
	UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
} from '../../../../platform/window/common/hucodeOmniCommandRouting.js';
import { IsHostedOmniWorkspaceContext } from '../../../common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import {
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
} from '../../../../platform/window/common/hucodeOmniWebMessages.js';

interface HucodeHostedOmniWebMessage {
	readonly type?: unknown;
	readonly instanceId?: unknown;
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
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
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

		mainWindow.addEventListener('focus', () => this.postFocus(instanceId, true));
		mainWindow.addEventListener('blur', () => this.postFocus(instanceId, false));
		mainWindow.addEventListener('message', event => {
			if (event.origin !== mainWindow.location.origin) {
				return;
			}
			void this.handleMessage(instanceId, event.data);
		});
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
			await this.commandService.executeCommand(message.commandId, ...args);
			this.postToShell({
				type: HucodeOmniWebChildMessageType.CommandResult,
				instanceId,
				commandId: message.commandId,
				ok: true,
			});
		} catch (error) {
			this.postToShell({
				type: HucodeOmniWebChildMessageType.CommandResult,
				instanceId,
				commandId: message.commandId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
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
			'Omni-Window: Focus Projects'
		));
		this._register(registerHostedOmniWebShellCommand(
			FOCUS_WORKSPACE_COMMAND_ID,
			'Omni-Window: Focus Workbench'
		));
		this._register(registerHostedOmniWebShellCommand(
			RELOAD_WORKSPACE_COMMAND_ID,
			'Omni-Window: Reload Workbench'
		));
		this._register(registerHostedOmniWebShellCommand(
			CLOSE_WORKSPACE_COMMAND_ID,
			'Omni-Window: Close Workbench'
		));
		this._register(registerHostedOmniWebShellCommand(
			UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
			'Omni-Window: Unload Current Worktree'
		));
	}
}

registerWorkbenchContribution2(
	HostedOmniWebBridgeContribution.ID,
	HostedOmniWebBridgeContribution,
	WorkbenchPhase.AfterRestored
);

function registerHostedOmniWebShellCommand(
	id: string,
	title: string
) {
	return registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				title: literalTitle(title),
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

function literalTitle(value: string): ICommandActionTitle {
	return { value, original: value };
}
