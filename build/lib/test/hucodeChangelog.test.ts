/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, suite, test } from 'node:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
	checkPullRequest,
	parseConventionalHeader,
	prepareRelease,
	releaseNotes,
	renderReleaseSection,
	type ChangeFragment,
} from '../../hucode/changelog.ts';

suite('Hucode changelog', () => {

	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hucode-changelog-'));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test('parses Conventional Commit headers with breaking markers', async () => {
		assert.deepStrictEqual(
			await parseConventionalHeader(
				'build(release)!: change artifact naming'
			),
			{
				breaking: true,
				body: '',
				header: 'build(release)!: change artifact naming',
				scope: 'release',
				subject: 'change artifact naming',
				type: 'build',
			}
		);
	});

	test('renders conventional-changelog sections for all fragment types', async () => {
		const output = await renderReleaseSection([
			fragment(
				'feat',
				'release',
				'publish macOS releases',
				1234,
				'Release tags now upload signed macOS DMG assets.'
			),
			fragment('chore', 'ci', 'fix release upload filtering', 1235),
		]);

		assert.strictEqual(
			output,
			[
				'### Features',
				'',
				'- **release:** publish macOS releases (#1234)',
				'',
				'### Miscellaneous Chores',
				'',
				'- **ci:** fix release upload filtering (#1235)',
				'',
			].join('\n')
		);
	});

	test('requires matching fragments for release-note-worthy PR titles', async () => {
		await initRepo(tmpDir);
		await assert.rejects(
			() => checkPullRequest({
				baseRef: 'HEAD',
				number: 1234,
				root: tmpDir,
				title: 'feat(release): publish macOS releases',
			}),
			/requires a matching \.changes\/1234-\*\.md file/
		);
	});

	test('accepts hidden-type fragments when they are added manually', async () => {
		await initRepo(tmpDir);
		const baseRef = currentHead(tmpDir);
		await writeChange(
			tmpDir,
			'1234-fix-release-upload-filtering.md',
			'chore(ci): fix release upload filtering\n'
		);
		commitAll(tmpDir, 'chore: add change fragment');

		await checkPullRequest({
			baseRef,
			number: 1234,
			root: tmpDir,
			title: 'chore(ci): fix release upload filtering',
		});
	});

	test('requires hidden-type fragments to match the PR title', async () => {
		await initRepo(tmpDir);
		const baseRef = currentHead(tmpDir);
		await writeChange(
			tmpDir,
			'1234-fix-release-upload-filtering.md',
			'chore(ci): fix release upload filtering\n'
		);
		commitAll(tmpDir, 'chore: add change fragment');

		await assert.rejects(
			() => checkPullRequest({
				baseRef,
				number: 1234,
				root: tmpDir,
				title: 'chore(ci): update release documentation',
			}),
			/requires a matching \.changes\/1234-\*\.md file/
		);
	});

	test('rejects fragments with the wrong PR number', async () => {
		await initRepo(tmpDir);
		const baseRef = currentHead(tmpDir);
		await writeChange(
			tmpDir,
			'9999-publish-macos-releases.md',
			'feat(release): publish macOS releases\n'
		);
		commitAll(tmpDir, 'chore: add change fragment');

		await assert.rejects(
			() => checkPullRequest({
				baseRef,
				number: 1234,
				root: tmpDir,
				title: 'feat(release): publish macOS releases',
			}),
			/uses PR #9999, expected #1234/
		);
	});

	test('prepares a release from change fragments', async () => {
		await createReleaseRoot(tmpDir);
		await writeChange(
			tmpDir,
			'1234-publish-macos-releases.md',
			[
				'feat(release): publish macOS releases',
				'',
				'Release tags now upload signed macOS DMG assets.',
			].join('\n')
		);
		await writeChange(
			tmpDir,
			'1235-fix-release-upload-filtering.md',
			'chore(ci): fix release upload filtering\n'
		);
		await writeChange(
			tmpDir,
			'README.md',
			'# Change Fragments\n'
		);

		await prepareRelease({
			date: '2026-05-25',
			root: tmpDir,
			version: '0.0.19',
		});

		assert.strictEqual(
			await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8'),
			[
				'# Changelog',
				'',
				'All notable changes to Hucode are documented in this file.',
				'',
				'## 0.0.19 - 2026-05-25',
				'',
				'### Features',
				'',
				'- **release:** publish macOS releases (#1234)',
				'',
				'### Miscellaneous Chores',
				'',
				'- **ci:** fix release upload filtering (#1235)',
				'',
			].join('\n')
		);
		assert.deepStrictEqual(
			JSON.parse(await fs.readFile(productPath(tmpDir), 'utf8')),
			{ hucodeVersion: '0.0.19' }
		);
		await assert.rejects(
			() => fs.stat(
				path.join(tmpDir, '.changes', '1234-publish-macos-releases.md')
			),
			/ENOENT/
		);
	});

	test('extracts release notes for the requested version', async () => {
		await createReleaseRoot(tmpDir);
		await fs.writeFile(
			path.join(tmpDir, 'CHANGELOG.md'),
			[
				'# Changelog',
				'',
				'## 0.0.19 - 2026-05-25',
				'',
				'### Features',
				'',
				'- **release:** publish macOS releases (#1234)',
				'',
				'## 0.0.18 - 2026-05-01',
				'',
				'### Bug Fixes',
				'',
				'- fix earlier release notes (#1200)',
				'',
			].join('\n'),
			'utf8'
		);

		assert.strictEqual(
			await releaseNotes({ root: tmpDir, version: '0.0.19' }),
			[
				'## 0.0.19 - 2026-05-25',
				'',
				'### Features',
				'',
				'- **release:** publish macOS releases (#1234)',
			].join('\n')
		);
	});
});

