/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import type { ReadRepositoryFile } from '../../azure-pipelines/common/cacheKeys.ts';
import { computeHucodeNodeModulesCacheKey } from '../../hucode/node-modules-cache-key.ts';

/** Reads the given repository files, every other `package.json` as one that only pins pnpm, and other files as empty. */
function reader(files: Record<string, string> = {}): ReadRepositoryFile {
	return file => Buffer.from(files[file] ?? (file.endsWith('package.json') ? '{"packageManager":"pnpm@12.0.0"}' : ''));
}

suite('Hucode node_modules archive cache key', () => {
	test('covers what is installed and how it is built', () => {
		const args = ['hucode-linux', 'Linux', 'X64', 'x64'];
		const key = computeHucodeNodeModulesCacheKey(args, reader());
		const changes = (files: Record<string, string>, changedArgs = args) => computeHucodeNodeModulesCacheKey(changedArgs, reader(files)) !== key;
		assert.deepStrictEqual({
			rootLockfile: changes({ 'pnpm-lock.yaml': 'lockfileVersion: \'9.0\'' }),
			setupUiLockfile: changes({ 'extensions/hucode-setup-ui/pnpm-lock.yaml': 'lockfileVersion: \'9.0\'' }),
			nativeBuildHooks: changes({ '.pnpmfile.mjs': 'export const hooks = {};' }),
			pnpmSettings: changes({ 'remote/pnpm-workspace.yaml': 'nodeLinker: isolated' }),
			job: changes({}, ['hucode-release-build', 'Linux', 'X64', 'x64']),
			unrelatedFile: changes({ 'README.md': 'changed' }),
		}, {
			rootLockfile: true,
			setupUiLockfile: true,
			nativeBuildHooks: true,
			pnpmSettings: true,
			job: true,
			unrelatedFile: false,
		});
	});
});
