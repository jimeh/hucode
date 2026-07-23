/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { suite, test } from 'node:test';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { deriveLinuxIconAssets } from '../../hucode/generate-linux-icons.ts';
import {
	assertNoPackageSourceManagement,
	assertNoUpstreamIdentity
} from '../../hucode/validate-mixin.js';

const execFileAsync = promisify(execFile);

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
const linuxIdentityResourcePaths = [
	'resources/linux/code.appdata.xml',
	'resources/linux/code.desktop',
	'resources/linux/code-url-handler.desktop',
	'resources/linux/debian/control.template',
	'resources/linux/rpm/code.spec.template'
];
const forbiddenUpstreamIdentityFixtures = [
	'Visual Studio Code',
	'code.visualstudio.com',
	'vscode-linux@microsoft.com',
	'Microsoft',
	'Microsoft Corporation'
];
const packageSourceManagementFixtures = [
	['RPM key import', 'rpm --import https://packages.example/key.asc'],
	['RPM keys import', 'rpmkeys --import https://packages.example/key.asc'],
	['GPG dearmor', 'gpg --batch --dearmor < key.asc > key.gpg'],
	['armored key', '-----BEGIN PGP PUBLIC KEY BLOCK-----'],
	[
		'DNF repository',
		'dnf config-manager --add-repo https://packages.example/repo'
	],
	[
		'DNF repofile',
		'dnf config-manager addrepo --from-repofile=https://packages.example/repo.repo'
	],
	[
		'DNF repository enable',
		'dnf config-manager --set-enabled packages-example'
	],
	[
		'DNF repository option',
		'dnf config-manager setopt packages-example.enabled=1'
	],
	[
		'YUM repository',
		'yum-config-manager --add-repo https://packages.example/repo'
	],
	[
		'YUM repository disable',
		'yum-config-manager --disable packages-example'
	],
	[
		'YUM repository option',
		'yum-config-manager --save --setopt=packages-example.enabled=0'
	],
	[
		'ZYpp repository modification',
		'zypper modifyrepo --disable packages-example'
	],
	[
		'ZYpp repository removal',
		'zypper removerepo packages-example'
	],
	[
		'ZYpp repository rename',
		'zypper nr packages-example packages-renamed'
	],
	['APT source path', 'echo repo > /etc/apt/sources.list.d/example.list'],
	['YUM source path', 'echo repo > /etc/yum.repos.d/example.repo'],
	['ZYpp source path', 'echo repo > /etc/zypp/repos.d/example.repo'],
	['Deb822 signing key', 'Signed-By: /opt/example/key.gpg'],
	['RPM repository URL', 'baseurl=https://packages.example/rpm']
] as const;

/**
 * Reads a resource path relative to the stable mixin root.
 *
 * @returns The resource contents as a buffer.
 */
async function readMixinResource(relativePath: string): Promise<Buffer> {
	return fs.readFile(path.join(mixinRoot, relativePath));
}

/** Writes an executable shell stub that exits with the requested status. */
async function writeCommandStub(
	filePath: string,
	exitCode = 0
): Promise<void> {
	await fs.writeFile(filePath, `#!/bin/sh\nexit ${exitCode}\n`, {
		mode: 0o755
	});
}

/**
 * Creates isolated, rendered Debian maintainer scripts and command stubs.
 */
