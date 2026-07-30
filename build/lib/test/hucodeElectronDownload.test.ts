/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import path from 'path';
import { test } from 'node:test';
import {
	config,
	createPrefetchedElectronAssetResolver,
	selectElectronAssetResolver,
} from '../electron.ts';

test('Electron packaging relies only on the pinned local checksum file', () => {
	assert.deepStrictEqual({
		localChecksumValidationEnabled: config.validateChecksum,
		checksumFile: config.checksumFile,
	}, {
		localChecksumValidationEnabled: true,
		checksumFile: path.resolve(
			import.meta.dirname,
			'..',
			'..',
			'checksums',
			'electron.txt'
		),
	});
});

test('selects the prefetched resolver only for the enabled no-feed path', async () => {
	assert.strictEqual(
		selectElectronAssetResolver(
			undefined,
			false,
			config.checksumFile
		),
		undefined
	);
	const resolver = selectElectronAssetResolver(
		undefined,
		true,
		config.checksumFile
	);
	assert.ok(resolver);
	await assert.rejects(
		resolver({
			url: 'https://example.test/electron.zip',
			fileName: 'electron.zip',
		}),
		/was not found in the Electron prefetch cache/
	);
});

test('preserves the Azure feed resolver when prefetch mode is enabled', () => {
	const feedResolver = async () => new Response('feed');

	assert.strictEqual(
		selectElectronAssetResolver(
			feedResolver,
			true,
			config.checksumFile
		),
		feedResolver
	);
});

test('prefetched Electron resolver serves the pinned checksum file', async () => {
	const resolver = createPrefetchedElectronAssetResolver(
		true,
		config.checksumFile
	);
	assert.ok(resolver);

	const response = await resolver({
		url: 'https://github.com/electron/electron/releases/download/v42.7.0/SHASUMS256.txt',
		fileName: 'SHASUMS256.txt',
	});

	assert.strictEqual(response.status, 200);
	assert.strictEqual(
		await response.text(),
		readFileSync(config.checksumFile, 'utf8')
	);
});

test('prefetched Electron resolver rejects an artifact cache miss', async () => {
	const resolver = createPrefetchedElectronAssetResolver(
		true,
		config.checksumFile
	);
	assert.ok(resolver);

	await assert.rejects(
		resolver({
			url: 'https://github.com/electron/electron/releases/download/v42.7.0/electron-v42.7.0-linux-x64.zip',
			fileName: 'electron-v42.7.0-linux-x64.zip',
		}),
		/was not found in the Electron prefetch cache/
	);
});
