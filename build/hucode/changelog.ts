/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const changeFilePattern = /^(?:(\d+)-)?([a-z0-9][a-z0-9-]*)\.md$/;
const conventionalParserOptions = {
	headerCorrespondence: ['type', 'scope', 'subject'],
	headerPattern: /^(\w*)(?:\((.*)\))?!?: (.*)$/,
	noteKeywords: ['BREAKING CHANGE', 'BREAKING-CHANGE'],
};
const conventionalTypes: ConventionalType[] = [
	{ type: 'feat', section: 'Features' },
	{ type: 'fix', section: 'Bug Fixes' },
	{ type: 'perf', section: 'Performance Improvements' },
	{ type: 'revert', section: 'Reverts' },
	{ type: 'docs', section: 'Documentation', hidden: true },
	{ type: 'style', section: 'Styles', hidden: true },
	{ type: 'chore', section: 'Miscellaneous Chores', hidden: true },
	{ type: 'refactor', section: 'Code Refactoring', hidden: true },
	{ type: 'test', section: 'Tests', hidden: true },
	{ type: 'build', section: 'Build System', hidden: true },
	{ type: 'ci', section: 'Continuous Integration', hidden: true },
];

interface ConventionalType {
	type: string;
	section: string;
	hidden?: boolean;
}

export interface ParsedChange {
	breaking: boolean;
	body: string;
	header: string;
	scope: string | null;
	subject: string;
	type: string;
}

export interface ChangeFragment extends ParsedChange {
	filePath: string;
	prNumber?: number;
	slug: string;
}

interface PullRequestContext {
	baseRef?: string;
	number: number;
	title: string;
}

export interface CheckPullRequestOptions extends PullRequestContext {
	root: string;
}

export interface PrepareReleaseOptions {
	date: string;
	root: string;
	version: string;
}

export interface ReleaseNotesOptions {
	root: string;
	version: string;
}

interface CliOptions {
	baseRef?: string;
	date?: string;
	out?: string;
	prNumber?: number;
	title?: string;
	version?: string;
}

/**
 * Validates a pull request title and its `.changes` fragments.
 */
export async function checkPullRequest(
	options: CheckPullRequestOptions
): Promise<void> {
	const title = await parseConventionalHeader(options.title);
	const addedFiles = getAddedChangeFiles(options.root, options.baseRef);
	const fragments = await Promise.all(
		addedFiles.map(filePath => readChangeFragment(options.root, filePath))
	);
	for (const fragment of fragments) {
		if (
			fragment.prNumber !== undefined &&
			fragment.prNumber !== options.number &&
			headersMatch(title, fragment)
		) {
			throw new Error(
				`${fragment.filePath} uses PR #${fragment.prNumber}, expected ` +
				`#${options.number}.`
			);
		}
	}

	const requiredChangeTypes = await getRequiredChangeTypes();
	const needsFragment = title.breaking || requiredChangeTypes.has(title.type);

	// A fragment already numbered for a different pull request belongs to that
	// pull request, which validated it on the way in. Two cases produce them
	// here and neither means this title is missing a fragment: an integration
	// branch carrying several merged pull requests, and an ordinary branch that
	// merged a base which had just gained one. Requiring this title to match
	// them is impossible when there is more than one, and wrong when there is
	// one.
	const ownFragments = fragments.filter(fragment =>
		fragment.prNumber === undefined || fragment.prNumber === options.number
	);

	// Only a fragment this pull request owns can satisfy the requirement. The
	// mis-numbering guard above already rejects a carried fragment whose header
	// matches, so this cannot change an outcome today — it keeps the two rules
	// from disagreeing if that guard is ever relaxed.
	const matchingFragments = ownFragments.filter(fragment =>
		headersMatch(title, fragment)
	);
	const hasAnyFragment = ownFragments.length > 0;
	if ((needsFragment || hasAnyFragment) && matchingFragments.length === 0) {
		throw new Error(
			`PR title '${options.title}' requires a matching .changes/` +
			`${options.number}-*.md or .changes/<slug>.md file.`
		);
	}
}

/**
 * Consumes all `.changes` fragments, updates CHANGELOG.md, and bumps hucodeVersion.
 */
