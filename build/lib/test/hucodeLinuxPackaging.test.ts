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
const forbiddenPackageContent = [
	'packages.microsoft.com',
	'microsoft.gpg',
	'add-microsoft-repo',
	'apt-config',
	'trusted.gpg',
	'sources.list',
	'/etc/apt',
	'/etc/yum.repos.d',
	'baseurl=',
	'Visual Studio Code',
	'code.visualstudio.com',
	'vscode-linux@microsoft.com'
];

async function readMixinResource(relativePath: string): Promise<Buffer> {
	return fs.readFile(path.join(mixinRoot, relativePath));
}

function extractIcnsEntry(icns: Buffer, entryType: string): Buffer {
	for (let offset = 8; offset < icns.length;) {
		const type = icns.toString('ascii', offset, offset + 4);
		const length = icns.readUInt32BE(offset + 4);
		if (type === entryType) {
			return icns.subarray(offset + 8, offset + length);
		}
		offset += length;
	}
	throw new Error(`ICNS entry '${entryType}' was not found.`);
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
			assert.ok(stats.size > 0);
			assert.ok(
				packageBuild.includes(`'${relativePath}'`),
				`${relativePath} is not selected by Linux packaging.`
			);
		}

		assert.ok(electronBuild.includes(
			"gulp.src('resources/linux/code.png', { base: '.' })"
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

		for (const forbidden of forbiddenPackageContent) {
			assert.ok(
				!contents.toLowerCase().includes(forbidden.toLowerCase()),
				`Linux package resources contain '${forbidden}'.`
			);
		}
	});

	test('derives Linux icons from the tracked Hucode app icon', async () => {
		const icns = await readMixinResource('resources/darwin/code.icns');
		const png = await readMixinResource('resources/linux/code.png');
		const xpm = (
			await readMixinResource('resources/linux/rpm/code.xpm')
		).toString('utf8');

		assert.deepStrictEqual(png, extractIcnsEntry(icns, 'ic10'));
		assert.match(xpm, /^\/\* XPM \*\//);
		assert.match(xpm, /"1024 1024 17 1"/);
	});
});
