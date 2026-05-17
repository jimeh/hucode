/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import yauzl from 'yauzl';
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
--copilot-vsix <path>  Extract a Copilot VSIX instead of building it from source.
--platform <name>    Target platform. Defaults to the host platform.
--quality <name>     Product mixin quality. Defaults to stable.
--out <dir>          Output directory. Defaults to dist.
--sign               Sign and notarize macOS release artifacts.
--include-source-maps  Keep local source maps in the packaged app.
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
		copilotVsix: undefined,
		sign: false,
		stripSourceMaps: true,
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
			case '--copilot-vsix':
				options.copilotVsix = path.resolve(
					repoRoot,
					readValue(args, ++i, arg)
				);
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
			case '--include-source-maps':
				options.stripSourceMaps = false;
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

	if (options.sign && options.platform !== 'darwin') {
		throw new Error('Package signing is only implemented for macOS builds.');
	}

	if (options.skipBuild && options.copilotVsix) {
		throw new Error('--copilot-vsix cannot be used with --skip-build.');
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

const MACHO_MAGIC_NUMBERS = new Set([
	0xFEEDFACE,
	0xCEFAEDFE,
	0xFEEDFACF,
	0xCFFAEDFE,
	0xCAFEBABE,
	0xBEBAFECA
]);

function getNodePlatformArch(options) {
	const nodePlatform = options.platform === 'alpine' ? 'linux' : options.platform;
	const nodeArch = options.arch === 'armhf' ? 'arm' : options.arch;

	return `${nodePlatform}-${nodeArch}`;
}

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

async function captureCombined(command, args, cwd, env = {}) {
	const chunks = [];
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: process.platform === 'win32'
		});

		child.stdout.on('data', chunk => chunks.push(chunk));
		child.stderr.on('data', chunk => chunks.push(chunk));
		child.on('error', reject);
		child.on('exit', code => {
			if (code === 0) {
				resolve(undefined);
				return;
			}

			const output = Buffer.concat(chunks).toString('utf8').trim();
			reject(
				new Error(
					`${command} exited with code ${code ?? 'null'}.` +
					(output ? `\n${output}` : '')
				)
			);
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

async function runGulpTask(taskName, options, env = {}) {
	await runWithMixin(['npm', 'run', 'gulp', taskName], options, env);
}

function getBuildEnv(options) {
	if (!options.stripSourceMaps) {
		return {};
	}

	return {
		GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE ?? repoRoot
	};
}

function getLinuxPackageDepsEnv() {
	return {
		HUCODE_LINUX_PACKAGE_DEPS_WARN_ONLY: '1'
	};
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function writeBuildDate() {
	let date;
	try {
		date = await capture(
			'git',
			['log', '-1', '--format=%cI', 'HEAD'],
			repoRoot
		);
	} catch {
		date = new Date().toISOString();
	}

	const outBuild = path.join(repoRoot, 'out-build');
	await fs.mkdir(outBuild, { recursive: true });
	await fs.writeFile(path.join(outBuild, 'date'), date, 'utf8');
}

function openZip(zipPath) {
	return new Promise((resolve, reject) => {
		yauzl.open(zipPath, {
			autoClose: true,
			lazyEntries: true
		}, (error, zipfile) => {
			if (error) {
				reject(error);
				return;
			}

			resolve(zipfile);
		});
	});
}

function openZipEntry(zipfile, entry) {
	return new Promise((resolve, reject) => {
		zipfile.openReadStream(entry, (error, stream) => {
			if (error) {
				reject(error);
				return;
			}

			resolve(stream);
		});
	});
}

function getExtensionRelativePath(entryName) {
	if (!entryName.startsWith('extension/')) {
		return undefined;
	}

	const relativePath = entryName.slice('extension/'.length);
	if (!relativePath || relativePath.endsWith('/')) {
		return undefined;
	}

	const normalized = path.normalize(relativePath);
	if (
		normalized === '..'
		|| normalized.startsWith(`..${path.sep}`)
		|| path.isAbsolute(normalized)
	) {
		throw new Error(`Unsafe VSIX entry path: ${entryName}`);
	}

	return normalized;
}

async function extractCopilotVsix(vsixPath) {
	if (!(await exists(vsixPath))) {
		throw new Error(`Copilot VSIX not found: ${vsixPath}`);
	}

	const outputDir = path.join(repoRoot, '.build', 'extensions', 'copilot');
	await fs.rm(outputDir, { recursive: true, force: true });
	await fs.mkdir(outputDir, { recursive: true });

	const zipfile = await openZip(vsixPath);
	await new Promise((resolve, reject) => {
		zipfile.on('entry', async entry => {
			try {
				const relativePath = getExtensionRelativePath(entry.fileName);
				if (!relativePath) {
					zipfile.readEntry();
					return;
				}

				const destination = path.join(outputDir, relativePath);
				await fs.mkdir(path.dirname(destination), { recursive: true });
				const stream = await openZipEntry(zipfile, entry);
				await pipeline(stream, createWriteStream(destination));
				zipfile.readEntry();
			} catch (error) {
				reject(error);
			}
		});
		zipfile.on('close', resolve);
		zipfile.on('error', reject);
		zipfile.readEntry();
	});

	const manifestPath = path.join(outputDir, 'package.json');
	if (!(await exists(manifestPath))) {
		throw new Error(`Copilot VSIX did not contain extension/package.json.`);
	}

	await validateExtractedCopilotVsix(outputDir);

	console.log(`Copilot VSIX: ${vsixPath}`);
	console.log(`Copilot extension: ${outputDir}`);
}

/**
 * Validates that an extracted Copilot VSIX has no bundled target binaries.
 *
 * @param {string} outputDir
 */
export async function validateExtractedCopilotVsix(outputDir) {
	const copilotModules = path.join(outputDir, 'node_modules', '@github');
	if (await exists(copilotModules)) {
		const entries = await fs.readdir(copilotModules, { withFileTypes: true });
		const platformPackages = entries
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name)
			.filter(name => /^copilot-(darwin|linux|win32)-/.test(name));
		if (platformPackages.length) {
			throw new Error(
				'Copilot VSIX includes platform-specific executable packages: ' +
				platformPackages.join(', ')
			);
		}
	}

	const ripgrepRoot = path.join(
		outputDir,
		'node_modules',
		'@github',
		'copilot',
		'sdk',
		'ripgrep',
		'bin'
	);
	if (await exists(ripgrepRoot)) {
		throw new Error(
			'Copilot VSIX includes ripgrep binaries; release packaging must ' +
			'inject the target-specific ripgrep shim instead.'
		);
	}
}

/**
 * Finds the built-in Copilot extension inside a packaged app output.
 *
 * @param {string} buildOutput
 * @returns {Promise<string | undefined>}
 */
export async function findBuiltInCopilotExtension(buildOutput) {
	const manifest = await findFirst(buildOutput, filePath => {
		if (path.basename(filePath) !== 'package.json') {
			return false;
		}

		const parts = path.relative(buildOutput, filePath).split(path.sep);
		return parts.at(-3) === 'extensions'
			&& parts.at(-2) === 'copilot'
			&& parts.at(-1) === 'package.json';
	});

	return manifest ? path.dirname(manifest) : undefined;
}

/**
 * Validates the packaged Copilot extension for a release target.
 *
 * @param {{ platform: string; arch: string }} options
 * @param {string} buildOutput
 */
export async function validatePackagedCopilot(options, buildOutput) {
	const extensionDir = await findBuiltInCopilotExtension(buildOutput);
	if (!extensionDir) {
		throw new Error(`Built-in Copilot extension not found in ${buildOutput}`);
	}

	const platformArch = getNodePlatformArch(options);
	const ripgrepShim = path.join(
		extensionDir,
		'node_modules',
		'@github',
		'copilot',
		'sdk',
		'ripgrep',
		'bin',
		platformArch
	);
	if (!(await exists(ripgrepShim))) {
		throw new Error(`Copilot ripgrep shim not found: ${ripgrepShim}`);
	}

	const shimEntries = await fs.readdir(ripgrepShim);
	if (!shimEntries.length) {
		throw new Error(`Copilot ripgrep shim is empty: ${ripgrepShim}`);
	}
}

async function runBuildWithCopilotVsix(options, buildOutput) {
	const env = getBuildEnv(options);
	const packageTask = `vscode-${options.platform}-${options.arch}-min-ci`;

	await fs.rm(path.join(repoRoot, '.build', 'extensions'), {
		recursive: true,
		force: true
	});
	await runGulpTask('copy-codicons', options, env);
	await runGulpTask('compile-non-native-extensions-build', options, env);
	await runGulpTask('compile-extension-media-build', options, env);
	await writeBuildDate();
	await runWithMixin([
		process.execPath,
		path.join('build', 'hucode', 'esbuild-bundle.js')
	], options, env);
	await extractCopilotVsix(options.copilotVsix);
	await runGulpTask(packageTask, options, env);
	await validatePackagedCopilot(options, buildOutput);
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

async function findAppProductJson(options, buildOutput) {
	const appProductPath = path.join(
		buildOutput,
		'resources',
		'app',
		'product.json'
	);
	if (await exists(appProductPath)) {
		return appProductPath;
	}

	return findFirst(buildOutput, filePath => {
		if (path.basename(filePath) !== 'product.json') {
			return false;
		}

		const parts = path.relative(buildOutput, filePath).split(path.sep);
		if (options.platform === 'darwin') {
			return parts.length >= 5
				&& parts.at(-5).endsWith('.app')
				&& parts.at(-4) === 'Contents'
				&& parts.at(-3) === 'Resources'
				&& parts.at(-2) === 'app';
		}

		return parts.length >= 3
			&& parts.at(-3) === 'resources'
			&& parts.at(-2) === 'app';
	});
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

/**
 * Validates that a packaged app output includes the Hucode CLI artifact.
 *
 * @param {{ platform: string; arch: string }} options
 * @param {string} buildOutput
 * @returns {Promise<string>}
 */
export async function validateAppCliArtifact(options, buildOutput) {
	const appProductPath = await findAppProductJson(options, buildOutput);
	if (!appProductPath) {
		throw new Error(`App product.json not found in build output: ${buildOutput}`);
	}

	const product = await readJson(appProductPath);
	const cliPath = getAppCliDestination(options, buildOutput, product);
	let stats;
	try {
		stats = await fs.stat(cliPath);
	} catch {
		throw new Error(`Hucode CLI artifact not found: ${cliPath}`);
	}

	if (!stats.isFile()) {
		throw new Error(`Hucode CLI artifact is not a file: ${cliPath}`);
	}

	if (options.platform !== 'win32' && (stats.mode & 0o111) === 0) {
		throw new Error(`Hucode CLI artifact is not executable: ${cliPath}`);
	}

	return cliPath;
}

async function getDarwinAppPath(options, buildOutput) {
	const appProductPath = await findAppProductJson(options, buildOutput);
	if (!appProductPath) {
		throw new Error(`App product.json not found in build output: ${buildOutput}`);
	}

	const product = await readJson(appProductPath);
	return path.join(buildOutput, `${product.nameLong}.app`);
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`$${name} is required for macOS signing.`);
	}

	return value;
}

async function prepareDarwinSigning() {
	if (process.platform !== 'darwin') {
		throw new Error('macOS signing must run on a macOS host.');
	}

	const tempRoot = process.env.AGENT_TEMPDIRECTORY ?? os.tmpdir();
	await fs.mkdir(tempRoot, { recursive: true });
	const tempDir = await fs.mkdtemp(path.join(tempRoot, 'hucode-signing-'));
	const keychain = path.join(tempDir, 'buildagent.keychain');
	const p12Path = path.join(tempDir, 'developer-id-application.p12');
	const notaryKeyPath = path.join(tempDir, 'notarization-key.p8');
	const keychainPassword = 'hucode-signing';
	const teamId = requireEnv('APPLE_TEAM_ID');

	await fs.writeFile(
		p12Path,
		Buffer.from(
			requireEnv('MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64'),
			'base64'
		)
	);
	await fs.writeFile(
		notaryKeyPath,
		Buffer.from(requireEnv('APPLE_NOTARIZATION_KEY_P8_BASE64'), 'base64'),
		{ mode: 0o600 }
	);

	await fs.rm(keychain, { recursive: true, force: true });
	await run('security', [
		'create-keychain',
		'-p',
		keychainPassword,
		keychain
	], repoRoot);
	await run('security', [
		'unlock-keychain',
		'-p',
		keychainPassword,
		keychain
	], repoRoot);
	await run('security', [
		'import',
		p12Path,
		'-k',
		keychain,
		'-P',
		requireEnv('MACOS_DEVELOPER_ID_APPLICATION_P12_PASSWORD'),
		'-T',
		'/usr/bin/codesign'
	], repoRoot);
	await run('security', [
		'set-key-partition-list',
		'-S',
		'apple-tool:,apple:,codesign:',
		'-s',
		'-k',
		keychainPassword,
		keychain
	], repoRoot);

	const identities = await capture(
		'security',
		['find-identity', '-v', '-p', 'codesigning', keychain],
		repoRoot
	);
	const identityLine = identities
		.split(/\r?\n/)
		.find(line => line.includes('Developer ID Application'));
	const identity = /([0-9A-F]{40})/.exec(identityLine ?? '')?.[1];
	if (!identity) {
		throw new Error(`Developer ID Application identity not found:\n${identities}`);
	}

	if (!identityLine.includes(`(${teamId})`)) {
		throw new Error(
			`Developer ID identity does not match APPLE_TEAM_ID=${teamId}:\n` +
			identityLine
		);
	}

	return {
		env: {
			AGENT_TEMPDIRECTORY: tempDir,
			CODESIGN_IDENTITY: identity
		},
		identity,
		keychain,
		notaryKeyPath,
		tempDir
	};
}

async function cleanupDarwinSigning(signing) {
	if (!signing) {
		return;
	}

	await run('security', ['delete-keychain', signing.keychain], repoRoot)
		.catch(error => {
			console.warn(`Failed to delete signing keychain: ${error.message}`);
		});
	await fs.rm(signing.tempDir, { recursive: true, force: true })
		.catch(error => {
			console.warn(`Failed to remove signing temp directory: ${error.message}`);
		});
}

async function signDarwinApp(options, buildRoot, signing) {
	await runWithMixin([
		process.execPath,
		path.join('build', 'darwin', 'sign.ts'),
		buildRoot
	], options, signing.env);
}

async function signDarwinDmg(dmgPath, signing) {
	await run('codesign', [
		'--sign',
		signing.identity,
		'--keychain',
		signing.keychain,
		'--timestamp',
		'--force',
		dmgPath
	], repoRoot);
}

async function notarizeArtifact(artifactPath, signing) {
	await run('xcrun', [
		'notarytool',
		'submit',
		artifactPath,
		'--key',
		signing.notaryKeyPath,
		'--key-id',
		requireEnv('APPLE_NOTARIZATION_KEY_ID'),
		'--issuer',
		requireEnv('APPLE_NOTARIZATION_ISSUER_ID'),
		'--wait'
	], repoRoot);
}

async function stapleArtifact(artifactPath) {
	await run('xcrun', ['stapler', 'staple', artifactPath], repoRoot);
	await run('xcrun', ['stapler', 'validate', artifactPath], repoRoot);
}

async function createNotarizationZip(appPath, zipPath) {
	await fs.rm(zipPath, { force: true });
	await fs.mkdir(path.dirname(zipPath), { recursive: true });
	await run('ditto', [
		'-c',
		'-k',
		'--sequesterRsrc',
		'--keepParent',
		appPath,
		zipPath
	], repoRoot);
}

async function isMachOBinary(filePath) {
	let file;
	try {
		file = await fs.open(filePath, 'r');
		const buffer = Buffer.alloc(4);
		const result = await file.read(buffer, 0, 4, 0);
		if (result.bytesRead < 4) {
			return false;
		}

		return MACHO_MAGIC_NUMBERS.has(buffer.readUInt32BE(0));
	} catch {
		return false;
	} finally {
		await file?.close();
	}
}

async function findMachOBinaries(root) {
	const result = [];
	const entries = await fs.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const filePath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			result.push(...await findMachOBinaries(filePath));
			continue;
		}

		if (entry.isFile() && await isMachOBinary(filePath)) {
			result.push(filePath);
		}
	}

	return result;
}

