/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../platform/ipc/electron-browser/services.js';
import {
	HUCODE_SHELL_CHANNEL_NAME,
	IHucodeShellService
} from '../common/omniWindow.js';
import './hostedShellServiceAdapter.js';
import './shellControllerServiceAdapter.js';

registerMainProcessRemoteService(
	IHucodeShellService,
	HUCODE_SHELL_CHANNEL_NAME
);
