/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { generateLinuxIcons } from './generate-linux-icons.ts';
import { generateServerIcons } from './generate-server-icons.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(repoRoot, 'build', 'hucode', 'icons', 'darwin');
const iconSource = path.join(sourceRoot, 'Hucode.icon');
const outputRoot = path.join(
	repoRoot,
	'build',
	'hucode',
	'mixin',
	'stable',
	'resources',
	'darwin'
);

async function run(command, args) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repoRoot,
			stdio: 'inherit'
		});

		child.on('error', reject);
		child.on('exit', code => {
			if (code === 0) {
				resolve(undefined);
				return;
			}

			reject(new Error(`${command} exited with code ${code ?? 'null'}.`));
		});
	});
}

async function buildDarwinIconAssets(tmpRoot) {
	const compiled = path.join(tmpRoot, 'compiled');
	const partialInfo = path.join(compiled, 'partial.plist');
	await fs.mkdir(compiled, { recursive: true });

	await run('xcrun', [
		'actool',
		'--compile',
		compiled,
		'--platform',
		'macosx',
		'--minimum-deployment-target',
		'10.15',
		'--app-icon',
		'Hucode',
		'--output-partial-info-plist',
		partialInfo,
		'--standalone-icon-behavior',
		'all',
		iconSource
	]);

	await fs.copyFile(
		path.join(compiled, 'Assets.car'),
		path.join(outputRoot, 'Assets.car')
	);
	await fs.copyFile(
		path.join(compiled, 'Hucode.icns'),
		path.join(outputRoot, 'code.icns')
	);
	await generateServerIcons(path.join(compiled, 'Hucode.icns'));
}

async function main() {
	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hucode-icon-'));

	try {
		await fs.mkdir(outputRoot, { recursive: true });
		await buildDarwinIconAssets(tmpRoot);
		await generateLinuxIcons();
	} finally {
		await fs.rm(tmpRoot, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