async function verifyMachOSignatures(appPath) {
	await run('codesign', [
		'--verify',
		'--deep',
		'--strict',
		'--verbose=4',
		appPath
	], repoRoot);
	await run('codesign', [
		'-dvvv',
		'--entitlements',
		':-',
		appPath
	], repoRoot);

	const machOBinaries = await findMachOBinaries(appPath);
	for (const filePath of machOBinaries) {
		await run('codesign', [
			'--verify',
			'--strict',
			'--verbose=2',
			filePath
		], repoRoot);

		const details = await captureCombined('codesign', [
			'-dv',
			'--verbose=4',
			filePath
		], repoRoot);
		if (/\bSignature=adhoc\b/.test(details)) {
			throw new Error(`Mach-O binary is ad hoc signed: ${filePath}`);
		}
	}

	console.log(`Verified ${machOBinaries.length} signed Mach-O binaries.`);
}

async function notarizeAndStapleDarwinApp(options, buildOutput, distRoot, signing) {
	const appPath = await getDarwinAppPath(options, buildOutput);
	await signDarwinApp(options, path.dirname(repoRoot), signing);
	await verifyMachOSignatures(appPath);

	const zipPath = path.join(
		distRoot,
		'.tmp',
		`hucode-${options.platform}-${options.arch}`,
		'notarization',
		`${path.basename(appPath)}.zip`
	);
	await createNotarizationZip(appPath, zipPath);
	await notarizeArtifact(zipPath, signing);
	await stapleArtifact(appPath);
	await run('spctl', ['-a', '-vvv', '-t', 'exec', appPath], repoRoot);
}

