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

	type CrashListener = (
		event: ElectronEvent,
		details: Details
	) => void;

	function utilityDetails(
		name: string,
		reason = 'crashed',
		exitCode = 1
	): Details {
		return {
			type: 'Utility',
			name,
			reason,
			exitCode,
		} as Details;
	}

	function createRegistryWithListener() {
		let listener: CrashListener | undefined;
		const registry = new UtilityProcessCrashRegistry(registeredListener => {
			assert.strictEqual(listener, undefined);
			listener = registeredListener;
		});

		return {
			registry,
			emit(details: Details): void {
				assert.ok(listener);
				listener({} as ElectronEvent, details);
			},
		};
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

	test('uses current handler after unregister and re-register', () => {
		const events: string[] = [];
		const { registry, emit } = createRegistryWithListener();
		registry.register('service-1', {
			handleUtilityProcessCrash(details) {
				events.push(`first:${details.reason}`);
			}
		});

		emit(utilityDetails('service-1'));
		registry.unregister('service-1');
		emit(utilityDetails('service-1', 'killed', 0));
		registry.register('service-1', {
			handleUtilityProcessCrash(details) {
				events.push(`second:${details.reason}`);
			}
		});
		emit(utilityDetails('service-1', 'oom', 2));

		assert.deepStrictEqual(events, ['first:crashed', 'second:oom']);
		assert.strictEqual(registry.size, 1);
	});

	test('cleanup of one utility process preserves other crash handlers', () => {
		const events: string[] = [];
		const { registry, emit } = createRegistryWithListener();
		registry.register('service-1', {
			handleUtilityProcessCrash() {
				events.push('service-1');
			}
		});
		registry.register('service-2', {
			handleUtilityProcessCrash() {
				events.push('service-2');
			}
		});

		registry.unregister('service-1');
		emit(utilityDetails('service-1'));
		emit(utilityDetails('service-2'));

		assert.deepStrictEqual(events, ['service-2']);
		assert.strictEqual(registry.size, 1);
	});

	test('ignores utility crash details without service name', () => {
		let crashes = 0;
		const { registry, emit } = createRegistryWithListener();
		registry.register('service-1', {
			handleUtilityProcessCrash() {
				crashes++;
			}
		});

		emit({
			type: 'Utility',
			reason: 'crashed',
			exitCode: 1,
		} as Details);

		assert.strictEqual(crashes, 0);
		assert.strictEqual(registry.size, 1);
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
