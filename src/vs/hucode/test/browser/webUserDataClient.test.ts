/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { readHucodeWebUserDataResponseError, readHucodeWebUserDataStore, runHucodeWebUserDataUploadWithLeaseRenewal } from '../../../platform/environment/browser/hucodeWebUserDataClient.js';

suite('Hucode web user-data client', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports a renewal failure instead of the resulting upload abort', async () => {
		const renewalError = new Error('renewal failed');
		let renewLease: (() => void) | undefined;
		let timerCleared = false;
		let uploadAborted = false;
		const result = runHucodeWebUserDataUploadWithLeaseRenewal(
			signal => new Promise<void>((_resolve, reject) => {
				signal.addEventListener('abort', () => {
					uploadAborted = true;
					reject(new DOMException('Upload aborted', 'AbortError'));
				});
			}),
			async () => { throw renewalError; },
			callback => {
				renewLease = callback;
				return 1;
			},
			() => { timerCleared = true; },
		);
		assert.ok(renewLease);
		renewLease();

		await assert.rejects(result, error => error === renewalError);
		assert.strictEqual(uploadAborted, true);
		assert.strictEqual(timerCleared, true);
	});

	test('preserves an upload failure when renewal succeeds', async () => {
		const uploadError = new Error('upload failed');
		let timerCleared = false;
		const result = runHucodeWebUserDataUploadWithLeaseRenewal(
			async () => { throw uploadError; },
			async () => undefined,
			() => 1,
			() => { timerCleared = true; },
		);

		await assert.rejects(result, error => error === uploadError);
		assert.strictEqual(timerCleared, true);
	});

	test('preserves a falsy renewal failure', async () => {
		let renewLease: (() => void) | undefined;
		const result = runHucodeWebUserDataUploadWithLeaseRenewal(
			signal => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError')))),
			() => Promise.reject(undefined),
			callback => {
				renewLease = callback;
				return 1;
			},
			() => undefined,
		);
		assert.ok(renewLease);
		renewLease();

		let rejected = false;
		try {
			await result;
		} catch (error) {
			rejected = true;
			assert.strictEqual(error, undefined);
		}
		assert.strictEqual(rejected, true);
	});

	test('stops scheduling renewals before draining the final renewal', async () => {
		let renewLease: (() => void) | undefined;
		let resolveUpload!: () => void;
		let resolveFirstRenewal!: () => void;
		let renewalCalls = 0;
		let timerCleared = false;
		const result = runHucodeWebUserDataUploadWithLeaseRenewal(
			() => new Promise<void>(resolve => { resolveUpload = resolve; }),
			() => {
				renewalCalls++;
				return renewalCalls === 1 ? new Promise<void>(resolve => { resolveFirstRenewal = resolve; }) : Promise.resolve();
			},
			callback => {
				renewLease = callback;
				return 1;
			},
			() => { timerCleared = true; },
		);
		assert.ok(renewLease);
		renewLease();
		await Promise.resolve();
		resolveUpload();
		await Promise.resolve();
		await Promise.resolve();
		if (!timerCleared) {
			renewLease();
		}
		resolveFirstRenewal();

		await result;
		assert.strictEqual(timerCleared, true);
		assert.strictEqual(renewalCalls, 1);
	});

	test('prefers a structured reset error and falls back for non-JSON', async () => {
		const fallback = 'Unable to reset server user data (HTTP 502).';
		assert.strictEqual(await readHucodeWebUserDataResponseError({ json: async () => ({ error: 'server rejected reset' }) }, fallback), 'server rejected reset');
		assert.strictEqual(await readHucodeWebUserDataResponseError({ json: async () => { throw new SyntaxError('Unexpected token'); } }, fallback), fallback);
		assert.strictEqual(await readHucodeWebUserDataResponseError({ json: async () => undefined }, fallback), fallback);
	});

	test('queues IndexedDB keys and values before awaiting either request', async () => {
		let transactionActive = true;
		const keysRequest = new TestIdbRequest<IDBValidKey[]>();
		const valuesRequest = new TestIdbRequest<unknown[]>();
		const store = {
			getAllKeys: () => {
				queueMicrotask(() => {
					transactionActive = false;
					keysRequest.succeed(['first', 'second']);
				});
				return keysRequest.value;
			},
			getAll: () => {
				assert.strictEqual(transactionActive, true, 'the values request must be queued while the transaction is active');
				queueMicrotask(() => valuesRequest.succeed(['one', 'two']));
				return valuesRequest.value;
			},
		};

		assert.deepStrictEqual(await readHucodeWebUserDataStore(store), [
			['first', 'one'],
			['second', 'two'],
		]);
	});
});

class TestIdbRequest<T> {
	private result: T | undefined;
	readonly value: IDBRequest<T>;

	constructor() {
		const request = this;
		this.value = {
			get result(): T {
				return request.result as T;
			},
			error: null,
			onerror: null as ((event: Event) => void) | null,
			onsuccess: null as ((event: Event) => void) | null,
		} as unknown as IDBRequest<T>;
	}

	succeed(result: T): void {
		this.result = result;
		this.value.onsuccess?.(new Event('success'));
	}
}
