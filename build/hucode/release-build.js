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
--archive            Also create hucode-<platform>-<arch>.zip.
--artifacts <list>   Comma-separated artifacts to create.
Supported values: archive, dmg, deb, rpm, user-setup, system-setup.
--arch <arch>        Target architecture. Defaults to the host arch.
--move-to-dist       Move the app output to <out>/hucode-<platform>-<arch>.
--platform <name>    Target platform. Defaults to the host platform.
--quality <name>     Product mixin quality. Defaults to stable.
--out <dir>          Output directory. Defaults to dist.
--sign               Enable package signing. Not implemented yet.
--skip-build         Package an existing ../VSCode-* app output.
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
		artifacts: [],
		arch: normalizeArch(process.arch),
		moveToDist: false,
		platform: process.platform,
		quality: 'stable',
		out: 'dist',
		sign: false,
		skipBuild: false,
		help: false
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '--archive':
				options.artifacts.push('archive');
				break;
			case '--artifacts':
				options.artifacts.push(
					...readValue(args, ++i, arg)
						.split(',')
						.map(value => value.trim())
						.filter(Boolean)
				);
				break;
			case '--arch':
				options.arch = normalizeArch(readValue(args, ++i, arg));
				break;
			case '--move-to-dist':
				options.moveToDist = true;
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
			case '--sign':
				options.sign = true;
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

	options.artifacts = Array.from(new Set(options.artifacts));
	for (const artifact of options.artifacts) {
		if (!supportedArtifacts.get(options.platform).has(artifact)) {
			throw new Error(
				`Unsupported ${options.platform} artifact '${artifact}'.`
			);
		}
	}

	if (options.sign) {
		throw new Error('Package signing is not implemented for Hucode builds yet.');
	}

	return options;
}

const supportedArtifacts = new Map([
	['darwin', new Set(['archive', 'dmg'])],
	['linux', new Set(['archive', 'deb', 'rpm'])],
	['win32', new Set(['archive', 'user-setup', 'system-setup'])]
]);

const cliTargets = new Map([
	['darwin-x64', 'x86_64-apple-darwin'],
	['darwin-arm64', 'aarch64-apple-darwin'],
	['linux-x64', 'x86_64-unknown-linux-gnu'],
	['linux-arm64', 'aarch64-unknown-linux-gnu'],
	['linux-armhf', 'armv7-unknown-linux-gnueabihf'],
	['win32-x64', 'x86_64-pc-windows-msvc'],
	['win32-arm64', 'aarch64-pc-windows-msvc']
]);

function readValue(args, index, option) {
	const value = args[index];
	if (!value || value.startsWith('--')) {
		throw new Error(`Missing value for ${option}.`);
	}

	return value;
}

async function run(command, args, cwd, env = {}) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env },
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

async function capture(command, args, cwd) {
	const chunks = [];
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'inherit'],
			shell: process.platform === 'win32'
		});

		child.stdout.on('data', chunk => chunks.push(chunk));
		child.on('error', reject);
		child.on('exit', code => {
			if (code === 0) {
				resolve(undefined);
				return;
			}

			reject(new Error(`${command} exited with code ${code ?? 'null'}.`));
		});
	});

	return Buffer.concat(chunks).toString('utf8').trim();
}

