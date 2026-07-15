/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const linuxResources = [
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
const packageSourcePatterns = [
	/packages\.microsoft\.com/i,
	/microsoft\.gpg/i,
	/add-microsoft-repo/i,
	/apt-config/i,
	/trusted\.gpg/i,
	/sources\.list/i,
	/\/etc\/apt/i,
	/\/etc\/yum\.repos\.d/i,
	/baseurl\s*=/i
];
const upstreamIdentityPatterns = [
	/Visual Studio Code/i,
	/code\.visualstudio\.com/i,
	/vscode-linux@microsoft\.com/i
];

function parseQuality(args) {
	const qualityIndex = args.indexOf('--quality');
	if (qualityIndex === -1) {
		return 'stable';
	}

	const quality = args[qualityIndex + 1];
	if (!quality) {
		throw new Error('Missing quality after --quality.');
	}

	return quality;
}

async function readJson(filePath) {
	return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function assertFileExists(filePath) {
	const stats = await fs.stat(filePath);
	assert.ok(stats.isFile(), `${filePath} is not a file.`);
	assert.ok(stats.size > 0, `${filePath} is empty.`);
}

async function readTextFile(root, relativePath) {
	return fs.readFile(path.join(root, relativePath), 'utf8');
}

function assertPatternsAbsent(contents, patterns, label) {
	for (const pattern of patterns) {
		assert.ok(!pattern.test(contents), `${label} contains ${pattern}.`);
	}
}

async function validateLinuxResources(generatedRoot) {
	for (const relativePath of linuxResources) {
		await assertFileExists(path.join(generatedRoot, relativePath));
	}

	const appdata = await readTextFile(
		generatedRoot,
		'resources/linux/code.appdata.xml'
	);
	const desktop = await readTextFile(
		generatedRoot,
		'resources/linux/code.desktop'
	);
	const urlHandler = await readTextFile(
		generatedRoot,
		'resources/linux/code-url-handler.desktop'
	);
	const control = await readTextFile(
		generatedRoot,
		'resources/linux/debian/control.template'
	);
	const rpmSpec = await readTextFile(
		generatedRoot,
		'resources/linux/rpm/code.spec.template'
	);

	assert.match(appdata, /https:\/\/github\.com\/jimeh\/hucode/);
	assert.match(appdata, /<id>dev\.hucode\.app<\/id>/);
	assert.match(appdata, /Hucode provides a focused desktop environment/);
	assert.match(desktop, /^Keywords=hucode;/m);
	assert.match(desktop, /^Icon=@@ICON@@$/m);
	assert.match(urlHandler, /^MimeType=x-scheme-handler\/@@URLPROTOCOL@@;$/m);
	assert.match(control, /^Maintainer: Hucode Project <contact@jimeh\.me>$/m);
	assert.match(control, /^Homepage: https:\/\/github\.com\/jimeh\/hucode$/m);
	assert.match(rpmSpec, /^Vendor:\s+Hucode Project$/m);
	assert.match(rpmSpec, /^Packager: Hucode Project <contact@jimeh\.me>$/m);
	assert.match(rpmSpec, /^URL:\s+https:\/\/github\.com\/jimeh\/hucode$/m);

	const textResources = linuxResources.filter(
		path => !path.endsWith('.png') && !path.endsWith('.xpm')
	);
	for (const relativePath of textResources) {
		const contents = await readTextFile(generatedRoot, relativePath);
		assertPatternsAbsent(contents, upstreamIdentityPatterns, relativePath);
	}

	const packageScripts = [
		'resources/linux/debian/postinst.template',
		'resources/linux/debian/postrm.template',
		'resources/linux/debian/prerm.template',
		'resources/linux/debian/templates.template',
		'resources/linux/rpm/code.spec.template'
	];
	for (const relativePath of packageScripts) {
		const contents = await readTextFile(generatedRoot, relativePath);
		assertPatternsAbsent(contents, packageSourcePatterns, relativePath);
	}

	const png = await fs.readFile(
		path.join(generatedRoot, 'resources/linux/code.png')
	);
	assert.strictEqual(png.toString('hex', 0, 8), '89504e470d0a1a0a');
	assert.strictEqual(png.readUInt32BE(16), 1024);
	assert.strictEqual(png.readUInt32BE(20), 1024);

	const xpm = await readTextFile(
		generatedRoot,
		'resources/linux/rpm/code.xpm'
	);
	assert.match(xpm, /^\/\* XPM \*\//);
	assert.match(xpm, /"1024 1024 17 1"/);
}

/**
 * Validates the generated product mixin output.
 *
 * @param {string} quality
 */
export async function validateMixin(quality = 'stable') {
	const generatedPath = path.join(
		repoRoot,
		'.build',
		'distro',
		'mixin',
		quality,
		'product.json'
	);
	const generated = await readJson(generatedPath);
	const rootProduct = await readJson(path.join(repoRoot, 'product.json'));
	const sourceProduct = await readJson(
		path.join(repoRoot, 'build', 'hucode', 'mixin', quality, 'product.json')
	);
	const generatedRoot = path.dirname(generatedPath);
	const generatedWebManifest = await readJson(
		path.join(generatedRoot, 'resources', 'server', 'manifest.json')
	);

	assert.strictEqual(generated.nameShort, 'Hucode');
	assert.strictEqual(generated.nameLong, 'Hucode');
	assert.strictEqual(generated.hucodeVersion, sourceProduct.hucodeVersion);
	assert.strictEqual(
		generated.hucodeReleaseNotesUrlTemplate,
		'https://updates.hucode.dev/release-notes/{version}.md'
	);
	assert.strictEqual(generated.quality, 'stable');
	assert.strictEqual(generated.updateUrl, 'https://updates.hucode.dev');
	assert.strictEqual(
		generated.downloadUrl,
		'https://github.com/jimeh/hucode/releases/latest'
	);
	assert.strictEqual(
		generated.releaseNotesUrl,
		'https://github.com/jimeh/hucode/releases/latest'
	);
	assert.strictEqual(generated.applicationName, 'hucode');
	assert.strictEqual(generated.dataFolderName, '.hucode');
	assert.strictEqual(generated.sharedDataFolderName, '.hucode-shared');
	assert.strictEqual(generated.serverApplicationName, 'hucode-server');
	assert.strictEqual(generated.serverDataFolderName, '.hucode-server');
	assert.strictEqual(generated.tunnelApplicationName, 'hucode-tunnel');
	assert.deepStrictEqual(generated.tunnelServerQualities, {
		stable: {
			serverApplicationName: 'hucode-server'
		}
	});
	assert.strictEqual(generated.urlProtocol, 'hucode');
	assert.strictEqual(generated.win32MutexName, 'hucode');
	assert.strictEqual(generated.win32TunnelServiceMutex, 'hucode-tunnelservice');
	assert.strictEqual(generated.win32TunnelMutex, 'hucode-tunnel');
	assert.strictEqual(generated.darwinBundleIdentifier, 'dev.hucode.app');
	assert.strictEqual(generated.darwinDmgTitle, 'Hucode');
	assert.strictEqual(generated.darwinAssetsCar, 'resources/darwin/Assets.car');
	assert.strictEqual(generated.win32AppUserModelId, 'dev.hucode.app');
	assert.deepStrictEqual(
		generated.win32ContextMenu,
		sourceProduct.win32ContextMenu
	);
	assert.strictEqual(generated.embedderIdentifier, 'dev.hucode.app');
	assert.strictEqual(generated.linuxIconName, 'hucode');
	assert.strictEqual(
		generated.extensionsGallery.serviceUrl,
		'https://open-vsx.org/vscode/gallery'
	);
	assert.ok(Array.isArray(generated.builtInExtensions));
	assert.ok(generated.defaultChatAgent);
	assert.strictEqual(
		generated.defaultChatAgent.chatExtensionId,
		'GitHub.copilot-chat'
	);
	assert.ok(generated.trustedExtensionAuthAccess);
	assert.strictEqual(rootProduct.nameShort, 'Code - OSS');
	assert.strictEqual(rootProduct.applicationName, 'code-oss');
	assert.strictEqual(rootProduct.dataFolderName, '.vscode-oss');
	assert.strictEqual(rootProduct.sharedDataFolderName, '.vscode-oss-shared');
	assert.strictEqual(rootProduct.serverApplicationName, 'code-server-oss');
	assert.strictEqual(rootProduct.tunnelApplicationName, 'code-tunnel-oss');
	assert.strictEqual(rootProduct.urlProtocol, 'code-oss');
	assert.strictEqual(generatedWebManifest.name, 'Hucode');
	assert.strictEqual(generatedWebManifest.short_name, 'Hucode');
	await assertFileExists(
		path.join(generatedRoot, 'resources', 'darwin', 'code.icns')
	);
	await assertFileExists(
		path.join(generatedRoot, 'resources', 'darwin', 'Assets.car')
	);
	await assertFileExists(
		path.join(
			generatedRoot,
			'src',
			'vs',
			'workbench',
			'browser',
			'media',
			'code-icon.svg'
		)
	);
	await assertFileExists(
		path.join(generatedRoot, 'resources', 'server', 'favicon.ico')
	);
	await assertFileExists(
		path.join(generatedRoot, 'resources', 'server', 'code-192.png')
	);
	await assertFileExists(
		path.join(generatedRoot, 'resources', 'server', 'code-512.png')
	);
	await validateLinuxResources(generatedRoot);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await validateMixin(parseQuality(process.argv.slice(2)));
}
