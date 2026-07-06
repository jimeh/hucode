/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const supportedQualities = new Set(['stable']);

const requiredRootKeys = [
	'nameShort',
	'nameLong',
	'applicationName',
	'dataFolderName',
	'sharedDataFolderName',
	'urlProtocol',
	'darwinBundleIdentifier',
	'linuxIconName'
];

const requiredOverlayKeys = [
	'nameShort',
	'nameLong',
	'applicationName',
	'dataFolderName',
	'sharedDataFolderName',
	'urlProtocol',
	'darwinBundleIdentifier',
	'linuxIconName',
	'extensionsGallery'
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

/**
 * Recursively copies one directory into another.
 *
 * @param {string} source
 * @param {string} destination
 */
async function copyDir(source, destination) {
	await fs.mkdir(destination, { recursive: true });
	await fs.cp(source, destination, { recursive: true, force: true });
}

/**
 * Reads a JSON file from disk.
 *
 * @param {string} filePath
 * @returns {Promise<any>}
 */
async function readJson(filePath) {
	const contents = await fs.readFile(filePath, 'utf8');
	return JSON.parse(contents);
}

/**
 * Writes a JSON file using the repo's tab-indented format.
 *
 * @param {string} filePath
 * @param {any} value
 */
async function writeJson(filePath, value) {
	await fs.writeFile(filePath, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
}

/**
 * Spawns a child process and rejects on non-zero exit.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 */
async function run(command, args, cwd, env) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
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

/**
 * Runs the upstream mixin script inside a temporary workspace.
 *
 * @param {string} quality
 * @param {string} tmpRoot
 */
async function runUpstreamMixin(quality, tmpRoot) {
	const tempScript = path.join(tmpRoot, 'run-mixin-quality.mjs');
	const script = [
		`process.chdir(${JSON.stringify(tmpRoot)});`,
		`await import(${JSON.stringify(
			pathToFileURL(
				path.join(repoRoot, 'build/azure-pipelines/distro/mixin-quality.ts')
			).href
		)});`
	].join('\n');

	await fs.writeFile(tempScript, script, 'utf8');
	await run(process.execPath, [tempScript], tmpRoot, {
		...process.env,
		VSCODE_QUALITY: quality
	});
}

/**
 * Asserts that the given JSON object contains the required keys.
 *
 * @param {any} json
 * @param {string[]} keys
 * @param {string} label
 */
function assertKeys(json, keys, label) {
	for (const key of keys) {
		assert.ok(
			Object.hasOwn(json, key),
			`${label} is missing required key '${key}'.`
		);
	}
}

/**
 * Creates the generated Hucode mixin for one quality.
 *
 * @param {string} quality
 */
export async function prepareMixin(quality = 'stable') {
	if (!supportedQualities.has(quality)) {
		throw new Error(`Unsupported quality '${quality}'.`);
	}

	const sourceRoot = path.join(repoRoot, 'build', 'hucode', 'mixin', quality);
	const outputRoot = path.join(
		repoRoot,
		'.build',
		'distro',
		'mixin',
		quality
	);
	const sourceProductPath = path.join(sourceRoot, 'product.json');
	const rootProductPath = path.join(repoRoot, 'product.json');
	const outputProductPath = path.join(outputRoot, 'product.json');

	const sourceProduct = await readJson(sourceProductPath);
	const rootProduct = await readJson(rootProductPath);

	assertKeys(rootProduct, requiredRootKeys, 'root product.json');
	assertKeys(sourceProduct, requiredOverlayKeys, 'Hucode mixin product.json');

	await fs.rm(outputRoot, { recursive: true, force: true });
	await copyDir(sourceRoot, outputRoot);

	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hucode-mixin-'));

	try {
		await fs.mkdir(path.join(tmpRoot, '.build', 'distro', 'mixin', quality), {
			recursive: true
		});
		await writeJson(path.join(tmpRoot, 'product.json'), rootProduct);
		await writeJson(
			path.join(tmpRoot, '.build', 'distro', 'mixin', quality, 'product.json'),
			sourceProduct
		);

		await runUpstreamMixin(quality, tmpRoot);

		const mixedOverlayProduct = await readJson(path.join(tmpRoot, 'product.json'));
		assert.strictEqual(mixedOverlayProduct.nameShort, sourceProduct.nameShort);
		assert.strictEqual(
			mixedOverlayProduct.extensionsGallery.serviceUrl,
			sourceProduct.extensionsGallery.serviceUrl
		);
		assert.ok(
			Array.isArray(mixedOverlayProduct.builtInExtensions),
			'Merged product.json did not inherit builtInExtensions.'
		);
		const mixedProduct = {
			...rootProduct,
			...mixedOverlayProduct,
			builtInExtensions: mixedOverlayProduct.builtInExtensions,
			webBuiltInExtensions:
				mixedOverlayProduct.webBuiltInExtensions ?? rootProduct.webBuiltInExtensions
		};
		assert.ok(
			mixedProduct.defaultChatAgent,
			'Merged product.json lost defaultChatAgent.'
		);
		assert.ok(
			mixedProduct.trustedExtensionAuthAccess,
			'Merged product.json lost trustedExtensionAuthAccess.'
		);

		await writeJson(outputProductPath, mixedProduct);
	} finally {
		await fs.rm(tmpRoot, { recursive: true, force: true });
	}

	return outputProductPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const quality = parseQuality(process.argv.slice(2));
	await prepareMixin(quality);
}
