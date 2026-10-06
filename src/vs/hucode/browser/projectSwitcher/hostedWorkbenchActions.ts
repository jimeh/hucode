/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HucodeHostedWorkbenchLifecycleState } from
	'../../common/omniWindow.js';

/** Returns whether a hosted workbench can be suspended from its current state. */
export function canSuspendHostedWorkbench(
	state: HucodeHostedWorkbenchLifecycleState | undefined
): boolean {
	return state === 'active' || state === 'loaded';
}

/** Returns whether inline cleanup should unload instead of remove or dismiss. */
export function shouldUnloadHostedWorkbench(
	state: HucodeHostedWorkbenchLifecycleState | undefined
): boolean {
	return state === 'restore-pending' ||
		state === 'loading' ||
		state === 'active' ||
		state === 'loaded' ||
		state === 'dormant' ||
		state === 'crashed';
}
