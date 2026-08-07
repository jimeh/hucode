/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventHelper } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { ILogService } from '../../platform/log/common/log.js';
import {
	HucodeShellControllerUnavailableError,
	IHucodeShellControllerService,
} from '../../platform/window/common/hucodeShellControllerService.js';
import {
	HUCODE_OMNI_CLIPBOARD_ACTIONS,
	IHucodeOmniCommandForwardingContext,
	IHucodeOmniCommandForwardingScope,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from '../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
import {
	isHucodeOmniLocalInputFocus,
	isHucodeOmniProjectsFocus,
} from './omniFocus.js';

/**
 * Forwards browser clipboard events that bypass the command service while the
 * serve-web Projects surface owns focus.
 */
export class OmniWebClipboardForwardingContribution extends Disposable
	implements IWorkbenchContribution {

	static readonly ID = 'hucode.omniWebClipboardForwarding';

	private readonly commandForwardingScope:
		IHucodeOmniCommandForwardingScope;

	constructor(
		@IWorkbenchEnvironmentService
		private readonly environmentService: IWorkbenchEnvironmentService,
		@IHucodeShellControllerService
		private readonly shellControllerService:
			IHucodeShellControllerService,
		@ICommandService
		private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IHucodeOmniCommandForwardingContext
		commandForwardingContext: IHucodeOmniCommandForwardingContext,
	) {
		super();
		this.commandForwardingScope = commandForwardingContext.createScope();

		if (!this.environmentService.isOmniShellWindow) {
			return;
		}

		for (const [eventType, actionId] of
			HUCODE_OMNI_CLIPBOARD_ACTIONS) {
			this._register(addDisposableListener(
				mainWindow.document,
				eventType,
				event => void this.handleClipboardEvent(event, actionId)
			));
		}
	}

	async handleClipboardEvent(event: Event, actionId: string): Promise<void> {
		if (
			!this.environmentService.isOmniShellWindow ||
			!isHucodeOmniProjectsFocus() ||
			isHucodeOmniLocalInputFocus() ||
			this.commandForwardingScope.isForwardingDisabledFor(actionId)
		) {
			return;
		}

		// Clipboard cancellation must happen synchronously during dispatch.
		EventHelper.stop(event, true);
		try {
			if (await this.shellControllerService.runActionInWorkspace({
				id: actionId,
				from: 'menu',
			})) {
				return;
			}
		} catch (error) {
			this.logService.warn(
				`Failed to forward Omni shell action ${actionId}: ${error}`
			);
			// A transport error after dispatch has ambiguous delivery. Retrying
			// paste or a destructive cut could apply it twice.
			if (!(error instanceof HucodeShellControllerUnavailableError)) {
				return;
			}
		}

		try {
			await this.commandForwardingScope.runWithForwardingDisabledFor(
				actionId,
				() => this.commandService.executeCommand(actionId)
			);
		} catch (error) {
			this.logService.warn(
				`Failed to run Omni shell action ${actionId} locally: ${error}`
			);
		}
	}
}

registerWorkbenchContribution2(
	OmniWebClipboardForwardingContribution.ID,
	OmniWebClipboardForwardingContribution,
	WorkbenchPhase.AfterRestored
);
