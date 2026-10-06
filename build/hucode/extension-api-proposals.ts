/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Syncs Microsoft's `extensionEnabledApiProposals` allowlist into Hucode.
 *
 * Built `stable` products clear the declared API proposals of every non-built-in extension that
 * `product.json#extensionEnabledApiProposals` does not list. Code OSS ships no such list, so
 * Microsoft extensions installed from OpenVSX (GitHub Pull Requests, Python, Jupyter, ...) fail
 * whenever they touch a proposed API. The list is copied verbatim from the Microsoft VS Code
 * release matching the upstream baseline, and `prepare-mixin.js` merges it into the generated
 * product configuration.
 *
 * Usage: `npm run hucode:sync-extension-api-proposals -- --product <Microsoft product.json>`
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Tracked allowlist merged into the generated product, relative to the repository root. */
export const EXTENSION_API_PROPOSALS_PATH = 'build/hucode/extension-api-proposals.json';

/** Contents of {@link EXTENSION_API_PROPOSALS_PATH}. */
export interface ExtensionApiProposals {
	/** The Microsoft VS Code release the allowlist was copied from. */
	readonly source: {
		readonly version: string;
		readonly commit: string;
	};
	readonly extensionEnabledApiProposals: Record<string, string[]>;
}

/**
 * Extracts the proposal allowlist from a Microsoft VS Code `product.json`.
 *
 * @param product Parsed `product.json` from a Microsoft VS Code stable release.
 * @param upstreamVersion The upstream `version` from Hucode's root `package.json`. The Microsoft
 * release must match it exactly, so the allowlist reflects the proposals of this baseline.
 */
export function extractExtensionApiProposals(product: unknown, upstreamVersion: string): ExtensionApiProposals {
	if (!product || typeof product !== 'object') {
		throw new Error('Microsoft product.json is not an object.');
	}
	const { version, commit, quality, extensionEnabledApiProposals: proposals } = product as Record<string, unknown>;
	if (quality !== 'stable') {
		throw new Error(`Expected a stable Microsoft product.json, got quality '${String(quality)}'.`);
	}
	if (version !== upstreamVersion) {
		throw new Error(`Microsoft product.json is VS Code ${String(version)}, but the upstream baseline is ${upstreamVersion}.`);
	}
	if (typeof commit !== 'string' || !commit) {
		throw new Error('Microsoft product.json has no commit.');
	}
	if (!proposals || typeof proposals !== 'object' || Array.isArray(proposals) || Object.keys(proposals).length === 0) {
		throw new Error('Microsoft product.json has no extensionEnabledApiProposals map.');
	}
	for (const [extensionId, names] of Object.entries(proposals)) {
		if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) {
			throw new Error(`extensionEnabledApiProposals['${extensionId}'] is not an array of proposal names.`);
		}
	}
	return {
		source: { version, commit },
		extensionEnabledApiProposals: proposals as Record<string, string[]>,
	};
}

async function main(): Promise<void> {
	const productIndex = process.argv.indexOf('--product');
	const productPath = productIndex === -1 ? undefined : process.argv[productIndex + 1];
	if (!productPath) {
		throw new Error('Usage: extension-api-proposals.ts --product <path to Microsoft VS Code product.json>');
	}
	const product = JSON.parse(await fs.readFile(productPath, 'utf8'));
	const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
	const proposals = extractExtensionApiProposals(product, version);
	await fs.writeFile(path.join(root, EXTENSION_API_PROPOSALS_PATH), `${JSON.stringify(proposals, null, '\t')}\n`, 'utf8');
	console.log(`Updated ${EXTENSION_API_PROPOSALS_PATH} from VS Code ${proposals.source.version} (${Object.keys(proposals.extensionEnabledApiProposals).length} extensions).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
