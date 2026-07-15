/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
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

const requiredPublicReleaseAssets = new Set<string>(
	requiredPublicReleaseAssetNames
);

async function listFiles(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files = await Promise.all(entries.map(async entry => {
		const entryPath = path.join(root, entry.name);
		return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
	}));
	return files.flat();
}

async function sha256(filePath: string): Promise<string> {
	const contents = await fs.readFile(filePath);
	return createHash('sha256').update(contents).digest('hex');
}

/**
 * Validates, flattens, and checksums the assets for a public GitHub Release.
 */
export async function preparePublicReleaseAssets(
	artifactsRoot: string,
	metadataPath: string,
	outputRoot: string
): Promise<string[]> {
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

	await fs.rm(outputRoot, { recursive: true, force: true });
	await fs.mkdir(outputRoot, { recursive: true });
	const outputFiles: string[] = [];
	for (const name of [...requiredPublicReleaseAssetNames].sort()) {
		const outputPath = path.join(outputRoot, name);
		await fs.copyFile(byName.get(name)!, outputPath);
		outputFiles.push(outputPath);
	}

	const checksums = await Promise.all(outputFiles.map(async filePath =>
		`${await sha256(filePath)}  ${path.basename(filePath)}`
	));
	const checksumsPath = path.join(outputRoot, CHECKSUMS_NAME);
	await fs.writeFile(checksumsPath, `${checksums.join('\n')}\n`);
	outputFiles.push(checksumsPath);

	return outputFiles;
}

function readOption(args: string[], option: string): string {
	const index = args.indexOf(option);
	if (index < 0 || !args[index + 1]) {
		throw new Error(`${option} is required.`);
	}
	return args[index + 1];
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	await preparePublicReleaseAssets(
		path.resolve(readOption(args, '--artifacts')),
		path.resolve(readOption(args, '--metadata')),
		path.resolve(readOption(args, '--out'))
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
