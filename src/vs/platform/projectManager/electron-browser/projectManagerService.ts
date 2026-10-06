/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import {
	IProjectManagerService,
	PROJECT_MANAGER_CHANNEL_NAME
} from '../common/projectManager.js';

registerMainProcessRemoteService(
	IProjectManagerService,
	PROJECT_MANAGER_CHANNEL_NAME
);
