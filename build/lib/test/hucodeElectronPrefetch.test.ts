/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import {
	prefetchElectron,
	type IElectronPrefetchDependencies,
	type IElectronPrefetchOptions,
} from '../../hucode/electron-prefetch.ts';

const options: IElectronPrefetchOptions = {
	version: '42.7.0',
	platform: 'darwin',
	arch: 'x64',
};

suite('Hucode Electron prefetch', () => {
	test('retries native fetch failures with bounded exponential backoff', async () => {
		const transientError = new TypeError('fetch failed', {
			cause: Object.assign(
				new Error('Connect Timeout Error'),
				{ code: 'UND_ERR_CONNECT_TIMEOUT' }
			)
		});
		const harness = createHarness([transientError, transientError]);

		const artifactPath = await prefetchElectron(
			options,
			harness.dependencies
		);

		assert.strictEqual(artifactPath, '/cache/electron.zip');
		assert.strictEqual(harness.downloads.length, 3);
		assert.deepStrictEqual(harness.delays, [5_000, 10_000]);
		assert.strictEqual(harness.warnings.length, 2);
		assert.match(
			harness.warnings[0],
			/attempt 1 of 4.*retrying in 5s.*UND_ERR_CONNECT_TIMEOUT/
		);
		assert.match(
			harness.warnings[1],
			/attempt 2 of 4.*retrying in 10s.*UND_ERR_CONNECT_TIMEOUT/
		);
	});

	test('retries transient HTTP responses', async () => {
		const serviceUnavailable = Object.assign(
			new Error('Response code 503 (Service Unavailable)'),
			{ response: { status: 503 } }
		);
		const harness = createHarness([serviceUnavailable]);

		await prefetchElectron(options, harness.dependencies);

		assert.strictEqual(harness.downloads.length, 2);
		assert.deepStrictEqual(harness.delays, [5_000]);
	});

	test('does not retry deterministic download failures', async () => {
		const notFound = Object.assign(
			new Error('Response code 404 (Not Found)'),
			{ response: { status: 404 } }
		);
		const harness = createHarness([notFound]);

		await assert.rejects(
			prefetchElectron(options, harness.dependencies),
			/Response code 404/
		);

		assert.strictEqual(harness.downloads.length, 1);
		assert.deepStrictEqual(harness.delays, []);
		assert.deepStrictEqual(harness.warnings, []);
	});

	test('stops after the fourth transient failure', async () => {
		const reset = Object.assign(
			new Error('socket reset'),
			{ code: 'ECONNRESET' }
		);
		const harness = createHarness([reset, reset, reset, reset]);

		await assert.rejects(
			prefetchElectron(options, harness.dependencies),
			/socket reset/
		);

		assert.strictEqual(harness.downloads.length, 4);
		assert.deepStrictEqual(harness.delays, [5_000, 10_000, 20_000]);
		assert.strictEqual(harness.warnings.length, 3);
	});

	test('normalizes armhf to the Electron arm artifact cache key', async () => {
		const harness = createHarness();

		await prefetchElectron({
			...options,
			platform: 'linux',
			arch: 'armhf',
		}, harness.dependencies);

		assert.deepStrictEqual(harness.downloads, [{
			version: options.version,
			platform: 'linux',
			arch: 'arm',
		}]);
	});
});

function createHarness(failures: readonly Error[] = []): {
	readonly dependencies: IElectronPrefetchDependencies;
	readonly downloads: IElectronPrefetchOptions[];
	readonly delays: number[];
	readonly warnings: string[];
} {
	const downloads: IElectronPrefetchOptions[] = [];
	const delays: number[] = [];
	const warnings: string[] = [];
	let attempt = 0;

	return {
		dependencies: {
			download: async downloadOptions => {
				downloads.push(downloadOptions);
				const failure = failures[attempt++];
				if (failure) {
					throw failure;
				}
				return '/cache/electron.zip';
			},
			sleep: async milliseconds => {
				delays.push(milliseconds);
			},
			warning: message => {
				warnings.push(message);
			},
		},
		downloads,
		delays,
		warnings,
	};
}
