/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { afterEach, beforeEach, suite, test } from 'node:test';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import yauzl, { type Entry } from 'yauzl';
import {
	applyDebianPackageVersion,
	applyRpmPackageVersion,
	createStandaloneCliArchive,
	darwinCliLinkIssues,
	findBuiltInCopilotExtension,
	orderReleaseArtifactsForPackaging,
	standaloneCliArchiveName,
	standaloneCliExecutableName,
	validateAppCliArtifact,
	validateAssembledAppOutput,
	validateExtractedCopilotVsix,
	validatePackagedCopilot,
} from '../../hucode/release-build.ts';

interface ZipEntryDetails {
	name: string;
	mode: number;
}

function zipEntries(zipPath: string): Promise<ZipEntryDetails[]> {
	return new Promise((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true }, (error, zipfile) => {
			if (error || !zipfile) {
				reject(error ?? new Error(`Failed to open ZIP: ${zipPath}`));
				return;
			}

			const entries: ZipEntryDetails[] = [];
			zipfile.on('entry', (entry: Entry) => {
				entries.push({
					name: entry.fileName,
					mode: entry.externalFileAttributes >>> 16
				});
				zipfile.readEntry();
			});
			zipfile.on('end', () => resolve(entries));
			zipfile.on('error', reject);
			zipfile.readEntry();
		});
	});
}

