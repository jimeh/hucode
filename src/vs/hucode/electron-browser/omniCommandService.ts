/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';
import {
	isHucodeOmniShellAction,
	isHucodeOmniShellCommandForwardingDisabled,
	isHucodeOmniShellLayoutAction,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import { INativeRunActionInWindowRequest } from '../../platform/window/common/window.js';
import {
	isHucodeOmniLocalInputFocus,
	isHucodeOmniProjectsFocus,
} from '../browser/omniFocus.js';
import { IHucodeShellService } from '../common/omniWindow.js';
import { CommandService } from '../../workbench/services/commands/common/commandService.js';
import { INativeWorkbenchEnvironmentService } from '../../workbench/services/environment/electron-browser/environmentService.js';
import { IExtensionService } from '../../workbench/services/extensions/common/extensions.js';

class OmniCommandService extends CommandService {

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IExtensionService extensionService: IExtensionService,
		@ILogService private readonly omniLogService: ILogService,
		@INativeWorkbenchEnvironmentService
		private readonly nativeEnvironmentService:
			INativeWorkbenchEnvironmentService,
		@IHucodeShellService
		private readonly shellService: IHucodeShellService
	) {
		super(instantiationService, extensionService, omniLogService);
	}

	override async executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
		if (
			!this.nativeEnvironmentService.isOmniWindow ||
			!isHucodeOmniProjectsFocus() ||
			isHucodeOmniLocalInputFocus() ||
			isHucodeOmniShellCommandForwardingDisabled() ||
			isHucodeOmniShellAction(id)
		) {
			return super.executeCommand(id, ...args);
		}

		const forwarded = await this.tryForwardCommand(id, args);
		if (forwarded || isHucodeOmniShellLayoutAction(id)) {
			return undefined as T;
		}

		return super.executeCommand(id, ...args);
	}

	private async tryForwardCommand(
		id: string,
		args: unknown[]
	): Promise<boolean> {
		const request: INativeRunActionInWindowRequest = {
			id,
			from: 'keybinding',
			args: args.length ? args : undefined,
		};

		try {
			return await this.shellService.runActionInWorkspace(
				this.nativeEnvironmentService.window.id,
				request
			);
		} catch (error) {
			this.omniLogService.warn(
				`Failed to forward Omni shell command ${id}: ${error}`
			);
			return false;
		}
	}
}

registerSingleton(
	ICommandService,
	OmniCommandService,
	InstantiationType.Delayed
);
