/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { hucodeCreateLazyEventService } from '../../common/lazyEventService.js';

suite('HucodeLazyEventService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps selected service events lazy for ProxyChannel', async () => {
		const disposables = new DisposableStore();
		let sourceListeners = 0;
		const emitter = new Emitter<string>({
			onWillAddFirstListener: () => sourceListeners++
		});

		class TestService {
			readonly onDidChange = emitter.event;
			readonly value = 'ready';

			getValue(): string {
				return this.value;
			}
		}

		try {
			const service = hucodeCreateLazyEventService(
				new TestService(),
				['onDidChange']
			);
			const channel = ProxyChannel.fromService(service, disposables);
			assert.strictEqual(sourceListeners, 0);
			assert.strictEqual(await channel.call(undefined, 'getValue'), 'ready');

			const event = channel.listen<string>(undefined, 'onDidChange');
			assert.strictEqual(sourceListeners, 1);

			const events: string[] = [];
			const listener = event(e => events.push(e));
			try {
				emitter.fire('changed');
				await timeout(0);

				assert.deepStrictEqual(events, ['changed']);
			} finally {
				listener.dispose();
			}
		} finally {
			emitter.dispose();
			disposables.dispose();
		}
	});
});
