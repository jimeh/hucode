/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { suite, test } from 'node:test';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import {
	UPSTREAM_PROVENANCE,
	checkUpstreamDrift,
	discoverForkedFiles,
	upstreamSuitesFromProvenance,
	validateProvenance,
	validateProvenanceData,
	type UpstreamProvenance
} from '../../hucode/upstream-provenance.ts';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
	fileURLToPath(new URL('../../../', import.meta.url))
);
const upgradeSkillPath = path.join(
	repoRoot,
	'.agents/skills/hucode-upgrade-vscode/SKILL.md'
);

function copyProvenance(): UpstreamProvenance {
	return structuredClone(UPSTREAM_PROVENANCE);
}

async function git(repo: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(
		'git',
		['-c', 'commit.gpgSign=false', ...args],
		{ cwd: repo }
	);
	return stdout.trim();
}

suite('Hucode upstream provenance', () => {

	test('discovers the four deliberate Omni workbench forks', async () => {
		assert.deepStrictEqual(
			await discoverForkedFiles(repoRoot),
			[
				'src/vs/hucode/browser/parts/auxiliaryBarPart.ts',
				'src/vs/hucode/browser/parts/panelPart.ts',
				'src/vs/hucode/browser/parts/titlebarPart.ts',
				'src/vs/hucode/browser/workbench.ts',
			]
		);
	});

	test('discovers a Microsoft-only copied Part', async t => {
		const fixture = await fs.mkdtemp(
			path.join(os.tmpdir(), 'hucode-fork-discovery-')
		);
		t.after(() => fs.rm(fixture, { recursive: true, force: true }));
		const target = 'src/vs/hucode/browser/parts/copiedPart.ts';
		const upstream = 'src/vs/sessions/browser/parts/copiedPart.ts';
		await fs.mkdir(path.dirname(path.join(fixture, target)), {
			recursive: true,
		});
		await fs.mkdir(path.dirname(path.join(fixture, upstream)), {
			recursive: true,
		});
		const source = [
			'/*',
			' * Copyright (c) Microsoft Corporation. All rights reserved.',
			' */',
			'export class CopiedPart { }',
			'',
		].join('\n');
		await fs.writeFile(path.join(fixture, target), source);
		await fs.writeFile(path.join(fixture, upstream), source);

		assert.deepStrictEqual(
			await discoverForkedFiles(fixture),
			[target]
		);
	});

	test('runs drift detection before switching to the clean upstream tree', async () => {
		const skill = await fs.readFile(upgradeSkillPath, 'utf8');
		const sectionStart = skill.indexOf('## Create The New Baseline');
		const sectionEnd = skill.indexOf('## Replay Onto The New Series');
		assert.ok(sectionStart >= 0, 'baseline section must exist');
		assert.ok(sectionEnd > sectionStart, 'replay section must follow it');
		const section = skill.slice(sectionStart, sectionEnd);
		const fetchTag = section.indexOf(
			'git fetch "$VSCODE_REMOTE" tag <new-version>'
		);
		const driftCheck = section.indexOf(
			'npm run hucode:check-upstream-provenance'
		);
		const switchUpstream = section.indexOf(
			'git switch --create upstream-<new-version> <new-version>'
		);
		const publishUpstream = section.indexOf(
			'git push -u origin upstream-<new-version>'
		);
		const switchSeries = section.indexOf(
			'git switch --create series-<new-version> '
				+ 'upstream-<new-version>'
		);

		assert.ok(fetchTag >= 0, 'upgrade workflow must fetch the new tag');
		assert.ok(driftCheck >= 0, 'upgrade workflow must run drift detection');
		assert.ok(
			switchUpstream >= 0,
			'upgrade workflow must create the clean upstream branch'
		);
		assert.ok(
			publishUpstream >= 0,
			'upgrade workflow must publish the clean upstream branch'
		);
		assert.ok(
			switchSeries >= 0,
			'upgrade workflow must create the local series branch'
		);
		assert.ok(
			fetchTag < driftCheck
				&& driftCheck < switchUpstream
				&& switchUpstream < publishUpstream
				&& publishUpstream < switchSeries,
			'workflow must check drift from the Hucode checkout, then create '
				+ 'and publish the clean upstream branch before the series'
		);
	});

	test('repository provenance is complete and internally valid', async () => {
		assert.deepStrictEqual(
			await validateProvenance(repoRoot, UPSTREAM_PROVENANCE),
			[]
		);
	});

	test('a newly unregistered fork fails repository completeness', async () => {
		const provenance = copyProvenance();
		provenance.surfaces = provenance.surfaces.filter(
			surface => surface.path !==
				'src/vs/hucode/browser/parts/panelPart.ts'
		);

		assert.match(
			(await validateProvenance(repoRoot, provenance)).join('\n'),
			/missing a fork entry.*panelPart\.ts/
		);
	});

	test('dead fork entries fail repository completeness', async () => {
		const provenance = copyProvenance();
		const fork = provenance.surfaces.find(
			surface => surface.kind === 'fork'
		);
		assert.ok(fork);

		provenance.surfaces.push({
			...structuredClone(fork),
			path: 'src/vs/hucode/browser/parts/missingPart.ts',
		});

		assert.match(
			(await validateProvenance(repoRoot, provenance)).join('\n'),
			/dead fork entry.*missingPart\.ts/
		);
	});

	test('duplicate suite ownership fails schema validation', () => {
		const provenance = copyProvenance();
		const suiteOwner = provenance.surfaces.find(
			surface => surface.testSuites.length > 0
		);
		assert.ok(suiteOwner);

		provenance.surfaces.push({
			path: 'src/vs/hucode/test/duplicate-suite-owner.ts',
			kind: 'hucode-owned-upstream-path',
			reason: 'test fixture duplicates ownership of an upstream suite',
			testSuites: [structuredClone(suiteOwner.testSuites[0])],
		});

		assert.match(
			validateProvenanceData(provenance).join('\n'),
			/suite is owned by more than one surface/
		);
	});

	test('malformed provenance fails schema validation', () => {
		assert.deepStrictEqual(
			validateProvenanceData({
				schemaVersion: 2,
				surfaces: [{
					path: '',
					kind: 'fork',
					reason: '',
					testSuites: [],
					upstream: {
						path: '',
						lastSyncedBaseline: 'main',
						blob: 'not-a-blob',
					},
				}],
			}),
			[
				'Unsupported provenance schema version: 2',
				'Surface 0 has no repository-relative path.',
				'Surface 0 has no reason.',
				'Surface 0 upstream path is missing.',
				'Surface 0 upstream baseline must be a release version.',
				'Surface 0 upstream blob must be a 40-character Git object ID.',
			]
		);
	});

	test('derives all upstream-named suites and reasons from provenance', () => {
		const suites = upstreamSuitesFromProvenance(UPSTREAM_PROVENANCE);

		assert.deepStrictEqual(
			suites.map(entry => entry.file),
			[
				'src/vs/platform/browserView/test/common/'
					+ 'browserViewLayout.test.ts',
				'src/vs/platform/browserView/test/electron-main/'
					+ 'browserViewHostedWebContents.test.ts',
				'src/vs/platform/browserView/test/electron-main/'
					+ 'browserViewNativeHost.test.ts',
				'src/vs/platform/extensionManagement/test/node/'
					+ 'extensionSignatureVerificationService.test.ts',
				'src/vs/platform/projectManager/test/common/'
					+ 'projectManagerState.test.ts',
				'src/vs/platform/projectManager/test/electron-main/'
					+ 'projectManagerMainService.test.ts',
				'src/vs/platform/utilityProcess/test/electron-main/'
					+ 'utilityProcess.test.ts',
				'src/vs/platform/windows/test/electron-main/'
					+ 'windowsFinder.test.ts',
				'src/vs/workbench/contrib/browserView/test/common/'
					+ 'browserViewOwnership.test.ts',
				'src/vs/workbench/contrib/browserView/test/electron-browser/'
					+ 'overlayManager.test.ts',
				'src/vs/workbench/services/extensionManagement/test/browser/'
					+ 'extensionEnablementService.test.ts',
			]
		);
		assert.ok(suites.every(entry => entry.reason.length > 10));
	});

	test('records baseline blobs for every fork and tracked upstream seam', () => {
		const tracked = UPSTREAM_PROVENANCE.surfaces.filter(
			surface => surface.upstream
		);
		const expectedPaths = [
			'cli/src/commands/args.rs',
			'cli/src/commands/serve_web.rs',
			'src/vs/code/browser/workbench/workbench.ts',
			'src/vs/hucode/browser/parts/auxiliaryBarPart.ts',
			'src/vs/hucode/browser/parts/panelPart.ts',
			'src/vs/hucode/browser/parts/titlebarPart.ts',
			'src/vs/hucode/browser/workbench.ts',
			'src/vs/platform/storage/common/storageIpc.ts',
			'src/vs/platform/storage/common/storageService.ts',
			'src/vs/platform/storage/electron-main/storageIpc.ts',
			'src/vs/server/node/remoteExtensionHostAgentServer.ts',
			'src/vs/server/node/serverEnvironmentService.ts',
			'src/vs/server/node/serverServices.ts',
			'src/vs/server/node/webClientServer.ts',
			'src/vs/sessions/browser/web.main.ts',
			'src/vs/sessions/contrib/automations/browser/'
				+ 'automationStorageService.ts',
			'src/vs/workbench/browser/web.factory.ts',
			'src/vs/workbench/browser/web.main.ts',
			'src/vs/workbench/services/environment/browser/'
				+ 'environmentService.ts',
			'src/vs/workbench/services/extensionManagement/browser/'
				+ 'extensionEnablementService.ts',
			'src/vs/workbench/services/storage/browser/storageService.ts',
		].sort();
		const legacyBaselines = new Set([
			'src/vs/hucode/browser/parts/auxiliaryBarPart.ts',
			'src/vs/hucode/browser/parts/panelPart.ts',
			'src/vs/hucode/browser/parts/titlebarPart.ts',
			'src/vs/workbench/services/extensionManagement/browser/'
				+ 'extensionEnablementService.ts',
		]);

		assert.deepStrictEqual(tracked.map(surface => surface.path).sort(), expectedPaths);
		for (const surface of tracked) {
			assert.strictEqual(
				surface.upstream?.lastSyncedBaseline,
				legacyBaselines.has(surface.path) ? '1.130.0' : '1.131.0',
				`unexpected baseline for ${surface.path}`,
			);
			assert.match(surface.upstream?.blob ?? '', /^[0-9a-f]{40}$/);
		}
	});

	test('remote server owns the setup-service lifecycle', async () => {
		const server = await fs.readFile(
			path.join(repoRoot, 'src/vs/server/node/remoteExtensionHostAgentServer.ts'),
			'utf8',
		);
		const setup = await fs.readFile(
			path.join(repoRoot, 'src/vs/server/node/serverServices.ts'),
			'utf8',
		);

		assert.match(server, /constructor\(\s*serverServices: IDisposable,/);
		assert.match(server, /this\._register\(serverServices\);/);
		assert.match(
			server,
			/createInstance\(RemoteExtensionHostAgentServer, serverServices, socketServer,/,
		);
		assert.match(
			setup,
			/serverServices: hucodeWebUserDataServer\.createServerServicesDisposal\(disposables\)/,
		);
	});

	test('compares the supplied ref instead of a patched worktree copy', async t => {
		const fixture = await fs.mkdtemp(
			path.join(os.tmpdir(), 'hucode-upstream-provenance-')
		);
		t.after(() => fs.rm(fixture, { recursive: true, force: true }));

		await git(fixture, 'init');
		await git(fixture, 'config', 'user.email', 'test@example.com');
		await git(fixture, 'config', 'user.name', 'Hucode Test');
		await fs.mkdir(path.join(fixture, 'src'), { recursive: true });
		await fs.writeFile(
			path.join(fixture, 'src/subject.ts'),
			'export const value = 1;\n'
		);
		await git(fixture, 'add', '.');
		await git(fixture, 'commit', '-m', 'baseline');
		await git(fixture, 'branch', 'upstream-1.0.0');
		const blob = await git(
			fixture,
			'rev-parse',
			'upstream-1.0.0:src/subject.ts'
		);

		const provenance: UpstreamProvenance = {
			schemaVersion: 1,
			surfaces: [{
				path: 'src/subject.ts',
				kind: 'upstream-patch',
				reason: 'fixture for same-path worktree patch isolation',
				upstream: {
					path: 'src/subject.ts',
					lastSyncedBaseline: '1.0.0',
					blob,
				},
				testSuites: [],
			}],
		};

		await fs.writeFile(
			path.join(fixture, 'src/subject.ts'),
			'export const value = 99;\n'
		);
		assert.deepStrictEqual(
			await checkUpstreamDrift(
				fixture,
				provenance,
				'upstream-1.0.0'
			),
			[]
		);

		await git(fixture, 'add', 'src/subject.ts');
		await git(fixture, 'commit', '-m', 'candidate');
		await git(fixture, 'branch', 'upstream-2.0.0');
		assert.match(
			(await checkUpstreamDrift(
				fixture,
				provenance,
				'upstream-2.0.0'
			)).join('\n'),
			/upstream source changed.*src\/subject\.ts/
		);
	});

	test('reports a source missing from the supplied upstream ref', async t => {
		const fixture = await fs.mkdtemp(
			path.join(os.tmpdir(), 'hucode-upstream-provenance-missing-')
		);
		t.after(() => fs.rm(fixture, { recursive: true, force: true }));

		await git(fixture, 'init');
		await git(fixture, 'config', 'user.email', 'test@example.com');
		await git(fixture, 'config', 'user.name', 'Hucode Test');
		await fs.writeFile(path.join(fixture, 'README.md'), 'fixture\n');
		await git(fixture, 'add', '.');
		await git(fixture, 'commit', '-m', 'baseline');

		const provenance: UpstreamProvenance = {
			schemaVersion: 1,
			surfaces: [{
				path: 'README.md',
				kind: 'upstream-patch',
				reason: 'fixture for a removed upstream source',
				upstream: {
					path: 'src/upstream/missing.ts',
					lastSyncedBaseline: '1.0.0',
					blob: '0123456789abcdef0123456789abcdef01234567',
				},
				testSuites: [],
			}],
		};

		assert.match(
			(await checkUpstreamDrift(
				fixture,
				provenance,
				'HEAD'
			)).join('\n'),
			/cannot read.*src\/upstream\/missing\.ts.*HEAD/
		);
	});
});
