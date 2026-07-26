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

	/**
	 * Whether the workflow still invokes the Node runner without `--run`. The
	 * default pass is what enumerates node and common suites automatically, so
	 * nothing may be treated as automatically covered when it is gone.
	 */
	readonly nodeRunnerDefaultPass: boolean;

	/**
	 * Whether the workflow still invokes the Electron runner, which every
	 * explicitly assigned suite in the excluded layers depends on.
	 */
	readonly electronRunnerInvoked: boolean;

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

	/**
	 * Runner invocations the workflow no longer makes unconditionally. Each
	 * one strands every suite that depends on it, so this is reported as the
	 * root cause ahead of the suites it orphans.
	 */
	readonly missingRunnerInvocations: readonly string[];
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
 * Command text of one workflow step.
 */
export interface WorkflowStep {

	/**
	 * The step's `run:` body, with commented-out lines dropped and shell line
	 * continuations folded so a `--run` and its argument end up adjacent.
	 *
	 * Comments go first because a `#` prefix disables the line under both
	 * readings of a workflow file — YAML comment outside a block scalar, shell
	 * comment inside one. Leaving them in would let a suite somebody commented
	 * out still count as assigned.
	 */
	readonly command: string;

	/** Whether an `if:` key can stop the step from executing. */
	readonly conditional: boolean;
}

/**
 * Splits a workflow into its steps, keeping only their command text.
 *
 * Reading the file as a flat blob is not good enough: a `--run` argument only
 * assigns a suite if the step around it actually invokes a runner and actually
 * executes. Full YAML parsing is not needed for that — step boundaries and the
 * `run:` body are, and they carry no dependency.
 */
export function parseWorkflowSteps(workflow: string): WorkflowStep[] {
	const steps: WorkflowStep[] = [];
	let current: string[] | undefined;
	let conditional = false;
	let inRunBody = false;

	const flush = () => {
		if (current) {
			steps.push({
				command: current
					.join('\n')
					.replace(/\\\r?\n\s*/g, ' '),
				conditional,
			});
		}
	};

	for (const raw of workflow.split('\n')) {
		if (/^\s*-\s/.test(raw)) {
			flush();
			current = [];
			conditional = false;
			inRunBody = false;
		}
		if (!current) {
			continue;
		}
		if (/^\s*#/.test(raw)) {
			continue;
		}
		if (/^\s*if:/.test(raw)) {
			conditional = true;
			inRunBody = false;
			continue;
		}
		const runKey = /^\s*(?:-\s+)?run:\s*(.*)$/.exec(raw);
		if (runKey) {
			inRunBody = true;
			if (runKey[1] && !/^[|>]/.test(runKey[1])) {
				current.push(runKey[1]);
			}
			continue;
		}
		if (/^\s*[a-zA-Z-]+:/.test(raw)) {
			inRunBody = false;
			continue;
		}
		if (inRunBody) {
			current.push(raw);
		}
	}
	flush();

	return steps;
}

function isRunnerInvocation(line: string): boolean {
	return /npm run test-node/.test(line) || /scripts\/test\.sh/.test(line);
}

/**
 * Steps that both execute unconditionally and invoke a test runner.
 */
function runnerSteps(workflow: string): WorkflowStep[] {
	return parseWorkflowSteps(workflow)
		.filter(step => !step.conditional)
		.filter(step => step.command.split('\n').some(isRunnerInvocation));
}

/**
 * Extracts every `--run` argument from a workflow file, as a source path.
 *
 * Arguments only count when the step around them invokes a runner and is not
 * gated by an `if:`, so a commented-out or disabled runner cannot leave its
 * argument list behind and keep the suites looking assigned.
 *
 * Both runners accept a compiled path as well as the `.test.ts` source path,
 * so compiled references are normalised back to their source form to stay
 * comparable with the committed inventory.
 */
export function parseWorkflowRunArguments(workflow: string): string[] {
	const pattern = /--run[=\s]+(\S+\.test\.[jt]s)/g;
	const found: string[] = [];
	for (const step of runnerSteps(workflow)) {
		for (const match of step.command.matchAll(pattern)) {
			found.push(match[1]
				.replace(/^out\//, 'src/')
				.replace(/\.test\.js$/, '.test.ts'));
		}
	}
	return found;
}

/**
 * Returns true when the workflow still invokes the Node runner without `--run`.
 *
 * That bare invocation is the only thing that enumerates node and common
 * suites automatically. If it disappears, those suites run nowhere, so the
 * check must stop treating them as covered rather than staying green.
 */
export function hasNodeRunnerDefaultPass(workflow: string): boolean {
	return runnerSteps(workflow).some(step => step.command
		.split('\n')
		.some(line => /npm run test-node/.test(line) && !/--run/.test(line)));
}

/**
 * Returns true when the workflow still invokes the Electron runner.
 *
 * Every suite in the layers the Node runner excludes depends on this step, so
 * losing it strands all of them at once. The Node runner has an equivalent
 * guard above; this is the same protection for the runner where suites have
 * actually been orphaned.
 */
export function hasElectronRunnerInvocation(workflow: string): boolean {
	return runnerSteps(workflow).some(step =>
		/scripts\/test\.sh/.test(step.command));
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
			|| (input.nodeRunnerDefaultPass && isCoveredByNodeRunner(file));
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

	const candidateSet = new Set(input.candidates);
	const staleOptOuts = input.knownUnassigned
		.filter(file =>
			!input.existingFiles.has(file)
			|| !candidateSet.has(file)
			|| assignedCandidates.has(file))
		.sort();

	const missingRunnerInvocations: string[] = [];
	if (!input.nodeRunnerDefaultPass) {
		missingRunnerInvocations.push(
			'`npm run test-node` without `--run`, which enumerates node and '
			+ 'common suites'
		);
	}
	if (!input.electronRunnerInvoked) {
		missingRunnerInvocations.push(
			'`scripts/test.sh`, which runs every explicitly assigned suite in '
			+ 'the browser and electron layers'
		);
	}

	return {
		unassigned,
		missingWorkflowRefs,
		staleOptOuts,
		missingRunnerInvocations,
	};
}

/**
 * Returns true when the report contains no problems.
 */
export function isClean(report: TestAssignmentReport): boolean {
	return report.unassigned.length === 0
		&& report.missingWorkflowRefs.length === 0
		&& report.staleOptOuts.length === 0
		&& report.missingRunnerInvocations.length === 0;
}

/**
 * Renders a report as the CI failure message.
 */
export function formatReport(report: TestAssignmentReport): string {
	const lines: string[] = [];

	if (report.missingRunnerInvocations.length) {
		lines.push(
			`${WORKFLOW_PATH} no longer invokes these unconditionally:`
		);
		for (const invocation of report.missingRunnerInvocations) {
			lines.push(`  ${invocation}`);
		}
		lines.push('  A step gated by `if:` does not count.');
	}

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

	return checkTestAssignment({
		candidates: await collectCandidateSuites(repoRoot),
		workflowRunPaths,
		nodeRunnerDefaultPass: hasNodeRunnerDefaultPass(workflow),
		electronRunnerInvoked: hasElectronRunnerInvocation(workflow),
		existingFiles: new Set(allTestFiles),
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