async function runWithMixin(args, options, env = {}) {
	await run(process.execPath, [
		path.join('build', 'hucode', 'run-with-mixin.js'),
		'--quality',
		options.quality,
		'--',
		...args
	], repoRoot, {
		VSCODE_ARCH: options.arch,
		VSCODE_QUALITY: options.quality,
		...env
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

async function moveFile(source, destination) {
	if (!(await exists(source))) {
		throw new Error(`Build output not found: ${source}`);
	}

	await fs.rm(destination, { force: true });
	await fs.mkdir(path.dirname(destination), { recursive: true });

	try {
		await fs.rename(source, destination);
	} catch (error) {
		if (error?.code !== 'EXDEV') {
			throw error;
		}

		await fs.copyFile(source, destination);
		await fs.rm(source, { force: true });
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

async function findFirst(root, predicate) {
	const entries = await fs.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			const nested = await findFirst(entryPath, predicate);
			if (nested) {
				return nested;
			}
			continue;
		}

		if (predicate(entryPath)) {
			return entryPath;
		}
	}

	return undefined;
}

function getCliTarget(options) {
	const target = cliTargets.get(`${options.platform}-${options.arch}`);
	if (!target) {
		throw new Error(
			`Unsupported CLI target '${options.platform}-${options.arch}'.`
		);
	}

	return target;
}

function getAppProductJsonPath(options, buildOutput, product) {
	if (options.platform === 'darwin') {
		return path.join(
			buildOutput,
			`${product.nameLong}.app`,
			'Contents',
			'Resources',
			'app',
			'product.json'
		);
	}

	return path.join(buildOutput, 'resources', 'app', 'product.json');
}

function getAppCliDestination(options, buildOutput, product) {
	if (options.platform === 'darwin') {
		return path.join(
			buildOutput,
			`${product.nameLong}.app`,
			'Contents',
			'Resources',
			'app',
			'bin',
			product.tunnelApplicationName
		);
	}

	return path.join(
		buildOutput,
		'bin',
		`${product.tunnelApplicationName}${options.platform === 'win32' ? '.exe' : ''}`
	);
}

function getLinuxCliEnv(options) {
	if (options.platform !== 'linux') {
		return {};
	}

	const targets = new Map([
		['x64', {
			cargo: 'X86_64_UNKNOWN_LINUX_GNU',
			cc: 'CC_x86_64_unknown_linux_gnu',
			debianArch: 'x86_64-linux-gnu',
			triple: 'x86_64-linux-gnu'
		}],
		['arm64', {
			cargo: 'AARCH64_UNKNOWN_LINUX_GNU',
			cc: 'CC_aarch64_unknown_linux_gnu',
			debianArch: 'aarch64-linux-gnu',
			triple: 'aarch64-linux-gnu'
		}],
		['armhf', {
			cargo: 'ARMV7_UNKNOWN_LINUX_GNUEABIHF',
			cc: 'CC_armv7_unknown_linux_gnueabihf',
			debianArch: 'arm-linux-gnueabihf',
			triple: 'arm-rpi-linux-gnueabihf'
		}]
	]);
	const target = targets.get(options.arch);
	if (!target) {
		throw new Error(`Unsupported Linux CLI arch '${options.arch}'.`);
	}

	const sysrootRoot = process.env.VSCODE_SYSROOT_DIR
		?? path.join(repoRoot, '.build', 'sysroots');
	const sysroot = path.join(
		sysrootRoot,
		target.triple,
		target.triple,
		'sysroot'
	);
	const gcc = path.join(
		sysrootRoot,
		target.triple,
		'bin',
		`${target.triple}-gcc`
	);
	const rustFlags = [
		`-C link-arg=--sysroot=${sysroot}`,
		`-C link-arg=-L${sysroot}/usr/lib/${target.debianArch}`,
		`-C link-arg=-L/usr/lib/${target.debianArch}`
	].join(' ');
	const env = {
		[`CARGO_TARGET_${target.cargo}_LINKER`]: gcc,
		[`CARGO_TARGET_${target.cargo}_RUSTFLAGS`]: rustFlags,
		[target.cc]: `${gcc} --sysroot=${sysroot}`
	};

	if (options.arch === 'armhf') {
		env.PKG_CONFIG_ALLOW_CROSS = '1';
		env.PKG_CONFIG_LIBDIR_armv7_unknown_linux_gnueabihf =
			'/usr/lib/arm-linux-gnueabihf/pkgconfig:/usr/share/pkgconfig';
		env.PKG_CONFIG_SYSROOT_DIR_armv7_unknown_linux_gnueabihf = '/';
	}

	return env;
}

async function readJson(filePath) {
	return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function mixInCli(options, buildOutput) {
	const mixinProductPath = path.join(
		repoRoot,
		'.build',
		'distro',
		'mixin',
		options.quality,
		'product.json'
	);
	const product = await readJson(mixinProductPath);
	const appProductPath = getAppProductJsonPath(options, buildOutput, product);
	if (!(await exists(appProductPath))) {
		throw new Error(`App product.json not found: ${appProductPath}`);
	}

	const target = getCliTarget(options);
	const commit = process.env.GITHUB_SHA
		?? await capture('git', ['rev-parse', 'HEAD'], repoRoot);
	await run('cargo', [
		'build',
		'--release',
		'--target',
		target,
		'--bin',
		'code'
	], path.join(repoRoot, 'cli'), {
		CARGO_NET_GIT_FETCH_WITH_CLI: 'true',
		VSCODE_CLI_COMMIT: commit,
		VSCODE_CLI_PRODUCT_JSON: mixinProductPath,
		...getLinuxCliEnv(options)
	});

	const cliBinary = path.join(
		repoRoot,
		'cli',
		'target',
		target,
		'release',
		`code${options.platform === 'win32' ? '.exe' : ''}`
	);
	const destination = getAppCliDestination(options, buildOutput, product);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.copyFile(cliBinary, destination);

	if (options.platform !== 'win32') {
		await fs.chmod(destination, 0o755);
	}

	console.log(`Hucode CLI: ${destination}`);
}

async function packageArchive(buildOutput, distRoot, distName) {
	const archivePath = path.join(distRoot, `${distName}.zip`);
	await createArchive(buildOutput, archivePath);
	console.log(`Hucode archive: ${archivePath}`);
}

async function packageDmg(options, buildRoot, distRoot, distName) {
	const dmgOut = path.join(distRoot, '.tmp', distName, 'dmg');
	await fs.mkdir(dmgOut, { recursive: true });

	await runWithMixin([
		process.execPath,
		path.join('build', 'darwin', 'create-dmg.ts'),
		buildRoot,
		dmgOut
	], options);

	const source = path.join(dmgOut, `VSCode-darwin-${options.arch}.dmg`);
	const destination = path.join(distRoot, `${distName}.dmg`);
	await moveFile(source, destination);
	console.log(`Hucode DMG: ${destination}`);
}

async function packageDeb(options, distRoot) {
	const buildRoot = path.join(repoRoot, '.build', 'linux', 'deb');
	await fs.rm(buildRoot, { recursive: true, force: true });

	await runWithMixin([
		'npm',
		'run',
		'gulp',
		`vscode-linux-${options.arch}-prepare-deb`
	], options);
	await runWithMixin([
		'npm',
		'run',
		'gulp',
		`vscode-linux-${options.arch}-build-deb`
	], options);

	const source = await findFirst(
		buildRoot,
		filePath => filePath.endsWith('.deb')
	);
	if (!source) {
		throw new Error('DEB package was not created.');
	}

	const destination = path.join(distRoot, path.basename(source));
	await moveFile(source, destination);
	console.log(`Hucode DEB: ${destination}`);
}

async function packageRpm(options, distRoot) {
	const buildRoot = path.join(repoRoot, '.build', 'linux', 'rpm');
	await fs.rm(buildRoot, { recursive: true, force: true });

	await runWithMixin([
		'npm',
		'run',
		'gulp',
		`vscode-linux-${options.arch}-prepare-rpm`
	], options);
	await runWithMixin([
		'npm',
		'run',
		'gulp',
		`vscode-linux-${options.arch}-build-rpm`
	], options);

	const source = await findFirst(
		buildRoot,
		filePath => filePath.endsWith('.rpm')
	);
	if (!source) {
		throw new Error('RPM package was not created.');
	}

	const destination = path.join(distRoot, path.basename(source));
	await moveFile(source, destination);
	console.log(`Hucode RPM: ${destination}`);
}

async function packageWindowsSetup(options, distRoot, distName, target) {
	await runWithMixin([
		'npm',
		'run',
		'gulp',
		`vscode-win32-${options.arch}-inno-updater`
	], options);
	await runWithMixin([
		'npm',
		'run',
		'gulp',
		`vscode-win32-${options.arch}-${target}-setup`
	], options);

	const source = path.join(
		repoRoot,
		'.build',
		`win32-${options.arch}`,
		`${target}-setup`,
		'VSCodeSetup.exe'
	);
	const destination = path.join(
		distRoot,
		`${distName}-${target}-setup.exe`
	);
	await moveFile(source, destination);
	console.log(`Hucode ${target} setup: ${destination}`);
}

async function packageArtifact(artifact, options, paths) {
	switch (artifact) {
		case 'archive':
			await packageArchive(paths.buildOutput, paths.distRoot, paths.distName);
			return;
		case 'dmg':
			await packageDmg(options, paths.buildRoot, paths.distRoot, paths.distName);
			return;
		case 'deb':
			await packageDeb(options, paths.distRoot);
			return;
		case 'rpm':
			await packageRpm(options, paths.distRoot);
			return;
		case 'user-setup':
			await packageWindowsSetup(
				options,
				paths.distRoot,
				paths.distName,
				'user'
			);
			return;
		case 'system-setup':
			await packageWindowsSetup(
				options,
				paths.distRoot,
				paths.distName,
				'system'
			);
			return;
		default:
			throw new Error(`Unsupported artifact '${artifact}'.`);
	}
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
	const buildRoot = path.dirname(repoRoot);
	const buildOutput = path.join(buildRoot, buildName);
	const distRoot = path.resolve(repoRoot, options.out);
	const distOutput = path.join(distRoot, distName);

	await prepareMixin(options.quality);
	if (!options.skipBuild) {
		await runWithMixin([
			'npm',
			'run',
			'gulp',
			taskName
		], options);
	}

	await mixInCli(options, buildOutput);

	for (const artifact of options.artifacts) {
		await packageArtifact(artifact, options, {
			buildOutput,
			buildRoot,
			distName,
			distRoot
		});
	}

	if (options.moveToDist) {
		await movePackage(buildOutput, distOutput);
		console.log(`Hucode build output: ${distOutput}`);
	} else {
		console.log(`Hucode build output: ${buildOutput}`);
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
