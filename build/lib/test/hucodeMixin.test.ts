/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { prepareMixin } from '../../hucode/prepare-mixin.js';
import { validateMixin } from '../../hucode/validate-mixin.js';

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..'
);

async function readJson(filePath: string): Promise<any> {
	return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

suite('Hucode mixin', () => {

	test('prepares a stable mixin without mutating root product.json', async () => {
		const rootProductPath = path.join(repoRoot, 'product.json');
		const rootBefore = await fs.readFile(rootProductPath, 'utf8');

		const outputProductPath = await prepareMixin('stable');
		await validateMixin('stable');

		const rootAfter = await fs.readFile(rootProductPath, 'utf8');
		assert.strictEqual(rootAfter, rootBefore);

		const generated = await readJson(outputProductPath);
		assert.strictEqual(generated.nameShort, 'Hucode');
		assert.strictEqual(generated.applicationName, 'hucode');
		assert.strictEqual(generated.urlProtocol, 'hucode');
		assert.strictEqual(generated.darwinBundleIdentifier, 'dev.hucode.app');
		assert.strictEqual(generated.win32AppUserModelId, 'dev.hucode.app');
		assert.strictEqual(generated.embedderIdentifier, 'dev.hucode.app');
		assert.strictEqual(
			generated.extensionsGallery.serviceUrl,
			'https://open-vsx.org/vscode/gallery'
		);
		assert.ok(Array.isArray(generated.builtInExtensions));
		assert.ok(generated.builtInExtensions.length > 0);
		assert.ok(generated.defaultChatAgent);
		assert.strictEqual(
			generated.defaultChatAgent.chatExtensionId,
			'GitHub.copilot-chat'
		);
		assert.ok(generated.trustedExtensionAuthAccess);
	});
});