export async function prepareRelease(
	options: PrepareReleaseOptions
): Promise<void> {
	validateVersion(options.version);
	const fragments = await readAllChangeFragments(options.root);
	if (fragments.length === 0) {
		throw new Error('No .changes fragments found.');
	}
	inferMissingFragmentPrNumbers(options.root, fragments);

	const changelogPath = path.join(options.root, 'CHANGELOG.md');
	const productPath = path.join(
		options.root,
		'build',
		'hucode',
		'mixin',
		'stable',
		'product.json'
	);
	const changelog = await readChangelog(changelogPath);
	if (hasVersionSection(changelog, options.version)) {
		throw new Error(`CHANGELOG.md already contains ${options.version}.`);
	}

	await fs.writeFile(
		changelogPath,
		insertReleaseSection(
			changelog,
			options.version,
			options.date,
			await renderReleaseSection(fragments)
		),
		'utf8'
	);

	const product = JSON.parse(await fs.readFile(productPath, 'utf8'));
	product.hucodeVersion = options.version;
	await fs.writeFile(
		productPath,
		`${JSON.stringify(product, null, '\t')}\n`,
		'utf8'
	);

	await Promise.all(
		fragments.map(fragment =>
			fs.rm(path.join(options.root, fragment.filePath), { force: true })
		)
	);
}

/**
 * Extracts release notes for a version from CHANGELOG.md.
 */
export async function releaseNotes(
	options: ReleaseNotesOptions
): Promise<string> {
	validateVersion(options.version);
	const changelog = await fs.readFile(
		path.join(options.root, 'CHANGELOG.md'),
		'utf8'
	);
	const section = extractVersionSection(changelog, options.version);
	if (!section) {
		throw new Error(`CHANGELOG.md does not contain ${options.version}.`);
	}

	return section;
}

/**
 * Parses and validates one Conventional Commit header.
 */
export async function parseConventionalHeader(
	message: string
): Promise<ParsedChange> {
	const header = firstNonEmptyLine(message);
	if (!header) {
		throw new Error('Expected a Conventional Commit header.');
	}

	const { default: parseCommit } = await import('@commitlint/parse');
	const parsed = await parseCommit(
		header,
		undefined,
		conventionalParserOptions
	);
	if (!parsed.type || !parsed.subject) {
		throw new Error(`Invalid Conventional Commit header: ${header}`);
	}

	const allowedTypes = await getAllowedTypes();
	if (!allowedTypes.has(parsed.type)) {
		throw new Error(
			`Unsupported change type '${parsed.type}'. Allowed types: ` +
			`${[...allowedTypes].join(', ')}.`
		);
	}

	return {
		breaking: isBreakingHeader(header) || parsed.notes.length > 0,
		body: bodyAfterHeader(message),
		header,
		scope: parsed.scope || null,
		subject: stripPullRequestSuffix(parsed.subject),
		type: parsed.type,
	};
}

/**
 * Renders parsed fragments using conventional-changelog section names.
 */
export async function renderReleaseSection(
	fragments: readonly ChangeFragment[]
): Promise<string> {
	const conventionalTypes = await getConventionalTypes();
	const typeSections = new Map(
		conventionalTypes.map(item => [item.type, item.section])
	);
	const groups = new Map<string, ChangeFragment[]>();
	for (const fragment of fragments) {
		const section = typeSections.get(fragment.type);
		if (!section) {
			throw new Error(`No changelog section for type '${fragment.type}'.`);
		}

		const group = groups.get(section) ?? [];
		group.push(fragment);
		groups.set(section, group);
	}

	const lines: string[] = [];
	for (const type of conventionalTypes) {
		const group = groups.get(type.section);
		if (!group || group.length === 0) {
			continue;
		}

		lines.push(`### ${type.section}`, '');
		for (const fragment of group.toSorted(compareFragmentScope)) {
			lines.push(renderChangeBullet(fragment));
		}
		lines.push('');
	}

	return `${lines.join('\n').trimEnd()}\n`;
}

async function readAllChangeFragments(root: string): Promise<ChangeFragment[]> {
	const changesRoot = path.join(root, '.changes');
	let entries;
	try {
		entries = await fs.readdir(changesRoot);
	} catch (error) {
		if (isNotFoundError(error)) {
			return [];
		}

		throw error;
	}

	const files = entries
		.filter(entry => entry.endsWith('.md') && entry !== 'README.md')
		.sort((a, b) => a.localeCompare(b, 'en'));
	return Promise.all(
		files.map(file => readChangeFragment(root, path.join('.changes', file)))
	);
}

