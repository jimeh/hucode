/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { suite, test } from 'node:test';
import path from 'path';
import { fileURLToPath } from 'url';
import { deriveLinuxIconAssets } from '../../hucode/generate-linux-icons.ts';
import { assertNoPackageSourceManagement } from '../../hucode/validate-mixin.js';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..'
);
const mixinRoot = path.join(repoRoot, 'build', 'hucode', 'mixin', 'stable');
const linuxResourcePaths = [
	'resources/linux/code.appdata.xml',
	'resources/linux/code.desktop',
	'resources/linux/code-url-handler.desktop',
	'resources/linux/code.png',
	'resources/linux/debian/control.template',
	'resources/linux/debian/postinst.template',
	'resources/linux/debian/postrm.template',
	'resources/linux/debian/prerm.template',
	'resources/linux/debian/templates.template',
	'resources/linux/rpm/code.spec.template',
	'resources/linux/rpm/code.xpm'
];
const intentionallyEmptyLinuxResourcePaths = new Set([
	'resources/linux/debian/templates.template'
]);
const packageScriptPaths = [
	'resources/linux/debian/postinst.template',
	'resources/linux/debian/postrm.template',
	'resources/linux/debian/prerm.template',
	'resources/linux/debian/templates.template',
	'resources/linux/rpm/code.spec.template'
];
const vettedUpstreamLinuxPackageResources = new Set([
	'resources/linux/code-workspace.xml'
]);
const forbiddenUpstreamIdentity = [
	'Visual Studio Code',
	'code.visualstudio.com',
	'vscode-linux@microsoft.com'
];
const packageSourceManagementFixtures = [
	['RPM key import', 'rpm --import https://packages.example/key.asc'],
	['GPG dearmor', 'gpg --batch --dearmor < key.asc > key.gpg'],
	['armored key', '-----BEGIN PGP PUBLIC KEY BLOCK-----'],
	[
		'DNF repository',
		'dnf config-manager --add-repo https://packages.example/repo'
	],
	[
		'YUM repository',
		'yum-config-manager --add-repo https://packages.example/repo'
	],
	['APT source path', 'echo repo > /etc/apt/sources.list.d/example.list'],
	['YUM source path', 'echo repo > /etc/yum.repos.d/example.repo'],
	['ZYpp source path', 'echo repo > /etc/zypp/repos.d/example.repo'],
	['Deb822 signing key', 'Signed-By: /opt/example/key.gpg'],
	['RPM repository URL', 'baseurl=https://packages.example/rpm']
] as const;

async function readMixinResource(relativePath: string): Promise<Buffer> {
	return fs.readFile(path.join(mixinRoot, relativePath));
}

suite('Hucode Linux packaging', () => {

	test('selects stable mixin resources for Linux apps and packages', async () => {
		const packageBuild = await fs.readFile(
			path.join(repoRoot, 'build/gulpfile.vscode.linux.ts'),
			'utf8'
		);
		const electronBuild = await fs.readFile(
			path.join(repoRoot, 'build/gulpfile.vscode.ts'),
			'utf8'
		);

		for (const relativePath of linuxResourcePaths) {
			const stats = await fs.stat(path.join(mixinRoot, relativePath));
			assert.ok(stats.isFile());
			if (intentionallyEmptyLinuxResourcePaths.has(relativePath)) {
				assert.strictEqual(stats.size, 0);
			} else {
				assert.ok(stats.size > 0);
			}
			assert.ok(
				packageBuild.includes(`'${relativePath}'`),
				'Linux package resource is not selected by packaging.'
			);
		}

		const snapStart = packageBuild.indexOf('function getSnapBuildPath');
		assert.notStrictEqual(snapStart, -1);
		const debRpmBuild = packageBuild.slice(0, snapStart);
		const referencedResources = new Set(
			[...debRpmBuild.matchAll(/['"](resources\/linux\/[^'"]+)['"]/g)]
				.map(match => match[1])
		);
		for (const relativePath of referencedResources) {
			assert.ok(
				linuxResourcePaths.includes(relativePath) ||
					vettedUpstreamLinuxPackageResources.has(relativePath),
				'Linux package resource needs a mixin override or safe allowlist.'
			);
		}
		assert.deepStrictEqual(
			[...referencedResources]
				.filter(path => !linuxResourcePaths.includes(path))
				.sort(),
			[...vettedUpstreamLinuxPackageResources].sort()
		);

		assert.ok(electronBuild.includes(
			'gulp.src(\'resources/linux/code.png\', { base: \'.\' })'
		));
	});

	test('contains Hucode identity without package source management', async () => {
		const textPaths = linuxResourcePaths.filter(
			relativePath => !relativePath.endsWith('.png') &&
				!relativePath.endsWith('.xpm')
		);
		const contents = (
			await Promise.all(textPaths.map(readMixinResource))
		).map(buffer => buffer.toString('utf8')).join('\n');

		assert.match(contents, /Maintainer: Hucode Project/);
		assert.match(contents, /Vendor:\s+Hucode Project/);
		assert.match(contents, /https:\/\/github\.com\/jimeh\/hucode/);
		assert.match(contents, /Hucode provides a focused desktop environment/);

		for (const forbidden of forbiddenUpstreamIdentity) {
			assert.ok(
				!contents.toLowerCase().includes(forbidden.toLowerCase()),
				'Linux package resources contain upstream product identity.'
			);
		}

		for (const relativePath of packageScriptPaths) {
			const script = (
				await readMixinResource(relativePath)
			).toString('utf8');
			assert.doesNotThrow(() => {
				assertNoPackageSourceManagement(script, relativePath);
			});
		}
	});

	test('rejects package source and key management mechanisms', () => {
		for (const [label, fixture] of packageSourceManagementFixtures) {
			assert.throws(
				() => assertNoPackageSourceManagement(fixture, label),
				{ name: 'AssertionError' }
			);
		}
	});

	test('derives Linux icons from the tracked Hucode app icon', async () => {
		const icns = await readMixinResource('resources/darwin/code.icns');
		const png = await readMixinResource('resources/linux/code.png');
		const xpm = (
			await readMixinResource('resources/linux/rpm/code.xpm')
		).toString('utf8');
		const derived = deriveLinuxIconAssets(icns);

		assert.deepStrictEqual(png, derived.png);
		assert.strictEqual(xpm, derived.xpm);
	});
});
