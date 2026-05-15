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
	findBuiltInCopilotExtension,
	validateExtractedCopilotVsix,
	validatePackagedCopilot,
} from '../../hucode/release-build.js';

suite('Hucode release build', () => {

	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hucode-release-'));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test('accepts extracted Copilot VSIX without platform binaries', async () => {
		const outputDir = await createCopilotExtension();

		await validateExtractedCopilotVsix(outputDir);
	});

	test('rejects extracted Copilot VSIX with platform packages', async () => {
		const outputDir = await createCopilotExtension();
		await fs.mkdir(
			path.join(outputDir, 'node_modules', '@github', 'copilot-linux-x64'),
			{ recursive: true }
		);

		await assert.rejects(
			validateExtractedCopilotVsix(outputDir),
			/platform-specific executable packages: copilot-linux-x64/
		);
	});

	test('rejects extracted Copilot VSIX with bundled ripgrep', async () => {
		const outputDir = await createCopilotExtension();
		await fs.mkdir(
			path.join(
				outputDir,
				'node_modules',
				'@github',
				'copilot',
				'sdk',
				'ripgrep',
				'bin'
			),
			{ recursive: true }
		);

		await assert.rejects(
			validateExtractedCopilotVsix(outputDir),
			/ripgrep binaries/
		);
	});

	test('finds packaged built-in Copilot extension', async () => {
		const buildOutput = path.join(tmpDir, 'VSCode-linux-x64');
		const extensionDir = await createPackagedCopilotExtension(
			buildOutput,
			'linux-x64'
		);

		assert.strictEqual(
			await findBuiltInCopilotExtension(buildOutput),
			extensionDir
		);
	});

	test('validates packaged Copilot ripgrep shim for target', async () => {
		const buildOutput = path.join(tmpDir, 'VSCode-linux-x64');
		await createPackagedCopilotExtension(buildOutput, 'linux-x64');

		await validatePackagedCopilot(
			{ platform: 'linux', arch: 'x64' },
			buildOutput
		);
	});

	test('rejects packaged Copilot without target ripgrep shim', async () => {
		const buildOutput = path.join(tmpDir, 'VSCode-darwin-arm64');
		await createPackagedCopilotExtension(buildOutput, 'darwin-x64');

		await assert.rejects(
			validatePackagedCopilot(
				{ platform: 'darwin', arch: 'arm64' },
				buildOutput
			),
			/Copilot ripgrep shim not found/
		);
	});

	async function createCopilotExtension(): Promise<string> {
		const outputDir = path.join(tmpDir, 'copilot');
		await fs.mkdir(outputDir, { recursive: true });
		await fs.writeFile(
			path.join(outputDir, 'package.json'),
			JSON.stringify({ name: 'copilot' })
		);

		return outputDir;
	}

	async function createPackagedCopilotExtension(
		buildOutput: string,
		platformArch: string
	): Promise<string> {
		const extensionDir = path.join(
			buildOutput,
			'resources',
			'app',
			'extensions',
			'copilot'
		);
		const shimDir = path.join(
			extensionDir,
			'node_modules',
			'@github',
			'copilot',
			'sdk',
			'ripgrep',
			'bin',
			platformArch
		);

		await fs.mkdir(shimDir, { recursive: true });
		await fs.writeFile(path.join(extensionDir, 'package.json'), '{}');
		await fs.writeFile(path.join(shimDir, 'rg'), '');

		return extensionDir;
	}
});
