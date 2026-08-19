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
			{ enableSmokeTestDriver: false, isOmniShellWindow: true },
			{ enableSmokeTestDriver: true, isOmniShellWindow: false },
			{ enableSmokeTestDriver: false, isOmniShellWindow: false },
		]) {
			const target: IHucodeOmniSmokeTestDriverTarget = {};
			disposables.add(registerOmniSmokeTestDriver({
				...options,
				target,
				windowId: 7,
				openWorkspace: async () => {
					throw new Error('disabled driver forwarded');
				},
				suspendWorkspace: async () => {
					throw new Error('disabled driver forwarded');
				},
				reloadWorkspace: async () => {
					throw new Error('disabled driver forwarded');
				},
				focusWorkspace: async () => {
					throw new Error('disabled driver forwarded');
				},
			}));
			assert.strictEqual(
				target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY],
				undefined
			);
		}
	});

	test('forwards the narrow fixture and recovery requests with the shell window id',
		async () => {
			const calls: string[] = [];
			const target: IHucodeOmniSmokeTestDriverTarget = {};
			const registration = disposables.add(registerOmniSmokeTestDriver({
				target,
				enableSmokeTestDriver: true,
				isOmniShellWindow: true,
				windowId: 7,
				openWorkspace: async (windowId, worktreePath) => {
					calls.push(`open:${windowId}:${worktreePath}`);
				},
				suspendWorkspace: async (windowId, instanceId) => {
					calls.push(`suspend:${windowId}:${instanceId}`);
				},
				reloadWorkspace: async windowId => {
					calls.push(`reload:${windowId}`);
				},
				focusWorkspace: async windowId => {
					calls.push(`focus:${windowId}`);
				},
			}));
			const driver =
				target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY];

			assert.ok(driver);
			assert.deepStrictEqual(Object.keys(driver).sort(), [
				'focusActiveWorkspace',
				'openWorkspace',
				'reloadActiveWorkspace',
				'suspendWorkspace',
			]);
			await driver.openWorkspace('/tmp/Alpha');
			await driver.suspendWorkspace('bravo-instance');
			await driver.reloadActiveWorkspace();
			await driver.focusActiveWorkspace();
			assert.deepStrictEqual(calls, [
				'open:7:/tmp/Alpha',
				'suspend:7:bravo-instance',
				'reload:7',
				'focus:7',
			]);
			await assert.rejects(
				driver.openWorkspace(''),
				/worktree path/
			);
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
			isOmniShellWindow: true,
			windowId: 7,
			openWorkspace: async () => undefined,
			suspendWorkspace: async () => undefined,
			reloadWorkspace: async () => undefined,
			focusWorkspace: async () => undefined,
		}));
		const replacement: IHucodeOmniSmokeTestDriver = {
			openWorkspace: async () => undefined,
			suspendWorkspace: async () => undefined,
			reloadActiveWorkspace: async () => undefined,
			focusActiveWorkspace: async () => undefined,
		};
		target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY] = replacement;

		registration.dispose();
		assert.strictEqual(
			target[HUCODE_OMNI_SMOKE_TEST_DRIVER_PROPERTY],
			replacement
		);
	});
});
