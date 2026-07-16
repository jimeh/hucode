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
	requiredPublicReleaseAssetNames,
	requiredPublishedReleaseAssetNames,
	validatePublishedReleaseAssetNames
} from '../../hucode/release-assets.ts';

suite('Hucode public release assets', () => {
	let tmpDir: string;
	let artifactsRoot: string;
	let metadataPath: string;
	let checksumsPath: string;
	let manifestPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hucode-assets-'));
		artifactsRoot = path.join(tmpDir, 'artifacts');
		metadataPath = path.join(tmpDir, 'hucode-release-metadata.json');
		checksumsPath = path.join(tmpDir, 'SHA256SUMS');
		manifestPath = path.join(tmpDir, 'release-assets.json');
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

	test('references source assets and writes deterministic checksums', async () => {
		await writeRequiredAssets();
		await fs.writeFile(path.join(artifactsRoot, 'private-report.json'), 'no');

		const manifest = await preparePublicReleaseAssets(
			artifactsRoot,
			metadataPath,
			checksumsPath,
			manifestPath
		);
		const normalizeManifest = (value: typeof manifest) => ({
			...value,
			assets: value.assets.map(asset => ({
				...asset,
				path: asset.path === metadataPath
					? '<metadata>'
					: asset.path === checksumsPath
						? '<checksums>'
						: path.relative(artifactsRoot, asset.path).replaceAll(path.sep, '/')
			}))
		});
		const expectedAssets: Array<{ name: string; path: string }> = [
			...requiredPublicReleaseAssetNames
		]
			.sort()
			.map(name => ({
				name,
				path: name === path.basename(metadataPath)
					? '<metadata>'
					: `artifact-${requiredPublicReleaseAssetNames.indexOf(name)}/${name}`
			}));
		expectedAssets.push({ name: 'SHA256SUMS', path: '<checksums>' });
		const persistedManifest = JSON.parse(
			await fs.readFile(manifestPath, 'utf8')
		) as typeof manifest;
		const checksums = (await fs.readFile(checksumsPath, 'utf8'))
			.trimEnd()
			.split('\n')
			.map(line => line.replace(/^[a-f0-9]{64}/, '<sha256>'));

		assert.deepStrictEqual({
			manifest: normalizeManifest(manifest),
			persistedManifest: normalizeManifest(persistedManifest),
			checksums,
			privateReportIncluded: checksums.some(line => line.includes('private-report'))
		}, {
			manifest: { schemaVersion: 1, assets: expectedAssets },
			persistedManifest: { schemaVersion: 1, assets: expectedAssets },
			checksums: [...requiredPublicReleaseAssetNames]
				.sort()
				.map(name => `<sha256>  ${name}`),
			privateReportIncluded: false
		});
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
				checksumsPath,
				manifestPath
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
				checksumsPath,
				manifestPath
			),
			/Duplicate public release asset 'hucode-linux-arm64\.rpm'/
		);
	});

	test('accepts exactly the required remote release assets', () => {
		assert.doesNotThrow(() => validatePublishedReleaseAssetNames(
			requiredPublishedReleaseAssetNames
		));
	});

	test('rejects missing, unexpected, and duplicate remote assets', () => {
		assert.throws(
			() => validatePublishedReleaseAssetNames([
				...requiredPublishedReleaseAssetNames.slice(1),
				'SHA256SUMS',
				'unexpected.zip'
			]),
			error => {
				assert.deepStrictEqual(
					String(error),
					'Error: Remote release asset validation failed ' +
						'(missing: hucode-darwin-x64.dmg; unexpected: unexpected.zip; ' +
						'duplicates: SHA256SUMS).'
				);
				return true;
			}
		);
	});
});
