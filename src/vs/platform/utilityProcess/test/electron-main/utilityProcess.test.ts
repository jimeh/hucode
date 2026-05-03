/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { Details, Event as ElectronEvent } from 'electron';
import {
	IUtilityProcessCrashHandler,
	UtilityProcessCrashRegistry,
} from '../../electron-main/utilityProcessCrashRegistry.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('UtilityProcessCrashRegistry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function utilityDetails(name: string): Details {
		return {
			type: 'Utility',
			name,
			reason: 'crashed',
			exitCode: 1,
		} as Details;
	}

	test('registers one Electron listener for many utility processes', () => {
		let listenerCount = 0;
		const registry = new UtilityProcessCrashRegistry(() => listenerCount++);
		const handler: IUtilityProcessCrashHandler = {
			handleUtilityProcessCrash() { }
		};

		for (let i = 0; i < 12; i++) {
			registry.register(`service-${i}`, handler);
		}

		assert.strictEqual(listenerCount, 1);
		assert.strictEqual(registry.size, 12);
	});

	test('dispatches matching utility crashes only', () => {
		let crashes = 0;
		const registry = new UtilityProcessCrashRegistry(() => { });
		registry.register('service-1', {
			handleUtilityProcessCrash(details) {
				assert.strictEqual(details.name, 'service-1');
				crashes++;
			}
		});

		registry.handleChildProcessGone({} as ElectronEvent, utilityDetails('other'));
		registry.handleChildProcessGone({} as ElectronEvent, {
			...utilityDetails('service-1'),
			type: 'GPU',
		} as Details);
		registry.handleChildProcessGone({} as ElectronEvent, utilityDetails('service-1'));

		assert.strictEqual(crashes, 1);
	});

	test('unregister removes crash handler', () => {
		let crashes = 0;
		const registry = new UtilityProcessCrashRegistry(() => { });
		registry.register('service-1', {
			handleUtilityProcessCrash() {
				crashes++;
			}
		});

		registry.unregister('service-1');
		registry.handleChildProcessGone({} as ElectronEvent, utilityDetails('service-1'));

		assert.strictEqual(crashes, 0);
		assert.strictEqual(registry.size, 0);
	});
});
