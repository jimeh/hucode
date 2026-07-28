/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from '../../../../../base/common/path.js';
import { fileURLToPath } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../../base/test/common/utils.js';
import {
	HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS,
	hucodeIsOmniShellSkippedBuiltinId,
} from '../../common/hucodeExtensionEnablementPolicy.js';

/**
 * The skip list was first seeded by hand and missed `vscode.git-base`, which
 * activates on `*`. Nothing would have reported that: a list can only be
 * checked against itself. This derives the requirement from the manifests
 * instead, so an upstream release that adds an eagerly activating built-in, or
 * flips an existing one to `onStartupFinished`, fails here rather than quietly
 * costing the shell another startup.
 *
 * A built-in the shell genuinely wants is a legitimate reason for this to
 * fail. Add it to `intentionallyEagerInShell` with a note, rather than
 * loosening the check.
 */
suite('HucodeOmniEagerBuiltins', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const intentionallyEagerInShell = new Set<string>([]);

	/**
	 * Downloaded built-ins, pinned. Their manifests live under
	 * `.build/builtInExtensions`, which exists only after the download step and
	 * so is absent wherever unit tests run without it — scanning them alone
	 * would pass vacuously there. Pinning the inventory means adding one fails
	 * here instead, and whoever adds it has to check whether it activates on
	 * `*` or `onStartupFinished` and skip it if so. None of these three do.
	 */
	const knownDownloadedBuiltins = [
		'ms-vscode.js-debug-companion',
		'ms-vscode.js-debug',
		'ms-vscode.vscode-js-profile-table',
	];

	test('every eagerly activating built-in is skipped in the shell', () => {
		const eager = eagerBuiltinExtensionIds();

		// Guards against the glob silently matching nothing, which would make
		// the assertion below vacuous.
		assert.ok(
			eager.length >= 5,
			`only found ${eager.length} eagerly activating built-ins, expected the manifest scan to find several`
		);

		assert.deepStrictEqual(
			eager.filter(id =>
				!hucodeIsOmniShellSkippedBuiltinId(id)
				&& !intentionallyEagerInShell.has(id.toLowerCase())
			),
			[]
		);
	});

	test('the skip list carries no built-in that no longer exists', () => {
		// "Built-in" is both the bundled directories and the ones product.json
		// has downloaded. Nothing on the skip list arrives the second way
		// today, but GitHub.copilot-chat is bundled only because this fork
		// ships extensions/copilot; if it ever became a downloaded built-in,
		// checking directories alone would fail here for the wrong reason.
		const known = new Set([
			...builtinManifests().map(({ id }) => id.toLowerCase()),
			...downloadedBuiltinExtensionIds().map(id => id.toLowerCase()),
		]);

		assert.deepStrictEqual(
			HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS.filter(
				id => !known.has(id.toLowerCase())
			),
			[]
		);
	});

	test('the downloaded built-in inventory has not changed', () => {
		assert.deepStrictEqual(
			downloadedBuiltinExtensionIds(),
			knownDownloadedBuiltins
		);
	});

	test('any downloaded built-in present on disk is skipped if eager', () => {
		// Real coverage where the download step has run; the pinned inventory
		// is what holds where it has not.
		const downloadedDir = path.join(
			repositoryRoot(), '.build', 'builtInExtensions'
		);
		if (!fs.existsSync(downloadedDir)) {
			return;
		}

		const eager = manifestsIn(downloadedDir)
			.filter(({ manifest }) => activatesEagerly(manifest))
			.map(({ id }) => id);

		assert.deepStrictEqual(
			eager.filter(id =>
				!hucodeIsOmniShellSkippedBuiltinId(id)
				&& !intentionallyEagerInShell.has(id.toLowerCase())
			),
			[]
		);
	});

	function eagerBuiltinExtensionIds(): string[] {
		return builtinManifests()
			.filter(({ manifest }) => activatesEagerly(manifest))
			.map(({ id }) => id);
	}

	function activatesEagerly(manifest: any): boolean {
		const events: unknown = manifest.activationEvents;
		return Array.isArray(events)
			&& events.some(e => e === '*' || e === 'onStartupFinished');
	}

	function downloadedBuiltinExtensionIds(): string[] {
		const product = JSON.parse(
			fs.readFileSync(path.join(repositoryRoot(), 'product.json'), 'utf8')
		);

		return (product.builtInExtensions ?? [])
			.map((extension: { name?: string }) => extension.name)
			.filter((name: string | undefined): name is string => !!name);
	}

	function builtinManifests(): { id: string; manifest: any }[] {
		return manifestsIn(path.join(repositoryRoot(), 'extensions'));
	}

	function manifestsIn(extensionsDir: string): { id: string; manifest: any }[] {
		const result: { id: string; manifest: any }[] = [];

		for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) {
				continue;
			}

			const manifestPath = path.join(extensionsDir, entry.name, 'package.json');
			if (!fs.existsSync(manifestPath)) {
				continue;
			}

			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			if (!manifest.name) {
				continue;
			}

			result.push({
				id: `${manifest.publisher ?? 'vscode'}.${manifest.name}`,
				manifest,
			});
		}

		return result;
	}

	// Walks up from the compiled test rather than trusting the runner's cwd,
	// which differs between the node and Electron runners.
	function repositoryRoot(): string {
		let dir = path.dirname(fileURLToPath(import.meta.url));

		while (dir !== path.dirname(dir)) {
			if (
				fs.existsSync(path.join(dir, 'extensions'))
				&& fs.existsSync(path.join(dir, 'package.json'))
			) {
				return dir;
			}
			dir = path.dirname(dir);
		}

		throw new Error('could not locate the repository root from the test file');
	}
});