async function getLinuxCliEnv(options) {
	if (options.platform !== 'linux') {
		return {};
	}

	const targets = new Map([
		['x64', {
			cargo: 'X86_64_UNKNOWN_LINUX_GNU',
			cc: 'CC_x86_64_unknown_linux_gnu',
			pkgConfig: 'x86_64_unknown_linux_gnu',
			sysrootLibArch: 'x86_64-linux-gnu',
			triple: 'x86_64-linux-gnu'
		}],
		['arm64', {
			cargo: 'AARCH64_UNKNOWN_LINUX_GNU',
			cc: 'CC_aarch64_unknown_linux_gnu',
			pkgConfig: 'aarch64_unknown_linux_gnu',
			sysrootLibArch: 'aarch64-linux-gnu',
			triple: 'aarch64-linux-gnu'
		}],
		['armhf', {
			cargo: 'ARMV7_UNKNOWN_LINUX_GNUEABIHF',
			cc: 'CC_armv7_unknown_linux_gnueabihf',
			pkgConfig: 'armv7_unknown_linux_gnueabihf',
			sysrootLibArch: 'arm-rpi-linux-gnueabihf',
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

	if (options.arch === 'arm64' && process.arch === 'arm64') {
		return {};
	}

	if (!(await exists(gcc))) {
		if (process.env.CI || options.arch === 'armhf') {
			throw new Error(
				`Linux CLI sysroot toolchain not found: ${gcc}. ` +
				'Run the sysroot download step or set VSCODE_SYSROOT_DIR.'
			);
		}

		return {};
	}

	const rustFlags = [
		`-C link-arg=--sysroot=${sysroot}`,
		`-C link-arg=-L${sysroot}/usr/lib/${target.sysrootLibArch}`
	].join(' ');
	return {
		[`CARGO_TARGET_${target.cargo}_LINKER`]: gcc,
		[`CARGO_TARGET_${target.cargo}_RUSTFLAGS`]: rustFlags,
		[target.cc]: `${gcc} --sysroot=${sysroot}`,
		[`PKG_CONFIG_LIBDIR_${target.pkgConfig}`]:
			`${sysroot}/usr/lib/${target.sysrootLibArch}/pkgconfig:` +
			`${sysroot}/usr/share/pkgconfig`,
		[`PKG_CONFIG_SYSROOT_DIR_${target.pkgConfig}`]: sysroot
	};
}

async function readJson(filePath) {
	return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readMixinProduct(options) {
	return readJson(
		path.join(
			repoRoot,
			'.build',
			'distro',
			'mixin',
			options.quality,
			'product.json'
		)
	);
}

async function getHucodePackageVersion(options, packageType) {
	const product = await readMixinProduct(options);
	const version = product.hucodeVersion;
	if (!version) {
		throw new Error('Hucode product mixin does not define hucodeVersion.');
	}

	if (packageType === 'rpm' && !/^[A-Za-z0-9._+~]+$/.test(version)) {
		throw new Error(
			`hucodeVersion '${version}' is not a valid RPM Version.`
		);
	}

	if (packageType === 'deb' && !/^[0-9][A-Za-z0-9.+:~.-]*$/.test(version)) {
		throw new Error(
			`hucodeVersion '${version}' is not a valid Debian Version.`
		);
	}

	return version;
}

export function applyDebianPackageVersion(controlContent, hucodeVersion) {
	const match = /^Version:[^\S\r\n]*(\S+)[^\S\r\n]*$/m.exec(controlContent);
	if (!match) {
		throw new Error('DEB control file does not contain a Version field.');
	}

	const existingVersion = match[1];
	const revisionIndex = existingVersion.lastIndexOf('-');
	const version = revisionIndex === -1
		? hucodeVersion
		: `${hucodeVersion}${existingVersion.slice(revisionIndex)}`;

	return controlContent.replace(
		/^Version:[^\S\r\n]*\S+[^\S\r\n]*$/m,
		`Version: ${version}`
	);
}

export function applyRpmPackageVersion(specContent, hucodeVersion) {
	if (!/^Version:[^\S\r\n]*\S+[^\S\r\n]*$/m.test(specContent)) {
		throw new Error('RPM spec file does not contain a Version field.');
	}

	return specContent.replace(
		/^Version:[^\S\r\n]*\S+[^\S\r\n]*$/m,
		`Version:  ${hucodeVersion}`
	);
}

async function patchLinuxPackageVersion(options, buildRoot, packageType) {
	const version = await getHucodePackageVersion(options, packageType);
	const filePath = await findFirst(buildRoot, candidate => {
		if (packageType === 'deb') {
			return path.basename(candidate) === 'control'
				&& path.basename(path.dirname(candidate)) === 'DEBIAN';
		}

		return path.extname(candidate) === '.spec'
			&& path.basename(path.dirname(candidate)) === 'SPECS';
	});

	if (!filePath) {
		throw new Error(
			`Linux ${packageType.toUpperCase()} metadata was not created.`
		);
	}

	const content = await fs.readFile(filePath, 'utf8');
	const patched = packageType === 'deb'
		? applyDebianPackageVersion(content, version)
		: applyRpmPackageVersion(content, version);

	await fs.writeFile(filePath, patched, 'utf8');
	console.log(`Hucode ${packageType.toUpperCase()} version: ${version}`);
}

async function mixInCli(options, buildOutput) {
	const appProductPath = await findAppProductJson(options, buildOutput);
	if (!appProductPath) {
		throw new Error(`App product.json not found in build output: ${buildOutput}`);
	}

	const product = await readJson(appProductPath);
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
		VSCODE_CLI_PRODUCT_JSON: appProductPath,
		...await getLinuxCliEnv(options)
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

	await validateAppCliArtifact(options, buildOutput);
	console.log(`Hucode CLI: ${destination}`);
}

async function packageArchive(options, buildOutput, distRoot, distName) {
	const archivePath = path.join(distRoot, `${distName}.zip`);
	if (options.platform === 'darwin') {
		const appPath = await getDarwinAppPath(options, buildOutput);
		await createNotarizationZip(appPath, archivePath);
		console.log(`Hucode archive: ${archivePath}`);
		return;
	}

	await createArchive(buildOutput, archivePath);
	console.log(`Hucode archive: ${archivePath}`);
}

async function packageDmg(options, buildRoot, distRoot, distName, signing) {
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

	if (signing) {
		await signDarwinDmg(destination, signing);
		await notarizeArtifact(destination, signing);
		await stapleArtifact(destination);
		await run('spctl', [
			'-a',
			'-vvv',
			'-t',
			'open',
			'--context',
			'context:primary-signature',
			destination
		], repoRoot);
	}

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
	], options, getLinuxPackageDepsEnv());
	await patchLinuxPackageVersion(options, buildRoot, 'deb');
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
	], options, getLinuxPackageDepsEnv());
	await patchLinuxPackageVersion(options, buildRoot, 'rpm');
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
			await packageArchive(
				options,
				paths.buildOutput,
				paths.distRoot,
				paths.distName
			);
			return;
		case 'dmg':
			await packageDmg(
				options,
				paths.buildRoot,
				paths.distRoot,
				paths.distName,
				paths.signing
			);
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
		if (options.copilotVsix) {
			await runBuildWithCopilotVsix(options, buildOutput);
		} else {
			await runGulpTask(taskName, options, getBuildEnv(options));
		}
	}

	await mixInCli(options, buildOutput);

	let signing;
	try {
		if (options.sign) {
			signing = await prepareDarwinSigning();
			await notarizeAndStapleDarwinApp(
				options,
				buildOutput,
				distRoot,
				signing
			);
		}

		for (const artifact of options.artifacts) {
			await packageArtifact(artifact, options, {
				buildOutput,
				buildRoot,
				distName,
				distRoot,
				signing
			});
		}
	} finally {
		await cleanupDarwinSigning(signing);
	}

	if (options.moveToDist) {
		await movePackage(buildOutput, distOutput);
		console.log(`Hucode build output: ${distOutput}`);
	} else {
		console.log(`Hucode build output: ${buildOutput}`);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
