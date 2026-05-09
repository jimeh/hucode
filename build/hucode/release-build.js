/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { prepareMixin } from './prepare-mixin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const archAliases = new Map([
	['x64', 'x64'],
	['arm64', 'arm64'],
	['arm', 'armhf'],
	['armhf', 'armhf']
]);

const supportedTargets = new Map([
	['darwin', new Set(['x64', 'arm64'])],
	['linux', new Set(['x64', 'arm64', 'armhf'])],
	['win32', new Set(['x64', 'arm64'])]
]);

function printHelp() {
	console.log(`Usage: node build/hucode/release-build.js [options]

Builds a minified Hucode desktop package with the stable product mixin.

Options:
--archive            Also create dist/hucode-<platform>-<arch>.zip.
--arch <arch>        Target architecture. Defaults to the host arch.
--platform <name>    Target platform. Defaults to the host platform.
--quality <name>     Product mixin quality. Defaults to stable.
--out <dir>          Output directory. Defaults to dist.
--skip-build         Move/archive an existing ../VSCode-* package.
-h, --help           Show this help.
`);
}

function normalizeArch(arch) {
	const normalized = archAliases.get(arch);
	if (!normalized) {
		throw new Error(`Unsupported architecture '${arch}'.`);
	}

	return normalized;
}

function parseArgs(args) {
	const options = {
		archive: false,
		arch: normalizeArch(process.arch),
		platform: process.platform,
		quality: 'stable',
		out: 'dist',
		skipBuild: false,
		help: false
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '--archive':
				options.archive = true;
				break;
			case '--arch':
				options.arch = normalizeArch(readValue(args, ++i, arg));
				break;
			case '--platform':
				options.platform = readValue(args, ++i, arg);
				break;
			case '--quality':
				options.quality = readValue(args, ++i, arg);
				break;
			case '--out':
				options.out = readValue(args, ++i, arg);
				break;
			case '--skip-build':
				options.skipBuild = true;
				break;
			case '-h':
			case '--help':
				options.help = true;
				break;
			default:
				throw new Error(`Unknown option '${arg}'.`);
		}
	}

	if (!supportedTargets.has(options.platform)) {
		throw new Error(`Unsupported platform '${options.platform}'.`);
	}

	if (!supportedTargets.get(options.platform).has(options.arch)) {
		throw new Error(
			`Unsupported target '${options.platform}-${options.arch}'.`
		);
	}

	return options;
}

function readValue(args, index, option) {
	const value = args[index];
	if (!value || value.startsWith('--')) {
		throw new Error(`Missing value for ${option}.`);
	}

	return value;
}

async function run(command, args, cwd) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: 'inherit',
			shell: process.platform === 'win32'
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

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function movePackage(source, destination) {
	if (!(await exists(source))) {
		throw new Error(`Build output not found: ${source}`);
	}

	await fs.rm(destination, { recursive: true, force: true });
	await fs.mkdir(path.dirname(destination), { recursive: true });

	try {
		await fs.rename(source, destination);
	} catch (error) {
		if (error?.code !== 'EXDEV') {
			throw error;
		}

		await fs.cp(source, destination, {
			recursive: true,
			force: true,
			verbatimSymlinks: true
		});
		await fs.rm(source, { recursive: true, force: true });
	}
}

async function createArchive(source, archivePath) {
	await fs.rm(archivePath, { force: true });
	await fs.mkdir(path.dirname(archivePath), { recursive: true });

	if (process.platform === 'win32') {
		await run('powershell.exe', [
			'-NoProfile',
			'-Command',
			'Compress-Archive',
			'-Path',
			'*',
			'-DestinationPath',
			archivePath
		], source);
		return;
	}

	await run('zip', ['-Xry', archivePath, '.'], source);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	const buildName = `VSCode-${options.platform}-${options.arch}`;
	const distName = `hucode-${options.platform}-${options.arch}`;
	const taskName = `vscode-${options.platform}-${options.arch}-min`;
	const buildOutput = path.join(path.dirname(repoRoot), buildName);
	const distRoot = path.resolve(repoRoot, options.out);
	const distOutput = path.join(distRoot, distName);
	const archivePath = path.join(distRoot, `${distName}.zip`);

	if (!options.skipBuild) {
		await prepareMixin(options.quality);
		await run(process.execPath, [
			path.join('build', 'hucode', 'run-with-mixin.js'),
			'--quality',
			options.quality,
			'--',
			'npm',
			'run',
			'gulp',
			taskName
		], repoRoot);
	}

	await movePackage(buildOutput, distOutput);

	if (options.archive) {
		await createArchive(distOutput, archivePath);
	}

	console.log(`Hucode build output: ${distOutput}`);
	if (options.archive) {
		console.log(`Hucode release archive: ${archivePath}`);
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
