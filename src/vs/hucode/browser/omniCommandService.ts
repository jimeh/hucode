/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';
import {
	IHucodeOmniCommandForwardingContext,
	isHucodeOmniShellAction,
	isHucodeOmniShellLayoutAction,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import '../../platform/window/common/hucodeOmniCommandForwardingContext.js';
import { INativeRunActionInWindowRequest } from '../../platform/window/common/window.js';
import {
	isHucodeOmniLocalInputFocus,
	isHucodeOmniProjectsFocus,
} from './omniFocus.js';
import { IHucodeShellControllerService } from
	'../../platform/window/common/hucodeShellControllerService.js';
import { CommandService } from '../../workbench/services/commands/common/commandService.js';
import { IWorkbenchEnvironmentService } from
	'../../workbench/services/environment/common/environmentService.js';
import { IExtensionService } from '../../workbench/services/extensions/common/extensions.js';

export class OmniCommandService extends CommandService {

	constructor(
		@IInstantiationService
		private readonly omniInstantiationService: IInstantiationService,
		@IExtensionService extensionService: IExtensionService,
		@ILogService private readonly omniLogService: ILogService,
		@IWorkbenchEnvironmentService
		private readonly environmentService: IWorkbenchEnvironmentService,
		@IHucodeOmniCommandForwardingContext
		private readonly commandForwardingContext:
			IHucodeOmniCommandForwardingContext
	) {
		super(omniInstantiationService, extensionService, omniLogService);
	}

	override async executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
		if (
			!this.environmentService.isOmniWindow ||
			!isHucodeOmniProjectsFocus() ||
			isHucodeOmniLocalInputFocus() ||
			this.commandForwardingContext.isForwardingDisabledFor(id) ||
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
			return await this.omniInstantiationService.invokeFunction(
				accessor => accessor.get(IHucodeShellControllerService)
					.runActionInWorkspace(request)
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
