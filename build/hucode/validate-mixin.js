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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await validateMixin(parseQuality(process.argv.slice(2)));
}
