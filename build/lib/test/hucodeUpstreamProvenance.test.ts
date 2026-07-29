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

		assert.strictEqual(suites.length, 11);
		assert.strictEqual(new Set(suites.map(entry => entry.file)).size, 11);
		assert.ok(suites.every(entry => entry.reason.length > 10));
		assert.ok(suites.some(entry =>
			entry.file.endsWith('extensionEnablementService.test.ts')
		));
	});

	test('records baseline blobs for every fork and the E1 seam', () => {
		const tracked = UPSTREAM_PROVENANCE.surfaces.filter(
			surface => surface.upstream
		);

		assert.deepStrictEqual(
			tracked.map(surface => surface.path).sort(),
			[
				'src/vs/hucode/browser/parts/auxiliaryBarPart.ts',
				'src/vs/hucode/browser/parts/panelPart.ts',
				'src/vs/hucode/browser/parts/titlebarPart.ts',
				'src/vs/hucode/browser/workbench.ts',
				'src/vs/workbench/services/extensionManagement/browser/'
					+ 'extensionEnablementService.ts',
			]
		);
		assert.ok(tracked.every(surface =>
			surface.upstream?.lastSyncedBaseline === '1.130.0'
		));
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
