/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import minimatch from 'minimatch';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Path of the Hucode CI workflow, relative to the repository root.
 */
export const WORKFLOW_PATH = '.github/workflows/hucode-ci.yml';

/**
 * Test-file glob the Node unit runner enumerates by default, matched against
 * compiled output paths. Mirrors `TEST_GLOB` in `test/unit/node/index.js`.
 */
export const NODE_RUNNER_TEST_GLOB = '**/test/**/*.test.js';

/**
 * Suites the Node unit runner refuses to enumerate. Mirrors `excludeGlobs` in
 * `test/unit/node/index.js`; `hucodeTestAssignment.test.ts` asserts the two
 * lists stay identical so an upstream change to the runner fails a test rather
 * than silently widening what this check believes is covered.
 */
export const NODE_RUNNER_EXCLUDE_GLOBS = [
	'**/{browser,electron-browser,electron-main,electron-utility}/**/*.test.js',
	'**/vs/platform/environment/test/node/nativeModules.test.js',
	'**/vs/base/parts/storage/test/node/storage.test.js',
	'**/vs/workbench/contrib/testing/test/**',
	'**/vs/sessions/test/web.test.js',
];

/**
 * Layers whose suites no runner enumerates automatically. A suite in one of
 * these must be named explicitly in a workflow `--run` argument.
 */
export const EXPLICIT_ASSIGNMENT_LAYERS = [
	'browser',
	'electron-browser',
	'electron-main',
	'electron-utility',
];

/**
 * Suites deliberately left unassigned, each with the reason. Mirrors the
 * exclusion comments in `test/unit/node/index.js`. A stale entry — one whose
 * file is gone, or which is in fact assigned — is reported as an error so the
 * list cannot rot into a silent blanket exemption.
 */
export const KNOWN_UNASSIGNED: readonly string[] = [
	// Intentionally empty. Add a path with a comment explaining why the suite
	// runs nowhere, or wire it into `.github/workflows/hucode-ci.yml` instead.
];

/**
 * A committed suite that no CI runner executes.
 */
export interface UnassignedSuite {

	/** Repository-relative source path of the suite. */
	readonly file: string;

	/** How to give the suite a runner. */
	readonly remedy: string;
}

/**
 * Inputs to {@link checkTestAssignment}, kept separate from disk access so the
 * resolution rules can be exercised against fixtures.
 */
export interface TestAssignmentInput {

	/** Repository-relative source paths of every candidate Hucode suite. */
	readonly candidates: readonly string[];

	/** Repository-relative paths named by workflow `--run` arguments. */
	readonly workflowRunPaths: readonly string[];

	/** Repository-relative paths of files that exist on disk. */
	readonly existingFiles: ReadonlySet<string>;

	/** Repository-relative paths exempted from the check. */
	readonly knownUnassigned: readonly string[];
}

/**
 * Everything the check found wrong. Empty fields mean the inventory is clean.
 */
export interface TestAssignmentReport {

	/** Candidate suites owned by no runner. */
	readonly unassigned: readonly UnassignedSuite[];

	/** Workflow `--run` arguments naming a file that does not exist. */
	readonly missingWorkflowRefs: readonly string[];

	/** Opt-out entries that are gone or no longer needed. */
	readonly staleOptOuts: readonly string[];
}

/**
 * Returns true when the suite is a Hucode-owned or Hucode-named test file.
 *
 * Hucode-owned means anywhere under `src/vs/hucode/`; Hucode-named means a
 * `hucode*.test.ts` companion beside the upstream code it covers, per
 * `docs/hucode/agent-instructions.md`.
 */
export function isHucodeSuite(file: string): boolean {
	if (!file.endsWith('.test.ts')) {
		return false;
	}
	if (file.startsWith('src/vs/hucode/')) {
		return true;
	}
	return path.posix.basename(file).startsWith('hucode');
}

/**
 * Maps a source path to the compiled path the Node runner globs against, so
 * the runner's own globs can be applied without restating them.
 */
