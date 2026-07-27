/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
			fragment('feat', 'deps', 'upgrade VS Code baseline to 1.122.0'),
		]);

		assert.strictEqual(
			output,
			[
				'### Features',
				'',
				'- **deps:** upgrade VS Code baseline to 1.122.0',
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
			/requires a matching \.changes\/1234-\*\.md or \.changes\/<slug>\.md file/
		);
	});

	test('accepts hidden-type fragments when they are added manually', async () => {
		await initRepo(tmpDir);
		const baseRef = currentHead(tmpDir);
		await writeChange(
			tmpDir,
			'fix-release-upload-filtering.md',
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
			/requires a matching \.changes\/1234-\*\.md or \.changes\/<slug>\.md file/
		);
	});

	test('accepts an integration PR carrying other PRs fragments', async () => {
		// A branch that merged several numbered PRs adds all their fragments
		// at once. No single title can match more than one of them, and each
		// was validated by the PR that introduced it.
		await initRepo(tmpDir);
		const baseRef = currentHead(tmpDir);
		await writeChange(
			tmpDir,
			'109-release-destroyed-omni-controllers.md',
			'fix(omni): release destroyed hosted workspace controllers\n'
		);
		await writeChange(
			tmpDir,
			'112-attest-release-checksums.md',
			'feat(release): attest release asset provenance\n'
		);
		commitAll(tmpDir, 'chore: merge feature branches');

		await checkPullRequest({
			baseRef,
			number: 113,
			root: tmpDir,
			title: 'chore: merge the hardening base into mainline',
		});
	});

	test('accepts a sibling fragment inherited from a base merge', async () => {
		// Merging an updated base pulls in whatever fragment landed there
		// meanwhile. That is not this PR forgetting its own.
		await initRepo(tmpDir);
		const baseRef = currentHead(tmpDir);
		await writeChange(
			tmpDir,
			'109-release-destroyed-omni-controllers.md',
			'fix(omni): release destroyed hosted workspace controllers\n'
		);
		commitAll(tmpDir, 'chore: merge base');

		await checkPullRequest({
			baseRef,
			number: 110,
			root: tmpDir,
			title: 'ci: smoke Omni startup from the release build app artifact',
		});
	});

	test('still requires this PR to document its own user-facing change',
		async () => {
			// The carried fragment must not excuse a `feat:` title from
			// having a fragment of its own.
			await initRepo(tmpDir);
			const baseRef = currentHead(tmpDir);
			await writeChange(
				tmpDir,
				'109-release-destroyed-omni-controllers.md',
				'fix(omni): release destroyed hosted workspace controllers\n'
			);
			commitAll(tmpDir, 'chore: merge base');

			await assert.rejects(
				() => checkPullRequest({
					baseRef,
					number: 110,
					root: tmpDir,
					title: 'feat(omni): add a new thing',
				}),
				/requires a matching \.changes\/110-\*\.md or \.changes\/<slug>\.md file/
			);
		});

	test('still requires an unnumbered fragment to match the title', async () => {
		// Unnumbered fragments have no owner, so they are this PR's to match.
		await initRepo(tmpDir);
		const baseRef = currentHead(tmpDir);
		await writeChange(
			tmpDir,
			'some-unnumbered-change.md',
			'fix(omni): something else entirely\n'
		);
		commitAll(tmpDir, 'chore: add fragment');

		await assert.rejects(
			() => checkPullRequest({
				baseRef,
				number: 113,
				root: tmpDir,
				title: 'ci: unrelated title',
			}),
			/requires a matching \.changes\/113-\*\.md or \.changes\/<slug>\.md file/
		);
	});

	test('accepts numbered backfill fragments for prior PRs', async () => {
		await initRepo(tmpDir);
		const baseRef = currentHead(tmpDir);
		await writeChange(
			tmpDir,
			'59-decouple-omni-from-agent-session-ui.md',
			'refactor: decouple Omni from agent-session UI\n'
		);
		await writeChange(
			tmpDir,
			'1234-retain-pr-attribution-for-unnumbered-fragments.md',
			'fix(changelog): retain PR attribution for unnumbered fragments\n'
		);
		commitAll(tmpDir, 'fix(changelog): retain PR attribution');

		await checkPullRequest({
			baseRef,
			number: 1234,
			root: tmpDir,
			title: 'fix(changelog): retain PR attribution for unnumbered fragments',
		});
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
			'fix-release-upload-filtering.md',
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
				'- **ci:** fix release upload filtering',
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

	test('infers PR numbers from unnumbered fragment commits', async () => {
		await createReleaseRoot(tmpDir);
		initGitRepo(tmpDir);
		execFileSync('git', ['add', 'CHANGELOG.md', 'build'], {
			cwd: tmpDir,
		});
		execFileSync('git', ['commit', '-m', 'chore: initial commit'], {
			cwd: tmpDir,
		});
		await writeChange(
			tmpDir,
			'keep-missing-hosted-worktrees-reachable.md',
			'fix: keep missing hosted worktrees reachable\n'
		);
		commitAll(
			tmpDir,
			'fix: keep missing hosted worktrees reachable (#60)'
		);

		await prepareRelease({
			date: '2026-06-08',
			root: tmpDir,
			version: '0.0.25',
		});

		assert.match(
			await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8'),
			/- keep missing hosted worktrees reachable \(#60\)/
		);
	});

	test('infers PR numbers from GitHub merge commits', async () => {
		await createReleaseRoot(tmpDir);
		initGitRepo(tmpDir);
		execFileSync('git', ['add', 'CHANGELOG.md', 'build'], {
			cwd: tmpDir,
		});
		execFileSync('git', ['commit', '-m', 'chore: initial commit'], {
			cwd: tmpDir,
		});
		execFileSync('git', ['branch', '-M', 'main'], { cwd: tmpDir });
		execFileSync('git', ['checkout', '-b', 'keep-worktrees'], {
			cwd: tmpDir,
			stdio: 'ignore',
		});
		await writeChange(
			tmpDir,
			'keep-missing-hosted-worktrees-reachable.md',
			'fix: keep missing hosted worktrees reachable\n'
		);
		commitAll(tmpDir, 'fix: keep missing hosted worktrees reachable');
		execFileSync('git', ['checkout', 'main'], {
			cwd: tmpDir,
			stdio: 'ignore',
		});
		execFileSync('git', [
			'merge',
			'--no-ff',
			'keep-worktrees',
			'-m',
			'Merge pull request #61 from jimeh/keep-worktrees',
		], {
			cwd: tmpDir,
			stdio: 'ignore',
		});

		await prepareRelease({
			date: '2026-06-08',
			root: tmpDir,
			version: '0.0.25',
		});

		assert.match(
			await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8'),
			/- keep missing hosted worktrees reachable \(#61\)/
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
	prNumber?: number,
	body = ''
): ChangeFragment {
	const slug = subject.replaceAll(' ', '-');
	return {
		body,
		breaking: false,
		filePath: `.changes/${prNumber === undefined ? '' : `${prNumber}-`}${slug}.md`,
		header: scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`,
		prNumber,
		scope,
		slug,
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
	initGitRepo(root);
	await fs.writeFile(path.join(root, 'README.md'), '# Test\n', 'utf8');
	execFileSync('git', ['add', 'README.md'], { cwd: root });
	execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: root });
}

function initGitRepo(root: string): void {
	execFileSync('git', ['init'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'hucode@example.com'], {
		cwd: root,
	});
	execFileSync('git', ['config', 'user.name', 'Hucode Test'], { cwd: root });
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
