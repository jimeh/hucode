/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(repoRoot, 'build', 'hucode', 'icons', 'darwin');
const pngRoot = path.join(sourceRoot, 'png');
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

const iconsetFiles = [
	['16x16@1x', 'icon_16x16.png'],
	['16x16@2x', 'icon_16x16@2x.png'],
	['32x32@1x', 'icon_32x32.png'],
	['32x32@2x', 'icon_32x32@2x.png'],
	['128x128@1x', 'icon_128x128.png'],
	['128x128@2x', 'icon_128x128@2x.png'],
	['256x256@1x', 'icon_256x256.png'],
	['256x256@2x', 'icon_256x256@2x.png'],
	['512x512@1x', 'icon_512x512.png'],
	['512x512@2x', 'icon_512x512@2x.png']
];

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

function pngName(size) {
	return `Hucode Halo-macOS-Default-${size}.png`;
}

async function buildIcns(tmpRoot) {
	const iconset = path.join(tmpRoot, 'Hucode.iconset');
	await fs.mkdir(iconset, { recursive: true });

	for (const [size, targetName] of iconsetFiles) {
		await fs.copyFile(
			path.join(pngRoot, pngName(size)),
			path.join(iconset, targetName)
		);
	}

	await run('iconutil', [
		'--convert',
		'icns',
		'--output',
		path.join(outputRoot, 'code.icns'),
		iconset
	]);
}

async function buildAssetsCar(tmpRoot) {
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
		'none',
		iconSource
	]);

	await fs.copyFile(
		path.join(compiled, 'Assets.car'),
		path.join(outputRoot, 'Assets.car')
	);
}

async function main() {
	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hucode-icon-'));

	try {
		await fs.mkdir(outputRoot, { recursive: true });
		await buildIcns(tmpRoot);
		await buildAssetsCar(tmpRoot);
	} finally {
		await fs.rm(tmpRoot, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
