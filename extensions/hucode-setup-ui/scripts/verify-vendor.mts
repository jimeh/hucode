/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Verifies the vendored shadcn source against its recorded manifest.
 *
 * Generated component source is not hand-edited and not reformatted, so any difference means
 * either an unreviewed local change or an upgrade that has to be regenerated with the pinned CLI
 * and re-recorded. `--write` re-records after a deliberate regeneration.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VENDOR_DIR = path.join(packageDir, 'src', 'vendor', 'shadcn');
export const MANIFEST_PATH = path.join(VENDOR_DIR, 'vendor-manifest.json');

export interface VendorManifest {
	readonly generator: string;
	readonly generatorVersion: string;
	readonly style: string;
	readonly base: string;
	readonly iconLibrary: string;
	readonly components: readonly string[];
	readonly files: Readonly<Record<string, string>>;
}

async function listVendorFiles(dir: string, prefix = ''): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...await listVendorFiles(path.join(dir, entry.name), relative));
		} else if (relative !== 'vendor-manifest.json') {
			files.push(relative);
		}
	}
	return files.sort();
}

async function hashFile(relative: string): Promise<string> {
	return `sha256:${createHash('sha256').update(await fs.readFile(path.join(VENDOR_DIR, relative))).digest('hex')}`;
}

export interface VendorVerification {
	readonly manifest: VendorManifest;
	readonly missing: readonly string[];
	readonly untracked: readonly string[];
	readonly modified: readonly string[];
}

export async function verifyVendoredComponents(): Promise<VendorVerification> {
	const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8')) as VendorManifest;
	const present = await listVendorFiles(VENDOR_DIR);
	const recorded = Object.keys(manifest.files).sort();
	const missing = recorded.filter(file => !present.includes(file));
	const untracked = present.filter(file => !recorded.includes(file));
	const modified: string[] = [];
	for (const file of recorded) {
		if (missing.includes(file)) {
			continue;
		}
		if (await hashFile(file) !== manifest.files[file]) {
			modified.push(file);
		}
	}
	return { manifest, missing, untracked, modified };
}

async function rewriteManifest(): Promise<void> {
	const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8')) as VendorManifest;
	const present = await listVendorFiles(VENDOR_DIR);
	const files: Record<string, string> = {};
	for (const file of present) {
		files[file] = await hashFile(file);
	}
	await fs.writeFile(MANIFEST_PATH, `${JSON.stringify({ ...manifest, files }, undefined, 2)}\n`, 'utf8');
	console.log(`Recorded ${present.length} vendored files.`);
}

async function main(): Promise<void> {
	if (process.argv.includes('--write')) {
		await rewriteManifest();
		return;
	}
	const { manifest, missing, untracked, modified } = await verifyVendoredComponents();
	if (!missing.length && !untracked.length && !modified.length) {
		console.log(`Verified ${Object.keys(manifest.files).length} vendored shadcn files against ${manifest.generator}@${manifest.generatorVersion}.`);
		return;
	}
	for (const [label, files] of [['missing', missing], ['untracked', untracked], ['modified', modified]] as const) {
		if (files.length) {
			console.error(`Vendored shadcn files ${label}: ${files.join(', ')}`);
		}
	}
	console.error(
		`Regenerate with \`npx shadcn@${manifest.generatorVersion} add <component> --overwrite\` and re-record with`
		+ ' `node extensions/hucode-setup-ui/scripts/verify-vendor.mts --write`.'
	);
	process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
