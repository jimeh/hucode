/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { afterEach, beforeEach, suite, test } from 'node:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
	preparePublicReleaseAssets,
	requiredPublicReleaseAssetNames
} from '../../hucode/release-assets.ts';

suite('Hucode public release assets', () => {
	let tmpDir: string;
	let artifactsRoot: string;
	let metadataPath: string;
	let outputRoot: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hucode-assets-'));
		artifactsRoot = path.join(tmpDir, 'artifacts');
		metadataPath = path.join(tmpDir, 'hucode-release-metadata.json');
		outputRoot = path.join(tmpDir, 'output');
		await fs.mkdir(artifactsRoot);
		await fs.writeFile(metadataPath, 'metadata');
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function writeRequiredAssets(): Promise<void> {
		for (const [index, name] of requiredPublicReleaseAssetNames.entries()) {
			if (name === path.basename(metadataPath)) {
				continue;
			}
			const targetRoot = path.join(artifactsRoot, `artifact-${index}`);
			await fs.mkdir(targetRoot);
			await fs.writeFile(path.join(targetRoot, name), name);
		}
	}

	test('flattens required assets and writes deterministic checksums', async () => {
		await writeRequiredAssets();
		await fs.writeFile(path.join(artifactsRoot, 'private-report.json'), 'no');

		const outputFiles = await preparePublicReleaseAssets(
			artifactsRoot,
			metadataPath,
			outputRoot
		);
		const outputNames = outputFiles.map(filePath => path.basename(filePath));

		assert.deepStrictEqual(
			outputNames,
			[
				...[...requiredPublicReleaseAssetNames].sort(),
				'SHA256SUMS'
			]
		);
		const checksums = await fs.readFile(
			path.join(outputRoot, 'SHA256SUMS'),
			'utf8'
		);
		for (const name of requiredPublicReleaseAssetNames) {
			assert.match(checksums, new RegExp(`  ${name.replace('.', '\\.')}$`, 'm'));
		}
		assert.doesNotMatch(checksums, /private-report/);
	});

	test('rejects a release missing a supported Linux package', async () => {
		await writeRequiredAssets();
		await fs.rm(
			path.join(artifactsRoot, 'artifact-5', 'hucode-linux-x64.deb')
		);

		await assert.rejects(
			preparePublicReleaseAssets(
				artifactsRoot,
				metadataPath,
				outputRoot
			),
			/Missing required public release assets: hucode-linux-x64\.deb/
		);
	});

	test('rejects duplicate public asset names', async () => {
		await writeRequiredAssets();
		const duplicateRoot = path.join(artifactsRoot, 'duplicate');
		await fs.mkdir(duplicateRoot);
		await fs.writeFile(
			path.join(duplicateRoot, 'hucode-linux-arm64.rpm'),
			'duplicate'
		);

		await assert.rejects(
			preparePublicReleaseAssets(
				artifactsRoot,
				metadataPath,
				outputRoot
			),
			/Duplicate public release asset 'hucode-linux-arm64\.rpm'/
		);
	});
});
