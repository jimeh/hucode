/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Disposable,
	IDisposable,
	toDisposable,
} from '../../base/common/lifecycle.js';

/** Global property containing the narrowly scoped Omni smoke-test driver. */
export const HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY =
	'__hucodeOmniSmokeTestDriver';

/** Smoke-only operations exposed to packaged Omni lifecycle automation. */
export interface IHucodeOmniSmokeTestDriver {
	suspendWorkspace(instanceId: string): Promise<void>;
}

/** Window-like target capable of holding the Omni smoke-test driver. */
export interface IHucodeOmniSmokeTestDriverTarget {
	[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY]?: IHucodeOmniSmokeTestDriver;
}

/**
 * Registers the specific Omni suspend seam only in an enabled smoke window.
 */
export function registerOmniSmokeTestDriver(options: {
	readonly target: IHucodeOmniSmokeTestDriverTarget;
	readonly enableSmokeTestDriver: boolean;
	readonly isOmniWindow: boolean;
	readonly windowId: number;
	readonly suspendWorkspace: (
		windowId: number,
		instanceId: string
	) => Promise<unknown>;
}): IDisposable {
	if (!options.enableSmokeTestDriver || !options.isOmniWindow) {
		return Disposable.None;
	}

	const driver: IHucodeOmniSmokeTestDriver = {
		async suspendWorkspace(instanceId): Promise<void> {
			if (!instanceId) {
				throw new Error(
					'The Omni smoke-test driver requires a hosted instance ID.'
				);
			}
			await options.suspendWorkspace(options.windowId, instanceId);
		},
	};
	options.target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY] = driver;

	return toDisposable(() => {
		if (
			options.target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY] === driver
		) {
			delete options.target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY];
		}
	});
}