export function toCompiledPath(file: string): string {
	return file.replace(/^src\//, '').replace(/\.ts$/, '.js');
}

/**
 * Returns true when `npm run test-node` enumerates the suite without it being
 * named explicitly.
 */
export function isCoveredByNodeRunner(file: string): boolean {
	const compiled = toCompiledPath(file);
	if (!minimatch(compiled, NODE_RUNNER_TEST_GLOB)) {
		return false;
	}
	return !NODE_RUNNER_EXCLUDE_GLOBS.some(glob => minimatch(compiled, glob));
}

/**
 * Returns the layer segment that forces explicit assignment, if any.
 */
export function explicitAssignmentLayer(file: string): string | undefined {
	return file
		.split('/')
		.find(segment => EXPLICIT_ASSIGNMENT_LAYERS.includes(segment));
}

function remedyFor(file: string): string {
	const layer = explicitAssignmentLayer(file);
	if (layer) {
		return `add it to the Electron test list in ${WORKFLOW_PATH} `
			+ `("Run Hucode Electron unit tests"); the Node runner excludes `
			+ `the ${layer} layer`;
	}
	if (!minimatch(toCompiledPath(file), NODE_RUNNER_TEST_GLOB)) {
		return 'move it under a `test/` directory so `npm run test-node` '
			+ `enumerates it, or add it to a runner list in ${WORKFLOW_PATH}`;
	}
	return `add it to a runner list in ${WORKFLOW_PATH}`;
}

/**
 * Extracts every `--run` argument from a workflow file.
 *
 * Arguments are written one per line with a trailing backslash, so line
 * continuations are folded before matching. Both `--run <path>` and
 * `--run=<path>` are recognised.
 */
export function parseWorkflowRunArguments(workflow: string): string[] {
	const folded = workflow.replace(/\\\r?\n\s*/g, ' ');
	const pattern = /--run[=\s]+(\S+\.test\.[jt]s)/g;
	const found: string[] = [];
	for (const match of folded.matchAll(pattern)) {
		found.push(match[1]);
	}
	return found;
}

/**
 * Resolves each candidate suite to a runner and reports the ones owned by none.
 */
export function checkTestAssignment(
	input: TestAssignmentInput
): TestAssignmentReport {
	const assignedExplicitly = new Set(input.workflowRunPaths);
	const exempt = new Set(input.knownUnassigned);

	const unassigned: UnassignedSuite[] = [];
	const assignedCandidates = new Set<string>();

	for (const file of input.candidates) {
		const assigned = assignedExplicitly.has(file)
			|| isCoveredByNodeRunner(file);
		if (assigned) {
			assignedCandidates.add(file);
			continue;
		}
		if (exempt.has(file)) {
			continue;
		}
		unassigned.push({ file, remedy: remedyFor(file) });
	}

	const missingWorkflowRefs = [...assignedExplicitly]
		.filter(file => !input.existingFiles.has(file))
		.sort();

	const staleOptOuts = input.knownUnassigned
		.filter(file =>
			!input.existingFiles.has(file) || assignedCandidates.has(file))
		.sort();

	return { unassigned, missingWorkflowRefs, staleOptOuts };
}

/**
 * Returns true when the report contains no problems.
 */
export function isClean(report: TestAssignmentReport): boolean {
	return report.unassigned.length === 0
		&& report.missingWorkflowRefs.length === 0
		&& report.staleOptOuts.length === 0;
}

/**
 * Renders a report as the CI failure message.
 */
export function formatReport(report: TestAssignmentReport): string {
	const lines: string[] = [];

	if (report.unassigned.length) {
		lines.push('Committed test suites that no CI runner executes:');
		for (const { file, remedy } of report.unassigned) {
			lines.push(`  ${file}`);
			lines.push(`    -> ${remedy}`);
		}
	}

	if (report.missingWorkflowRefs.length) {
		lines.push(`Test files named by ${WORKFLOW_PATH} that do not exist:`);
		for (const file of report.missingWorkflowRefs) {
			lines.push(`  ${file}`);
		}
	}

	if (report.staleOptOuts.length) {
		lines.push('Stale KNOWN_UNASSIGNED entries in '
			+ 'build/hucode/check-test-assignment.ts:');
		for (const file of report.staleOptOuts) {
			lines.push(`  ${file}`);
		}
	}

	return lines.join('\n');
}

async function collectTestFiles(
	repoRoot: string,
	directory: string,
	found: string[]
): Promise<void> {
	const absolute = path.join(repoRoot, directory);
	const entries = await fs.readdir(absolute, { withFileTypes: true });
	for (const entry of entries) {
		const relative = path.posix.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') {
				continue;
			}
			await collectTestFiles(repoRoot, relative, found);
		} else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
			found.push(relative);
		}
	}
}

/**
 * Finds every committed Hucode suite under `src/`.
 */
export async function collectCandidateSuites(
	repoRoot: string
): Promise<string[]> {
	const found: string[] = [];
	await collectTestFiles(repoRoot, 'src', found);
	return found.filter(isHucodeSuite).sort();
}

/**
 * Runs the check against a repository checkout.
 */
export async function checkRepository(
	repoRoot: string
): Promise<TestAssignmentReport> {
	const workflow = await fs.readFile(
		path.join(repoRoot, WORKFLOW_PATH),
		'utf8'
	);
	const workflowRunPaths = parseWorkflowRunArguments(workflow);

	const allTestFiles: string[] = [];
	await collectTestFiles(repoRoot, 'src', allTestFiles);
	const existingFiles = new Set(allTestFiles);

	return checkTestAssignment({
		candidates: allTestFiles.filter(isHucodeSuite).sort(),
		workflowRunPaths,
		existingFiles,
		knownUnassigned: KNOWN_UNASSIGNED,
	});
}

async function main(): Promise<void> {
	const repoRoot = path.resolve(
		fileURLToPath(new URL('../../', import.meta.url))
	);
	const report = await checkRepository(repoRoot);

	if (isClean(report)) {
		return;
	}

	throw new Error(formatReport(report));
}

if (
	process.argv[1]
	&& path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
