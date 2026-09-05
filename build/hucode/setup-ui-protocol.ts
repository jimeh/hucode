/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Copies the canonical setup webview protocol into the isolated renderer package.
 *
 * The renderer must not import from `src/vs/**`, so it compiles a tracked byte-for-byte mirror
 * instead. The copy runs before the renderer's type check and bundle, and `--check` fails a build
 * or a pull request when the mirror has drifted from the canonical source.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Canonical protocol module, relative to the repository root. */
export const CANONICAL_PROTOCOL_PATH = 'src/vs/hucode/common/migration/editorMigrationSetupProtocol.ts';

/** Tracked mirror the renderer compiles, relative to the repository root. */
export const GENERATED_PROTOCOL_PATH = 'extensions/hucode-setup-ui/src/generated/editorMigrationSetupProtocol.ts';

/**
 * Exact contents the mirror must have for the given canonical source.
 *
 * The mirror is a literal copy. No banner is prepended, because both the plan and the agent
 * instructions promise byte-for-byte identity, and a banner would make the two files differ by
 * exactly the thing the drift check exists to detect. The canonical module's own header already
 * states that it is mirrored and where.
 */
export function renderGeneratedProtocol(canonical: string): string {
	return canonical;
}

export interface SyncResult {
	readonly changed: boolean;
	readonly expected: string;
	readonly actual: string | undefined;
}

export async function syncSetupUiProtocol(options: { readonly check: boolean; readonly cwd?: string }): Promise<SyncResult> {
	const base = options.cwd ?? root;
	const canonical = await fs.readFile(path.join(base, CANONICAL_PROTOCOL_PATH), 'utf8');
	const expected = renderGeneratedProtocol(canonical);
	const target = path.join(base, GENERATED_PROTOCOL_PATH);
	const actual = await fs.readFile(target, 'utf8').catch(() => undefined);
	if (actual === expected) {
		return { changed: false, expected, actual };
	}
	if (!options.check) {
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, expected, 'utf8');
	}
	return { changed: true, expected, actual };
}

async function main(): Promise<void> {
	const check = process.argv.includes('--check');
	const result = await syncSetupUiProtocol({ check });
	if (!result.changed) {
		return;
	}
	if (check) {
		console.error(
			`${GENERATED_PROTOCOL_PATH} has drifted from ${CANONICAL_PROTOCOL_PATH}.\n`
			+ 'Run `npm run hucode:sync-setup-protocol` and commit the result.'
		);
		process.exitCode = 1;
		return;
	}
	console.log(`Updated ${GENERATED_PROTOCOL_PATH}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