async function createDebianScriptHarness() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hucode-debian-'));
	const commandPath = path.join(root, 'usr', 'bin', 'hucode');
	const commandTarget = path.join(
		root,
		'usr',
		'share',
		'hucode',
		'bin',
		'hucode'
	);
	const stubRoot = path.join(root, 'stubs');
	const scriptRoot = path.join(root, 'scripts');
	await fs.mkdir(path.dirname(commandPath), { recursive: true });
	await fs.mkdir(path.dirname(commandTarget), { recursive: true });
	await fs.mkdir(stubRoot);
	await fs.mkdir(scriptRoot);
	await fs.writeFile(commandTarget, '#!/bin/sh\n', { mode: 0o755 });

	for (const command of [
		'update-alternatives',
		'update-desktop-database',
		'update-mime-database'
	]) {
		await writeCommandStub(path.join(stubRoot, command));
	}

	for (const name of ['postinst', 'postrm']) {
		const template = (
			await readMixinResource(`resources/linux/debian/${name}.template`)
		).toString('utf8');
		const rendered = template
			.replaceAll('/usr/bin/@@NAME@@', commandPath)
			.replaceAll('/usr/share/@@NAME@@/bin/@@NAME@@', commandTarget)
			.replaceAll('@@NAME@@', 'hucode');
		await fs.writeFile(path.join(scriptRoot, name), rendered, {
			mode: 0o755
		});
	}

	return {
		root,
		commandPath,
		commandTarget,
		stubRoot,
		run: (name: 'postinst' | 'postrm') => execFileAsync(
			'bash',
			[path.join(scriptRoot, name)],
			{ env: { ...process.env, PATH: `${stubRoot}:/usr/bin:/bin` } }
		)
	};
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
			[...debRpmBuild.matchAll(
				/['"](?<relativePath>resources\/linux\/[^'"]+)['"]/g
			)].map(match => match.groups!.relativePath)
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
		const contents = (
			await Promise.all(linuxIdentityResourcePaths.map(readMixinResource))
		).map(buffer => buffer.toString('utf8')).join('\n');

		assert.match(contents, /Maintainer: Hucode Project/);
		assert.match(contents, /Vendor:\s+Hucode Project/);
		assert.match(contents, /https:\/\/github\.com\/jimeh\/hucode/);
		assert.match(contents, /Hucode provides a focused desktop environment/);

		assertNoUpstreamIdentity(contents, 'Linux package identity resources');

		for (const relativePath of packageScriptPaths) {
			const script = (
				await readMixinResource(relativePath)
			).toString('utf8');
			assertNoPackageSourceManagement(script, relativePath);
		}
	});

	test('rejects upstream product identity', () => {
		for (const fixture of forbiddenUpstreamIdentityFixtures) {
			assert.throws(
				() => assertNoUpstreamIdentity(fixture, 'fixture'),
				{ name: 'AssertionError' }
			);
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

	test('protects the Debian command link and propagates failures', async () => {
		const harness = await createDebianScriptHarness();
		const unrelatedTarget = path.join(harness.root, 'unrelated');
		try {
			await fs.writeFile(harness.commandPath, 'administrator managed\n');
			await assert.rejects(harness.run('postinst'));
			assert.strictEqual(
				await fs.readFile(harness.commandPath, 'utf8'),
				'administrator managed\n'
			);

			await fs.rm(harness.commandPath);
			await fs.writeFile(unrelatedTarget, 'unrelated\n');
			await fs.symlink(unrelatedTarget, harness.commandPath);
			await assert.rejects(harness.run('postinst'));
			assert.strictEqual(
				await fs.readlink(harness.commandPath),
				unrelatedTarget
			);

			await fs.rm(harness.commandPath);
			await harness.run('postinst');
			await harness.run('postinst');
			assert.strictEqual(
				await fs.readlink(harness.commandPath),
				harness.commandTarget
			);
			await harness.run('postrm');
			await assert.rejects(fs.lstat(harness.commandPath), {
				code: 'ENOENT'
			});

			await fs.symlink(unrelatedTarget, harness.commandPath);
			await harness.run('postrm');
			assert.strictEqual(
				await fs.readlink(harness.commandPath),
				unrelatedTarget
			);
			await fs.rm(harness.commandPath);

			await writeCommandStub(path.join(harness.stubRoot, 'ln'), 23);
			await assert.rejects(harness.run('postinst'));
			await fs.rm(path.join(harness.stubRoot, 'ln'));

			await fs.symlink(harness.commandTarget, harness.commandPath);
			await writeCommandStub(path.join(harness.stubRoot, 'rm'), 23);
			await assert.rejects(harness.run('postrm'));
			assert.strictEqual(
				await fs.readlink(harness.commandPath),
				harness.commandTarget
			);
		} finally {
			await fs.rm(harness.root, { recursive: true, force: true });
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