async function readChangeFragment(
	root: string,
	filePath: string
): Promise<ChangeFragment> {
	const name = path.basename(filePath);
	const match = changeFilePattern.exec(name);
	if (!match) {
		throw new Error(
			`Invalid change fragment name '${filePath}'. Expected ` +
			`.changes/<pr-number>-<slug>.md or .changes/<slug>.md.`
		);
	}

	const contents = await fs.readFile(path.join(root, filePath), 'utf8');
	const parsed = await parseConventionalHeader(contents);
	return {
		...parsed,
		filePath: normalizePath(filePath),
		prNumber: match[1] === undefined ? undefined : Number(match[1]),
		slug: match[2],
	};
}

async function getAllowedTypes(): Promise<Set<string>> {
	const { default: configConventional } =
		await import('@commitlint/config-conventional');
	const typeEnum = configConventional.rules['type-enum'];
	const types = Array.isArray(typeEnum?.[2]) ? typeEnum[2] : [];
	return new Set(types);
}

async function getConventionalTypes(): Promise<ConventionalType[]> {
	const allowedTypes = await getAllowedTypes();
	return conventionalTypes.filter(item => allowedTypes.has(item.type));
}

async function getRequiredChangeTypes(): Promise<Set<string>> {
	return new Set(
		(await getConventionalTypes())
			.filter(item => !item.hidden)
			.map(item => item.type)
	);
}

function bodyAfterHeader(message: string): string {
	const lines = message.replace(/\r\n/g, '\n').split('\n');
	const headerIndex = lines.findIndex(line => line.trim() !== '');
	if (headerIndex === -1) {
		return '';
	}

	return lines.slice(headerIndex + 1).join('\n').trim();
}

function firstNonEmptyLine(message: string): string {
	return message.split(/\r?\n/).find(line => line.trim() !== '')?.trim() ?? '';
}

function getAddedChangeFiles(root: string, baseRef: string | undefined): string[] {
	const args = [
		'diff',
		'--name-only',
		'--diff-filter=A',
		...(baseRef ? [`${baseRef}...HEAD`] : ['--cached']),
		'--',
		'.changes',
	];
	const output = execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
	});
	return output
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.endsWith('.md') && path.basename(line) !== 'README.md')
		.map(normalizePath);
}

function getFileAddingCommitSubject(
	root: string,
	filePath: string,
	firstParent: boolean
): string | undefined {
	try {
		const args = [
			'log',
			...(firstParent ? ['--first-parent'] : []),
			'--diff-filter=A',
			'--format=%s',
			'-n',
			'1',
			'--',
			filePath,
		];
		const subject = firstNonEmptyLine(execFileSync('git', args, {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}));
		return subject || undefined;
	} catch {
		return undefined;
	}
}

function headersMatch(left: ParsedChange, right: ParsedChange): boolean {
	return left.breaking === right.breaking
		&& left.type === right.type
		&& left.scope === right.scope
		&& left.subject === right.subject;
}

function inferMissingFragmentPrNumbers(
	root: string,
	fragments: ChangeFragment[]
): void {
	for (const fragment of fragments) {
		if (fragment.prNumber !== undefined) {
			continue;
		}

		const subject = getFileAddingCommitSubject(root, fragment.filePath, true)
			?? getFileAddingCommitSubject(root, fragment.filePath, false);
		const prNumber = subject ? parsePullRequestNumber(subject) : undefined;
		if (prNumber !== undefined) {
			fragment.prNumber = prNumber;
		}
	}
}

function hasVersionSection(changelog: string, version: string): boolean {
	return new RegExp(`^## \\[?${escapeRegExp(version)}\\]?\\b`, 'm')
		.test(changelog);
}

function insertReleaseSection(
	changelog: string,
	version: string,
	date: string,
	section: string
): string {
	const release = `## ${version} - ${date}\n\n${section}`;
	if (!/^# .+$/m.test(changelog)) {
		return `${defaultChangelogHeader()}\n${release}\n`;
	}

	const firstRelease = /^## /m.exec(changelog);
	if (!firstRelease) {
		return `${changelog.trimEnd()}\n\n${release}`;
	}

	const before = changelog.slice(0, firstRelease.index).trimEnd();
	const after = changelog.slice(firstRelease.index).trim();
	return `${before}\n\n${release}\n${after}\n`;
}

function extractVersionSection(changelog: string, version: string): string | undefined {
	const heading = new RegExp(
		`^## \\[?${escapeRegExp(version)}\\]?\\b.*$`,
		'm'
	).exec(changelog);
	if (!heading) {
		return undefined;
	}

	const start = heading.index;
	const next = /^## /m.exec(changelog.slice(start + heading[0].length));
	const end = next
		? start + heading[0].length + next.index
		: changelog.length;
	return changelog.slice(start, end).trimEnd();
}

