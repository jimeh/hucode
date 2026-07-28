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
		const known = new Set(
			builtinManifests().map(({ id }) => id.toLowerCase())
		);

		assert.deepStrictEqual(
			HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS.filter(
				id => !known.has(id.toLowerCase())
			),
			[]
		);
	});

	function eagerBuiltinExtensionIds(): string[] {
		return builtinManifests()
			.filter(({ manifest }) => {
				const events: unknown = manifest.activationEvents;
				return Array.isArray(events)
					&& events.some(e => e === '*' || e === 'onStartupFinished');
			})
			.map(({ id }) => id);
	}

	function builtinManifests(): { id: string; manifest: any }[] {
		const extensionsDir = path.join(repositoryRoot(), 'extensions');
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
