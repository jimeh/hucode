/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
const omniWebMain = 'src/vs/hucode/browser/omni.web.main.ts';

suite('Hucode Omni web entrypoint', () => {

	test('registers the create worktree command contribution', async () => {
		const imports = await readImportPaths(omniWebMain);
		assert.ok(imports.has(
			'src/vs/hucode/browser/projectSwitcher/' +
			'createProjectWorktree.contribution.js'
		));
	});

	test('registers the project rename command contribution', async () => {
		const imports = await readImportPaths(omniWebMain);
		assert.ok(imports.has(
			'src/vs/hucode/browser/projectSwitcher/' +
			'renameProjectWorktree.contribution.js'
		));
	});
});

/** Reads normalized static import paths from a repository entrypoint. */
async function readImportPaths(entrypoint: string): Promise<Set<string>> {
	const source = stripComments(
		await fs.readFile(path.join(repoRoot, entrypoint), 'utf8')
	);
	const importerDirectory = path.posix.dirname(entrypoint);
	const paths = new Set<string>();

	const importPattern = /\bimport\b[^'"()]*?['"](?<modulePath>[^'"]+)['"]/g;
	for (const match of source.matchAll(importPattern)) {
		const modulePath = match.groups!.modulePath;
		paths.add(
			modulePath.startsWith('.')
				? path.posix.normalize(
					path.posix.join(importerDirectory, modulePath)
				)
				: modulePath
		);
	}

	return paths;
}

/** Removes comments before static import parsing. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}
