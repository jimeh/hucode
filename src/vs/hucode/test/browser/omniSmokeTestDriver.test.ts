/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY,
	IHucodeOmniSmokeTestDriver,
	IHucodeOmniSmokeTestDriverTarget,
	registerOmniSmokeTestDriver,
} from '../../browser/omniSmokeTestDriver.js';

suite('HucodeOmniSmokeTestDriver', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('stays unavailable outside an Omni smoke-test window', () => {
		for (const options of [
			{ enableSmokeTestDriver: false, isOmniWindow: true },
			{ enableSmokeTestDriver: true, isOmniWindow: false },
			{ enableSmokeTestDriver: false, isOmniWindow: false },
		]) {
			const target: IHucodeOmniSmokeTestDriverTarget = {};
			disposables.add(registerOmniSmokeTestDriver({
				...options,
				target,
				windowId: 7,
				suspendWorkspace: async () => {
					throw new Error('disabled driver forwarded');
				},
			}));
			assert.strictEqual(
				target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY],
				undefined
			);
		}
	});

	test('forwards only a specific suspend request with the shell window id',
		async () => {
			const calls: Array<readonly [number, string]> = [];
			const target: IHucodeOmniSmokeTestDriverTarget = {};
			const registration = disposables.add(registerOmniSmokeTestDriver({
				target,
				enableSmokeTestDriver: true,
				isOmniWindow: true,
				windowId: 7,
				suspendWorkspace: async (windowId, instanceId) => {
					calls.push([windowId, instanceId]);
				},
			}));
			const driver =
				target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY];

			assert.ok(driver);
			assert.deepStrictEqual(Object.keys(driver), ['suspendWorkspace']);
			await driver.suspendWorkspace('bravo-instance');
			assert.deepStrictEqual(calls, [[7, 'bravo-instance']]);
			await assert.rejects(
				driver.suspendWorkspace(''),
				/hosted instance ID/
			);

			registration.dispose();
			assert.strictEqual(
				target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY],
				undefined
			);
		}
	);

	test('does not remove a replacement installed before disposal', () => {
		const target: IHucodeOmniSmokeTestDriverTarget = {};
		const registration = disposables.add(registerOmniSmokeTestDriver({
			target,
			enableSmokeTestDriver: true,
			isOmniWindow: true,
			windowId: 7,
			suspendWorkspace: async () => undefined,
		}));
		const replacement: IHucodeOmniSmokeTestDriver = {
			suspendWorkspace: async () => undefined,
		};
		target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY] = replacement;

		registration.dispose();
		assert.strictEqual(
			target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY],
			replacement
		);
	});
});
