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

	assert.strictEqual(generated.nameShort, 'Hucode');
	assert.strictEqual(generated.hucodeVersion, '0.0.5');
	assert.strictEqual(generated.applicationName, 'hucode');
	assert.strictEqual(generated.dataFolderName, '.hucode');
	assert.strictEqual(generated.urlProtocol, 'hucode');
	assert.strictEqual(generated.darwinBundleIdentifier, 'dev.hucode.app');
	assert.strictEqual(generated.darwinAssetsCar, 'resources/darwin/Assets.car');
	assert.strictEqual(generated.win32AppUserModelId, 'dev.hucode.app');
	assert.strictEqual(generated.embedderIdentifier, 'dev.hucode.app');
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await validateMixin(parseQuality(process.argv.slice(2)));
}
