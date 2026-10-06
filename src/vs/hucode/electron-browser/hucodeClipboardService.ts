/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../platform/log/common/log.js';
import { INativeHostService } from '../../platform/native/common/native.js';
import { IClipboardService } from
	'../../platform/clipboard/common/clipboardService.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';
import { IHucodeHostedShellService } from
	'../../platform/window/common/hucodeHostedShellService.js';
import { NativeClipboardService } from
	'../../workbench/services/clipboard/electron-browser/clipboardService.js';
import { INativeWorkbenchEnvironmentService } from
	'../../workbench/services/environment/electron-browser/environmentService.js';

/** Desktop clipboard override for hosted Omni workbenches. */
export class HucodeNativeClipboardService extends NativeClipboardService {

	constructor(
		@INativeHostService nativeHostService: INativeHostService,
		@ILogService private readonly hucodeLogService: ILogService,
		@INativeWorkbenchEnvironmentService
		private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IHucodeHostedShellService
		private readonly hostedShellService: IHucodeHostedShellService
	) {
		super(nativeHostService, hucodeLogService);
	}

	override async triggerPaste(targetWindowId: number): Promise<void> {
		if (this.environmentService.isHostedOmniWorkspace) {
			this.hucodeLogService.trace(
				'NativeClipboardService#triggerPaste called'
			);
			await this.hostedShellService.triggerPasteInSelf();
			return;
		}

		return super.triggerPaste(targetWindowId);
	}
}

registerSingleton(
	IClipboardService,
	HucodeNativeClipboardService,
	InstantiationType.Delayed
);
