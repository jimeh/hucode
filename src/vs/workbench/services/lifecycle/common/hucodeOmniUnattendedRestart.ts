/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IUnattendedRestartService } from './unattendedRestart.js';

/**
 * The blocker every renderer of an Omni window reports. The shell and its
 * hosted workbenches share the window's IPC context, so the main process asks
 * one of them at random, and none can answer for the others.
 */
export const HUCODE_OMNI_UNATTENDED_RESTART_BLOCKER = 'hucode.omniWindow';

/**
 * Keeps an Omni window from restarting unattended, for example to apply an
 * update while the screen is locked.
 */
export function registerHucodeOmniUnattendedRestartBlocker(
	unattendedRestartService: IUnattendedRestartService
): IDisposable {
	return unattendedRestartService.registerParticipant({
		check: () => HUCODE_OMNI_UNATTENDED_RESTART_BLOCKER,
	});
}
