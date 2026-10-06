/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import path from 'path';
import { suite, test } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const simulationCacheDirectory = 'extensions/copilot/test/simulation/cache';

suite('Hucode Copilot simulation cache', () => {
	test('tracks no simulation cache files', () => {
		// Upstream stores these caches as Git LFS objects and adds new layers in
		// most releases. Hucode does not carry them, and a replayed deletion only
		// removes the files it already knew about, so new upstream layers must be
		// deleted during each baseline upgrade.
		const tracked = execFileSync('git', ['ls-files', '-z', '--', simulationCacheDirectory], {
			cwd: repositoryRoot,
			encoding: 'utf8',
		}).split('\0').filter(Boolean);

		assert.deepStrictEqual(tracked, []);
	});
});
