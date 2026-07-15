/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { afterEach, beforeEach, suite, test } from 'node:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
	verifyServerWebSignatureVerifier
} from '../../hucode/server-web-verifier.ts';

suite('Hucode server-web signature verifier', () => {

	let serverRoot: string;

	beforeEach(async () => {
		serverRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), 'hucode-server-web-')
		);
	});

	afterEach(async () => {
		await fs.rm(serverRoot, { recursive: true, force: true });
	});

	test('loads the verifier with the packaged runtime', async () => {
		await createVerifierPackage('export async function verify() {}');

		await verifyServerWebSignatureVerifier(
			serverRoot,
			true,
			process.execPath
		);
	});

	test('rejects output without the verifier package', async () => {
		await assert.rejects(
			verifyServerWebSignatureVerifier(serverRoot),
			/Server-web signature verifier not found/
		);
	});

	test('rejects a verifier that the runtime cannot import', async () => {
		await createVerifierPackage(
			`throw new Error('broken verifier import');\n`
		);

		await assert.rejects(
			verifyServerWebSignatureVerifier(
				serverRoot,
				true,
				process.execPath
			),
			new RegExp(
				'Packaged runtime failed to import node-ovsx-sign:'
					+ '.*broken verifier import',
				's'
			)
		);
	});

	test('rejects a verifier without the verify export', async () => {
		await createVerifierPackage('export const sign = async () => {};');

		await assert.rejects(
			verifyServerWebSignatureVerifier(
				serverRoot,
				true,
				process.execPath
			),
			/does not export verify/
		);
	});

	async function createVerifierPackage(source: string): Promise<void> {
		const packageRoot = path.join(
			serverRoot,
			'node_modules',
			'node-ovsx-sign'
		);
		await fs.mkdir(packageRoot, { recursive: true });
		await fs.writeFile(
			path.join(packageRoot, 'package.json'),
			JSON.stringify({
				name: 'node-ovsx-sign',
				version: '1.2.0',
				type: 'module',
				exports: './index.js'
			})
		);
		await fs.writeFile(path.join(packageRoot, 'index.js'), source);
	}
});