function fragment(
	type: string,
	scope: string | null,
	subject: string,
	prNumber: number,
	body = ''
): ChangeFragment {
	return {
		body,
		breaking: false,
		filePath: `.changes/${prNumber}-${subject.replaceAll(' ', '-')}.md`,
		header: scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`,
		prNumber,
		scope,
		slug: subject.replaceAll(' ', '-'),
		subject,
		type,
	};
}

async function createReleaseRoot(root: string): Promise<void> {
	await fs.mkdir(path.dirname(productPath(root)), { recursive: true });
	await fs.mkdir(path.join(root, '.changes'), { recursive: true });
	await fs.writeFile(
		path.join(root, 'CHANGELOG.md'),
		[
			'# Changelog',
			'',
			'All notable changes to Hucode are documented in this file.',
			'',
		].join('\n'),
		'utf8'
	);
	await fs.writeFile(productPath(root), '{\n\t"hucodeVersion": "0.0.18"\n}\n');
}

async function initRepo(root: string): Promise<void> {
	await fs.mkdir(path.join(root, '.changes'), { recursive: true });
	execFileSync('git', ['init'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'hucode@example.com'], {
		cwd: root,
	});
	execFileSync('git', ['config', 'user.name', 'Hucode Test'], { cwd: root });
	await fs.writeFile(path.join(root, 'README.md'), '# Test\n', 'utf8');
	execFileSync('git', ['add', 'README.md'], { cwd: root });
	execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: root });
}

function commitAll(root: string, message: string): void {
	execFileSync('git', ['add', '.changes'], { cwd: root });
	execFileSync('git', ['commit', '-m', message], { cwd: root });
}

function currentHead(root: string): string {
	return execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: root,
		encoding: 'utf8',
	}).trim();
}

function productPath(root: string): string {
	return path.join(
		root,
		'build',
		'hucode',
		'mixin',
		'stable',
		'product.json'
	);
}

async function writeChange(
	root: string,
	name: string,
	contents: string
): Promise<void> {
	const changesRoot = path.join(root, '.changes');
	await fs.mkdir(changesRoot, { recursive: true });
	await fs.writeFile(path.join(changesRoot, name), contents, 'utf8');
}
