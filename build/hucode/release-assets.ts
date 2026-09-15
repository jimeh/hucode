/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CHECKSUMS_NAME = 'SHA256SUMS';

/** Public assets that every Hucode tag release must contain. */
export const requiredPublicReleaseAssetNames = [
	'hucode-darwin-x64.dmg',
	'hucode-darwin-x64.zip',
	'hucode-darwin-arm64.dmg',
	'hucode-darwin-arm64.zip',
	'hucode-linux-x64.zip',
	'hucode-linux-x64.deb',
	'hucode-linux-x64.rpm',
	'hucode-linux-arm64.zip',
	'hucode-linux-arm64.deb',
	'hucode-linux-arm64.rpm',
	'hucode-cli-darwin-x64.zip',
	'hucode-cli-darwin-arm64.zip',
	'hucode-cli-linux-x64.tar.gz',
	'hucode-cli-linux-arm64.tar.gz',
	'hucode-cli-win32-x64.zip',
	'hucode-cli-win32-arm64.zip',
	'hucode-server-darwin-x64-web.zip',
	'hucode-server-darwin-arm64-web.zip',
	'hucode-server-linux-x64-web.zip',
	'hucode-server-linux-arm64-web.zip',
	'hucode-server-win32-x64-web.zip',
	'hucode-server-win32-arm64-web.zip',
	'hucode-release-metadata.json'
] as const;

/** Names expected on the published GitHub Release. */
export const requiredPublishedReleaseAssetNames = [
	...requiredPublicReleaseAssetNames,
	CHECKSUMS_NAME
] as const;

const requiredPublicReleaseAssets = new Set<string>(
	requiredPublicReleaseAssetNames
);

/** One source file uploaded to the public GitHub Release. */
export interface IPublicReleaseAsset {
	readonly name: string;
	readonly path: string;
}

/** On-disk handoff from asset validation to the upload step. */
export interface IPublicReleaseAssetManifest {
	readonly schemaVersion: 1;
	readonly assets: readonly IPublicReleaseAsset[];
}

async function listFiles(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...await listFiles(entryPath));
		} else {
			files.push(entryPath);
		}
	}
	return files;
}

async function sha256(filePath: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) {
		hash.update(chunk);
	}
	return hash.digest('hex');
}

/**
 * Validates and checksums source assets without duplicating their payloads.
 */
export async function preparePublicReleaseAssets(
	artifactsRoot: string,
	metadataPath: string,
	checksumsPath: string,
	manifestPath: string
): Promise<IPublicReleaseAssetManifest> {
	const sourceFiles = [...await listFiles(artifactsRoot), metadataPath]
		.filter(filePath => requiredPublicReleaseAssets.has(path.basename(filePath)));
	const byName = new Map<string, string>();

	for (const sourceFile of sourceFiles) {
		const name = path.basename(sourceFile);
		const existing = byName.get(name);
		if (existing) {
			throw new Error(
				`Duplicate public release asset '${name}': ${existing}, ${sourceFile}`
			);
		}
		byName.set(name, sourceFile);
	}

	const missing = requiredPublicReleaseAssetNames.filter(name => !byName.has(name));
	if (missing.length) {
		throw new Error(
			`Missing required public release assets: ${missing.join(', ')}`
		);
	}

	const assets: IPublicReleaseAsset[] = [];
	const checksums: string[] = [];
	for (const name of [...requiredPublicReleaseAssetNames].sort()) {
		const sourcePath = path.resolve(byName.get(name)!);
		assets.push({ name, path: sourcePath });
		checksums.push(`${await sha256(sourcePath)}  ${name}`);
	}

	const resolvedChecksumsPath = path.resolve(checksumsPath);
	await fs.writeFile(resolvedChecksumsPath, `${checksums.join('\n')}\n`);
	assets.push({ name: CHECKSUMS_NAME, path: resolvedChecksumsPath });

	const manifest: IPublicReleaseAssetManifest = {
		schemaVersion: 1,
		assets
	};
	await fs.writeFile(
		manifestPath,
		`${JSON.stringify(manifest, null, 2)}\n`
	);
	return manifest;
}

/**
 * Verifies that a remote release exposes exactly the required public assets.
 */
export function validatePublishedReleaseAssetNames(
	actualNames: readonly string[]
): void {
	const expected = new Set<string>(requiredPublishedReleaseAssetNames);
	const actual = new Set<string>(actualNames);
	const missing = requiredPublishedReleaseAssetNames.filter(name => !actual.has(name));
	const unexpected = [...actual].filter(name => !expected.has(name)).sort();
	const duplicates = [...actual].filter(name =>
		actualNames.filter(actualName => actualName === name).length > 1
	).sort();

	if (missing.length || unexpected.length || duplicates.length) {
		const issues = [
			missing.length ? `missing: ${missing.join(', ')}` : undefined,
			unexpected.length ? `unexpected: ${unexpected.join(', ')}` : undefined,
			duplicates.length ? `duplicates: ${duplicates.join(', ')}` : undefined
		].filter((issue): issue is string => !!issue);
		throw new Error(`Remote release asset validation failed (${issues.join('; ')}).`);
	}
}

function readOption(args: string[], option: string): string {
	const index = args.indexOf(option);
	if (index < 0 || !args[index + 1]) {
		throw new Error(`${option} is required.`);
	}
	return args[index + 1];
}

async function readManifest(manifestPath: string): Promise<IPublicReleaseAssetManifest> {
	return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	switch (command) {
		case 'prepare':
			await preparePublicReleaseAssets(
				path.resolve(readOption(args, '--artifacts')),
				path.resolve(readOption(args, '--metadata')),
				path.resolve(readOption(args, '--checksums')),
				path.resolve(readOption(args, '--manifest'))
			);
			return;
		case 'print-paths': {
			const manifest = await readManifest(
				path.resolve(readOption(args, '--manifest'))
			);
			for (const asset of manifest.assets) {
				process.stdout.write(`${asset.path}\0`);
			}
			return;
		}
		case 'verify': {
			const actualNames = JSON.parse(await fs.readFile(
				path.resolve(readOption(args, '--assets-json')),
				'utf8'
			));
			if (!Array.isArray(actualNames) ||
				actualNames.some(name => typeof name !== 'string')) {
				throw new Error('Remote release assets JSON must be an array of names.');
			}
			validatePublishedReleaseAssetNames(actualNames);
			return;
		}
		default:
			throw new Error(`Unknown command '${command ?? ''}'.`);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