function isBreakingHeader(header: string): boolean {
	return /^\w+(?:\(.+\))?!: /.test(header);
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error
		&& 'code' in error
		&& error.code === 'ENOENT';
}

function normalizePath(filePath: string): string {
	return filePath.split(path.sep).join('/');
}

function readChangelog(changelogPath: string): Promise<string> {
	return fs.readFile(changelogPath, 'utf8').catch(error => {
		if (isNotFoundError(error)) {
			return defaultChangelogHeader();
		}

		throw error;
	});
}

function renderChangeBullet(fragment: ChangeFragment): string {
	const subject = fragment.breaking
		? `BREAKING: ${fragment.subject}`
		: fragment.subject;
	const suffix = fragment.prNumber === undefined ? '' : ` (#${fragment.prNumber})`;
	if (!fragment.scope) {
		return `- ${subject}${suffix}`;
	}

	return `- **${fragment.scope}:** ${subject}${suffix}`;
}

function compareFragmentScope(
	left: ChangeFragment,
	right: ChangeFragment
): number {
	return (left.scope ?? '').localeCompare(right.scope ?? '', 'en')
		|| left.subject.localeCompare(right.subject, 'en');
}

function stripPullRequestSuffix(subject: string): string {
	return subject.replace(/\s+\(#\d+\)$/, '');
}

function validateVersion(version: string): void {
	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error(`Invalid Hucode version '${version}'.`);
	}
}

function defaultChangelogHeader(): string {
	return [
		'# Changelog',
		'',
		'All notable changes to Hucode are documented in this file.',
		'',
	].join('\n');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCliOptions(args: string[]): CliOptions {
	const options: CliOptions = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];
		if (arg === '--base-ref' && next) {
			options.baseRef = next;
			i++;
		} else if (arg === '--date' && next) {
			options.date = next;
			i++;
		} else if (arg === '--out' && next) {
			options.out = next;
			i++;
		} else if (arg === '--pr-number' && next) {
			options.prNumber = Number(next);
			i++;
		} else if (arg === '--title' && next) {
			options.title = next;
			i++;
		} else if (arg === '--version' && next) {
			options.version = next;
			i++;
		} else {
			throw new Error(`Unknown or incomplete option '${arg}'.`);
		}
	}

	return options;
}

function parsePullRequestNumber(subject: string): number | undefined {
	const suffixMatch = /\(#(\d+)\)\s*$/.exec(subject);
	if (suffixMatch) {
		return Number(suffixMatch[1]);
	}

	const mergeMatch = /^Merge pull request #(\d+)\b/.exec(subject);
	return mergeMatch ? Number(mergeMatch[1]) : undefined;
}

async function readPullRequestContext(options: CliOptions): Promise<PullRequestContext> {
	if (options.title && options.prNumber) {
		return {
			baseRef: options.baseRef,
			number: options.prNumber,
			title: options.title,
		};
	}

	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		throw new Error(
			'Pass --title and --pr-number, or run from a pull_request workflow.'
		);
	}

	const event = JSON.parse(await fs.readFile(eventPath, 'utf8'));
	const pullRequest = event.pull_request;
	if (!pullRequest?.title || !pullRequest?.number) {
		throw new Error('GITHUB_EVENT_PATH does not contain a pull_request event.');
	}

	return {
		baseRef: options.baseRef ?? pullRequest.base?.sha,
		number: pullRequest.number,
		title: pullRequest.title,
	};
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	const options = parseCliOptions(args);
	if (command === 'check-pr') {
		await checkPullRequest({
			root: repoRoot,
			...(await readPullRequestContext(options)),
		});
		return;
	}

	if (command === 'prepare-release') {
		if (!options.version) {
			throw new Error('prepare-release requires --version.');
		}

		await prepareRelease({
			date: options.date ?? new Date().toISOString().slice(0, 10),
			root: repoRoot,
			version: options.version,
		});
		return;
	}

	if (command === 'release-notes') {
		if (!options.version) {
			throw new Error('release-notes requires --version.');
		}

		const notes = await releaseNotes({
			root: repoRoot,
			version: options.version,
		});
		if (options.out) {
			await fs.writeFile(options.out, `${notes}\n`, 'utf8');
		} else {
			console.log(notes);
		}
		return;
	}

	throw new Error(
		'Usage: node build/hucode/changelog.ts ' +
		'<check-pr|prepare-release|release-notes> [options]'
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
