/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { suite, test } from 'node:test';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..'
);

suite('Hucode Omni web entrypoint', () => {

	test('registers the project rename command contribution', async () => {
		const source = await fs.readFile(
			path.join(repoRoot, 'src/vs/hucode/browser/omni.web.main.ts'),
			'utf8'
		);

		const renameContributionImport =
			"import './projectSwitcher/renameProjectWorktree.contribution.js';";
		assert.ok(source.split(/\r?\n/).includes(renameContributionImport));
	});
});
