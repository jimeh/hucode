/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { test } from 'node:test';

interface IGulpElectronDownload {
	readonly download: (options: Readonly<Record<string, unknown>>) =>
		Promise<string>;
}

test('gulp-electron consumes the artifact written by the prefetch cache', {
	skip: process.platform !== 'linux',
}, async t => {
	const tempDirectory = await mkdtemp(
		path.join(tmpdir(), 'hucode-electron-cache-handoff-')
	);
	t.after(() => rm(tempDirectory, { recursive: true, force: true }));

	const previousCacheHome = process.env['XDG_CACHE_HOME'];
	process.env['XDG_CACHE_HOME'] = path.join(tempDirectory, 'cache');
	t.after(() => {
		if (previousCacheHome === undefined) {
			delete process.env['XDG_CACHE_HOME'];
		} else {
			process.env['XDG_CACHE_HOME'] = previousCacheHome;
		}
	});

	const [{ downloadArtifact }, prefetch, electronBuild] =
		await Promise.all([
			import('@electron/get'),
			import('../../hucode/electron-prefetch.ts'),
			import('../electron.ts'),
		]);
	const require = createRequire(import.meta.url);
	const gulpElectron = require(
		'@vscode/gulp-electron/src/download.js'
	) as IGulpElectronDownload;

	const version = '42.7.0';
	const artifactFileName =
		`electron-v${version}-linux-armv7l.zip`;
	const artifact = Buffer.from('offline Electron artifact fixture');
	const checksum = createHash('sha256').update(artifact).digest('hex');
	const checksumFile = path.join(tempDirectory, 'electron.txt');
	await writeFile(
		checksumFile,
		`${checksum} *${artifactFileName}\n`
	);

	const downloadRequests: string[] = [];
	const details = prefetch.buildElectronArtifactDetails({
		version,
		platform: 'linux',
		arch: 'armhf',
	}, {
		[artifactFileName]: checksum,
	});
	const prefetchedPath = await downloadArtifact({
		...details,
		downloader: {
			download: async (
				url: string,
				targetFilePath: string
			): Promise<void> => {
				downloadRequests.push(url);
				await writeFile(targetFilePath, artifact);
			},
		},
	});

	const resolverRequests: string[] = [];
	const cacheOnlyResolver =
		electronBuild.createPrefetchedElectronAssetResolver(
			true,
			checksumFile
		);
	assert.ok(cacheOnlyResolver);
	const packagedPath = await gulpElectron.download({
		version,
		platform: 'linux',
		arch: 'armv7l',
		artifactName: 'electron',
		repo: async (request: {
			readonly url: string;
			readonly fileName: string;
		}) => {
			resolverRequests.push(request.fileName);
			return cacheOnlyResolver(request);
		},
	});

	assert.strictEqual(packagedPath, prefetchedPath);
	assert.ok(
		prefetchedPath.startsWith(process.env['XDG_CACHE_HOME'] as string)
	);
	assert.strictEqual(downloadRequests.length, 1);
	assert.match(downloadRequests[0], new RegExp(`${artifactFileName}$`));
	assert.deepStrictEqual(resolverRequests, ['SHASUMS256.txt']);
	await assert.rejects(
		cacheOnlyResolver({
			url: 'https://example.test/electron.zip',
			fileName: artifactFileName,
		}),
		/not present or valid in the Electron prefetch cache/
	);
});
