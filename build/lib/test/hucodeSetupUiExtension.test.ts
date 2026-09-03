/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { suite, test } from 'node:test';
import path from 'path';
import { fileURLToPath } from 'url';
import { copyrightFilter, indentationFilter, tsFormattingFilter } from '../../filters.ts';
import { dirs } from '../../npm/dirs.ts';
import { GENERATED_PROTOCOL_PATH, renderGeneratedProtocol, CANONICAL_PROTOCOL_PATH } from '../../hucode/setup-ui-protocol.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const extensionDir = 'extensions/hucode-setup-ui';

async function readJson<T>(relative: string): Promise<T> {
	return JSON.parse(await fs.readFile(path.join(repoRoot, relative), 'utf8')) as T;
}

async function readText(relative: string): Promise<string> {
	return fs.readFile(path.join(repoRoot, relative), 'utf8');
}

suite('Hucode setup UI extension', () => {

	test('packages renderer assets only, with no runtime entry point or contributions', async () => {
		const manifest = await readJson<Record<string, unknown>>(`${extensionDir}/package.json`);
		for (const forbidden of ['main', 'browser', 'activationEvents', 'contributes', 'enabledApiProposals', 'extensionDependencies']) {
			assert.strictEqual(manifest[forbidden], undefined, `the asset-only extension must not declare ${forbidden}`);
		}
		assert.strictEqual(manifest.name, 'hucode-setup-ui');
		assert.strictEqual(manifest.publisher, 'hucode');
		assert.ok(manifest.engines, 'a built-in extension still needs an engines range');
	});

	test('registers its npm directory and its media build', async () => {
		assert.ok(dirs.includes(extensionDir), 'the isolated package must be installed by the repository task graph');
		const extensions = await readText('build/lib/extensions.ts');
		assert.match(extensions, /hucode-setup-ui\/esbuild\.setup\.mts/);
		assert.match(extensions, /hucode-setup-ui\/src\/tsconfig\.json/);
	});

	test('keeps the renderer out of src/vs and core out of the renderer', async () => {
		const sources = await listFiles(path.join(repoRoot, extensionDir, 'src'));
		for (const file of sources.filter(candidate => /\.tsx?$/.test(candidate))) {
			const contents = await fs.readFile(file, 'utf8');
			assert.doesNotMatch(contents, /from '.*src\/vs\//, `${file} must not import core sources`);
			assert.doesNotMatch(contents, /vs\/base\/|vs\/platform\/|vs\/workbench\//, `${file} must not reach into core layers`);
		}
	});

	test('never references a workbench theme variable from the renderer', async () => {
		const sources = await listFiles(path.join(repoRoot, extensionDir, 'src'));
		for (const file of sources.filter(candidate => /\.(tsx?|css)$/.test(candidate))) {
			assert.doesNotMatch(await fs.readFile(file, 'utf8'), /var\(--vscode-/, `${file} must not consume workbench theme variables`);
		}
	});

	test('keeps the tracked protocol mirror byte-identical to the canonical source', async () => {
		const canonical = await readText(CANONICAL_PROTOCOL_PATH);
		assert.strictEqual(await readText(GENERATED_PROTOCOL_PATH), renderGeneratedProtocol(canonical));
	});

	test('records every vendored shadcn file with the pinned generator', async () => {
		const manifestPath = `${extensionDir}/src/vendor/shadcn/vendor-manifest.json`;
		const manifest = await readJson<{ generatorVersion: string; style: string; base: string; iconLibrary: string; files: Record<string, string> }>(manifestPath);
		assert.strictEqual(manifest.style, 'radix-nova');
		assert.strictEqual(manifest.base, 'radix');
		assert.strictEqual(manifest.iconLibrary, 'lucide');
		assert.match(manifest.generatorVersion, /^\d+\.\d+\.\d+$/);

		const vendorDir = path.join(repoRoot, extensionDir, 'src', 'vendor', 'shadcn');
		const present = (await listFiles(vendorDir))
			.map(file => path.relative(vendorDir, file).split(path.sep).join('/'))
			.filter(file => file !== 'vendor-manifest.json')
			.sort();
		assert.deepStrictEqual(present, Object.keys(manifest.files).sort(), 'every vendored file is recorded, and nothing extra is');
		for (const [file, hash] of Object.entries(manifest.files)) {
			const actual = `sha256:${createHash('sha256').update(await fs.readFile(path.join(vendorDir, file))).digest('hex')}`;
			assert.strictEqual(actual, hash, `${file} differs from its recorded generation`);
		}
	});

	test('scopes hygiene exclusions to generated and vendored files only', async () => {
		for (const filter of [indentationFilter, copyrightFilter, tsFormattingFilter]) {
			const excluded = filter.filter(entry => entry.includes('hucode-setup-ui'));
			assert.ok(excluded.length, 'the generated output needs an explicit exclusion');
			for (const entry of excluded) {
				assert.ok(entry.startsWith('!'), `${entry} must be an exclusion, not an inclusion`);
				assert.match(entry, /hucode-setup-ui\/(media|src\/vendor\/shadcn|src\/generated)\//, `${entry} must not exclude application code`);
			}
		}
		const eslintIgnore = await readText('.eslint-ignore');
		assert.match(eslintIgnore, /extensions\/hucode-setup-ui\/src\/vendor\/shadcn\/\*\*/);
	});

	test('packages only the manifest, license, and built media', async () => {
		const ignored = (await readText(`${extensionDir}/.vscodeignore`)).split('\n').map(line => line.trim()).filter(Boolean);
		for (const excluded of ['src/**', 'components.json', 'esbuild.setup.mts', 'package-lock.json']) {
			assert.ok(ignored.includes(excluded), `${excluded} must not ship in the packaged extension`);
		}
		assert.strictEqual(ignored.includes('media/**'), false, 'the built renderer assets are the only thing this extension ships');
		const gitIgnore = await readText(`${extensionDir}/.gitignore`);
		assert.match(gitIgnore, /^media\/$/m, 'generated media stays untracked');
	});
});

async function listFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...await listFiles(full));
		} else {
			files.push(full);
		}
	}
	return files.sort();
}