suite('Hucode release build', () => {

	let tmpDir: string;
	const releaseBuildScript = path.resolve(
		import.meta.dirname,
		'..',
		'..',
		'hucode',
		'release-build.ts'
	);

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

	test('validates assembled app output before packaging', async () => {
		const buildOutput = path.join(tmpDir, 'VSCode-linux-x64');
		await createPackagedCopilotExtension(buildOutput, 'linux-x64');
		await createAppProduct(
			path.join(buildOutput, 'resources', 'app', 'product.json')
		);
		const cliPath = path.join(buildOutput, 'bin', 'hucode-tunnel');
		await fs.mkdir(path.dirname(cliPath), { recursive: true });
		await fs.writeFile(cliPath, '');
		await fs.chmod(cliPath, 0o755);

		await validateAssembledAppOutput(
			{ platform: 'linux', arch: 'x64' },
			buildOutput
		);
	});

	test('rejects assembled app output without final payloads', async () => {
		const buildOutput = path.join(tmpDir, 'VSCode-linux-x64');
		await createAppProduct(
			path.join(buildOutput, 'resources', 'app', 'product.json')
		);

		await assert.rejects(
			validateAssembledAppOutput(
				{ platform: 'linux', arch: 'x64' },
				buildOutput
			),
			/Built-in Copilot extension not found/
		);
	});

	test('rejects moving build-only phase output to dist', () => {
		const result = spawnSync(
			process.execPath,
			[
				releaseBuildScript,
				'--phase',
				'build',
				'--move-to-dist'
			],
			{ encoding: 'utf8' }
		);

		assert.strictEqual(result.status, 1);
		assert.match(
			result.stderr,
			/--move-to-dist cannot be used with --phase build/
		);
	});

	test('rejects prebuilt CLI input during package-only phase', () => {
		const result = spawnSync(
			process.execPath,
			[
				releaseBuildScript,
				'--phase',
				'package',
				'--prebuilt-cli',
				path.join(tmpDir, 'hucode-tunnel')
			],
			{ encoding: 'utf8' }
		);

		assert.strictEqual(result.status, 1);
		assert.match(
			result.stderr,
			/--prebuilt-cli cannot be used with --phase package/
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

	test('orders release artifacts for packaging', () => {
		const cases = [
			{
				platform: 'darwin' as const,
				sign: true,
				artifacts: ['archive', 'dmg'] as const
			},
			{
				platform: 'darwin' as const,
				sign: false,
				artifacts: ['archive', 'dmg'] as const
			},
			{
				platform: 'linux' as const,
				sign: true,
				artifacts: ['archive', 'deb'] as const
			}
		];

		assert.deepStrictEqual(
			cases.map(({ platform, sign, artifacts }) =>
				orderReleaseArtifactsForPackaging(platform, sign, [...artifacts])
			),
			[
				['dmg', 'archive'],
				['archive', 'dmg'],
				['archive', 'deb']
			]
		);
	});

	test('names standalone CLI archives for each release platform', () => {
		assert.deepStrictEqual(
			[
				{ platform: 'darwin' as const, arch: 'x64' as const },
				{ platform: 'linux' as const, arch: 'arm64' as const },
				{ platform: 'win32' as const, arch: 'arm64' as const }
			].map(standaloneCliArchiveName),
			[
				'hucode-cli-darwin-x64.zip',
				'hucode-cli-linux-arm64.tar.gz',
				'hucode-cli-win32-arm64.zip'
			]
		);
	});

	test('uses the public product name inside standalone CLI archives', () => {
		assert.deepStrictEqual(
			['darwin', 'linux', 'win32'].map(platform =>
				standaloneCliExecutableName(
					platform as 'darwin' | 'linux' | 'win32'
				)
			),
			['hucode', 'hucode', 'hucode.exe']
		);
	});

	test('packages standalone CLI archives with one root executable', async () => {
		const source = path.join(tmpDir, 'hucode-tunnel');
		await fs.writeFile(source, 'cli');
		await fs.chmod(source, 0o755);

		for (const platform of ['darwin', 'linux', 'win32'] as const) {
			const archive = await createStandaloneCliArchive(
				{ platform, arch: 'x64' },
				source,
				tmpDir
			);
			const executable = standaloneCliExecutableName(platform);
			const entries = platform === 'linux'
				? spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
					.stdout.trim().split(/\r?\n/)
				: (await zipEntries(archive)).map(entry => entry.name);
			assert.deepStrictEqual(
				entries,
				[executable]
			);

			if (platform === 'darwin') {
				const [entry] = await zipEntries(archive);
				assert.notStrictEqual(entry.mode & 0o111, 0);
			} else if (platform === 'linux') {
				const extractRoot = path.join(tmpDir, `extract-${platform}`);
				await fs.mkdir(extractRoot);
				const result = spawnSync(
					'tar',
					['-xzf', archive, '-C', extractRoot],
					{ encoding: 'utf8' }
				);
				assert.strictEqual(result.status, 0, result.stderr);
				const stat = await fs.stat(path.join(extractRoot, executable));
				assert.notStrictEqual(stat.mode & 0o111, 0);
			}
		}
	});

	test('flags Homebrew OpenSSL runtime links in macOS CLI', () => {
		const issues = darwinCliLinkIssues(`
/Applications/Hucode.app/Contents/Resources/app/bin/hucode-tunnel:
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)
\t/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib (compatibility version 3.0.0)
\t/usr/local/opt/openssl@3/lib/libcrypto.3.dylib (compatibility version 3.0.0)
`);

		assert.deepStrictEqual(
			issues.map(issue => issue.library),
			[
				'/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib',
				'/usr/local/opt/openssl@3/lib/libcrypto.3.dylib'
			]
		);
	});

	test('allows system macOS CLI runtime links', () => {
		assert.deepStrictEqual(
			darwinCliLinkIssues(`
/Applications/Hucode.app/Contents/Resources/app/bin/hucode-tunnel:
\t/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation
\t/usr/lib/libSystem.B.dylib
`),
			[]
		);
	});

	test('patches Debian package version from Hucode release metadata', () => {
		assert.strictEqual(
			applyDebianPackageVersion(
				'Package: hucode\nVersion: 1.119.1-1757688183\n',
				'0.48.0'
			),
			'Package: hucode\nVersion: 0.48.0-1757688183\n'
		);
	});

	test('patches RPM package version from Hucode release metadata', () => {
		assert.strictEqual(
			applyRpmPackageVersion(
				'Name: hucode\nVersion:  1.119.1\nRelease: 1757688183\n',
				'0.48.0'
			),
			'Name: hucode\nVersion:  0.48.0\nRelease: 1757688183\n'
		);
	});

	test('rejects Debian package metadata without version field', () => {
		assert.throws(
			() => applyDebianPackageVersion('Package: hucode\n', '0.48.0'),
			/DEB control file does not contain a Version field/
		);
	});

	test('validates Linux CLI artifact in packaged app output', async () => {
		const buildOutput = path.join(tmpDir, 'VSCode-linux-x64');
		await createAppProduct(
			path.join(buildOutput, 'resources', 'app', 'product.json')
		);
		const cliPath = path.join(buildOutput, 'bin', 'hucode-tunnel');
		await fs.mkdir(path.dirname(cliPath), { recursive: true });
		await fs.writeFile(cliPath, '');
		await fs.chmod(cliPath, 0o755);

		assert.strictEqual(
			await validateAppCliArtifact(
				{ platform: 'linux', arch: 'x64' },
				buildOutput
			),
			cliPath
		);
	});

	test('validates macOS CLI artifact in app resources', async () => {
		const buildOutput = path.join(tmpDir, 'VSCode-darwin-arm64');
		const appRoot = path.join(buildOutput, 'Hucode.app');
		await createAppProduct(
			path.join(
				appRoot,
				'Contents',
				'Resources',
				'app',
				'product.json'
			)
		);
		const cliPath = path.join(
			appRoot,
			'Contents',
			'Resources',
			'app',
			'bin',
			'hucode-tunnel'
		);
		await fs.mkdir(path.dirname(cliPath), { recursive: true });
		await fs.writeFile(cliPath, '');
		await fs.chmod(cliPath, 0o755);

		assert.strictEqual(
			await validateAppCliArtifact(
				{ platform: 'darwin', arch: 'arm64' },
				buildOutput
			),
			cliPath
		);
	});

	test('rejects missing Hucode CLI artifact', async () => {
		const buildOutput = path.join(tmpDir, 'VSCode-win32-x64');
		await createAppProduct(
			path.join(buildOutput, 'resources', 'app', 'product.json')
		);

		await assert.rejects(
			validateAppCliArtifact(
				{ platform: 'win32', arch: 'x64' },
				buildOutput
			),
			/Hucode CLI artifact not found/
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

	async function createAppProduct(productPath: string): Promise<void> {
		await fs.mkdir(path.dirname(productPath), { recursive: true });
		await fs.writeFile(
			productPath,
			JSON.stringify({
				nameLong: 'Hucode',
				tunnelApplicationName: 'hucode-tunnel'
			})
		);
	}
});
