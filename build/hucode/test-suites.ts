/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import minimatch from 'minimatch';
import path from 'path';
import { fileURLToPath } from 'url';
import {
	UPSTREAM_PROVENANCE,
	upstreamSuitesFromProvenance,
	type ProvenanceTestSuite
} from './upstream-provenance.ts';

/**
 * Path of the Hucode CI workflow, relative to the repository root.
 */
export const WORKFLOW_PATH = '.github/workflows/hucode-ci.yml';

/**
 * Path of the generated inventory, relative to the repository root.
 *
 * The resolved lists are committed so a pull request still shows exactly what
 * CI will run. Without it, adding a test file would change CI's behaviour with
 * nothing in the diff to see.
 */
export const SNAPSHOT_PATH = 'build/hucode/test-suites.snapshot.json';

/**
 * Test-file glob the Node unit runner enumerates by default, matched against
 * compiled output paths. Mirrors `TEST_GLOB` in `test/unit/node/index.js`.
 */
export const NODE_RUNNER_TEST_GLOB = '**/test/**/*.test.js';

/**
 * Suites the Node unit runner refuses to enumerate. Mirrors `excludeGlobs` in
 * `test/unit/node/index.js`; `hucodeTestSuites.test.ts` asserts the two lists
 * stay identical so an upstream change fails a test rather than silently
 * changing which runner owns a suite.
 */
export const NODE_RUNNER_EXCLUDE_GLOBS = [
	'**/{browser,electron-browser,electron-main,electron-utility}/**/*.test.js',
	'**/vs/platform/environment/test/node/nativeModules.test.js',
	'**/vs/base/parts/storage/test/node/storage.test.js',
	'**/vs/workbench/contrib/testing/test/**',
	'**/vs/sessions/test/web.test.js',
];

/**
 * An upstream-named suite Hucode runs deliberately.
 */
export type UpstreamSuite = ProvenanceTestSuite;

/**
 * Suites Hucode runs that neither live under `src/vs/hucode/` nor carry a
 * `hucode*` name, so no rule can find them.
 *
 * Membership is derived from the upstream provenance inventory so a Hucode
 * surface and the upstream-named coverage it requires cannot drift apart.
 */
export const UPSTREAM_SUITES: readonly UpstreamSuite[] =
	upstreamSuitesFromProvenance(UPSTREAM_PROVENANCE);

/**
 * Suites in a layer the Node runner excludes that Hucode nonetheless runs
 * under `npm run test-node`.
 *
 * An explicit `--run` argument bypasses the runner's layer exclusions, so this
 * is legal and long-standing. It is recorded here rather than inferred,
 * because nothing about the paths says the layer rule does not apply to them.
 */
export const NODE_RUNNER_OVERRIDES: readonly string[] = [
	'src/vs/platform/update/test/electron-main/hucodeLinuxUpdate.test.ts',
	'src/vs/workbench/services/dialogs/test/electron-browser/'
		+ 'hucodeOmniFileDialog.test.ts',
];

/**
 * Layers no runner enumerates automatically.
 */
export const EXPLICIT_ASSIGNMENT_LAYERS = [
	'browser',
	'electron-browser',
	'electron-main',
	'electron-utility',
];

/**
 * The resolved inventory, partitioned by how each suite reaches a runner.
 */
export interface ResolvedSuites {

	/** Passed to `scripts/test.sh` as explicit `--run` arguments. */
	readonly electron: readonly string[];

	/** Passed to `npm run test-node` as explicit `--run` arguments. */
	readonly node: readonly string[];

	/** Enumerated by the Node runner's default pass, named nowhere. */
	readonly automatic: readonly string[];
}

/**
 * Returns true when the suite is Hucode-owned or Hucode-named.
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
 * Maps a source path to the compiled path the Node runner globs against.
 */
export function toCompiledPath(file: string): string {
	return file.replace(/^src\//, '').replace(/\.ts$/, '.js');
}

/**
 * Returns true when the Node runner's default pass enumerates the suite
 * without it being named explicitly.
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

async function collectTestFiles(
	repoRoot: string,
	directory: string,
	found: string[]
): Promise<void> {
	const entries = await fs.readdir(
		path.join(repoRoot, directory),
		{ withFileTypes: true }
	);
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
 * Finds every committed suite under `src/` that a rule recognises as Hucode's.
 */
export async function collectRuleMatchedSuites(
	repoRoot: string
): Promise<string[]> {
	const found: string[] = [];
	await collectTestFiles(repoRoot, 'src', found);
	return found.filter(isHucodeSuite).sort();
}

/**
 * Partitions a set of suites across the runners.
 */
export function partitionSuites(suites: readonly string[]): ResolvedSuites {
	const overrides = new Set(NODE_RUNNER_OVERRIDES);
	const electron: string[] = [];
	const node: string[] = [];
	const automatic: string[] = [];

	for (const file of [...suites].sort()) {
		if (overrides.has(file)) {
			node.push(file);
		} else if (isCoveredByNodeRunner(file)) {
			automatic.push(file);
		} else {
			electron.push(file);
		}
	}

	return { electron, node, automatic };
}

/**
 * Resolves the full inventory for a repository checkout.
 */
export async function resolveSuites(
	repoRoot: string
): Promise<ResolvedSuites> {
	const ruleMatched = await collectRuleMatchedSuites(repoRoot);
	const upstream = UPSTREAM_SUITES.map(entry => entry.file);
	return partitionSuites([...new Set([...ruleMatched, ...upstream])]);
}

/**
 * Command text of one workflow step.
 */
export interface WorkflowStep {

	/**
	 * The step's `run:` body, with commented-out lines dropped and shell line
	 * continuations folded.
	 *
	 * Comments go first because a `#` prefix disables the line under both
	 * readings of a workflow file — YAML comment outside a block scalar, shell
	 * comment inside one.
	 */
	readonly command: string;

	/** Whether an `if:` key can stop the step from executing. */
	readonly conditional: boolean;
}

/**
 * Splits a workflow into its steps, keeping only their command text.
 *
 * Reading the file as a flat blob is not good enough: a runner only counts as
 * invoked if the step around it actually executes. Full YAML parsing is not
 * needed for that — step boundaries and the `run:` body are, and they carry no
 * dependency.
 */
export function parseWorkflowSteps(workflow: string): WorkflowStep[] {
	const steps: WorkflowStep[] = [];
	let current: string[] | undefined;
	let conditional = false;
	let inRunBody = false;

	const flush = () => {
		if (current) {
			steps.push({
				command: current.join('\n').replace(/\\\r?\n\s*/g, ' '),
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
		if (!current || /^\s*#/.test(raw)) {
			continue;
		}
		if (/^\s*if:/.test(raw)) {
			conditional = true;
			inRunBody = false;
			continue;
		}
		const runKey = /^\s*(?:-\s+)?run:\s*(?<command>.*)$/.exec(raw);
		if (runKey) {
			inRunBody = true;
			const inline = runKey.groups?.command;
			if (inline && !/^[|>]/.test(inline)) {
				current.push(inline);
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

function unconditionalCommands(workflow: string): string[] {
	return parseWorkflowSteps(workflow)
		.filter(step => !step.conditional)
		.map(step => step.command);
}

/**
 * Returns true when the workflow still invokes the Node runner without `--run`.
 *
 * That bare invocation is the only thing that enumerates node and common
 * suites. If it disappears, every suite in {@link ResolvedSuites.automatic}
 * runs nowhere, and generating lists would not notice.
 */
export function hasNodeRunnerDefaultPass(workflow: string): boolean {
	return unconditionalCommands(workflow).some(command => command
		.split('\n')
		.some(line => /npm run test-node/.test(line) && !/--run/.test(line)));
}

/**
 * Returns true when the workflow still invokes the Electron runner.
 */
export function hasElectronRunnerInvocation(workflow: string): boolean {
	return unconditionalCommands(workflow)
		.some(command => /scripts\/test\.sh/.test(command));
}

/**
 * Returns true when every runner step builds its list from here.
 *
 * Checking that the resolver is mentioned somewhere is not enough: with two
 * runner steps, one can go back to a hard-coded list while the other keeps the
 * call and the workflow still looks generated. Each step is judged alone.
 */
export function usesGeneratedLists(workflow: string): boolean {
	const steps = unconditionalCommands(workflow)
		.filter(command => /--run/.test(command));
	return steps.length > 0
		&& steps.every(command =>
			/build\/hucode\/test-suites\.ts/.test(command));
}

/**
 * Runner steps whose `--runner` selector does not match the runner they then
 * invoke, or which pass `--run` arguments without asking the resolver for them.
 *
 * `usesGeneratedLists` only proves the resolver is mentioned. It does not stop
 * the Electron step asking for `--runner node`, which passes every check while
 * handing `scripts/test.sh` the two Node overrides and running none of the
 * Electron suites.
 */
export function runnerSelectorProblems(workflow: string): string[] {
	const problems: string[] = [];

	for (const command of unconditionalCommands(workflow)) {
		const selector =
			/test-suites\.ts --runner (?<runner>[a-z]+)/.exec(command)
				?.groups?.runner;
		const invokesElectron = /scripts\/test\.sh/.test(command);
		const invokesNode = /npm run test-node/.test(command);
		const passesRunArguments = /--run=/.test(command);

		if (!selector) {
			if (passesRunArguments) {
				problems.push(
					'A step passes --run arguments without resolving them from '
					+ 'build/hucode/test-suites.ts.'
				);
			}
			continue;
		}

		if (selector === 'electron' && !invokesElectron) {
			problems.push(
				'A step resolves --runner electron but does not invoke '
				+ 'scripts/test.sh with the result.'
			);
		}
		if (selector === 'node' && !invokesNode) {
			problems.push(
				'A step resolves --runner node but does not invoke '
				+ '`npm run test-node` with the result.'
			);
		}
		if (invokesElectron && selector !== 'electron') {
			problems.push(
				`The scripts/test.sh step resolves --runner ${selector}, so the `
				+ 'Electron suites would run nowhere.'
			);
		}
	}

	return problems;
}

/**
 * Suite paths written directly into the workflow.
 *
 * Any hit means assignment has partly gone back to being hand-maintained,
 * which is the failure this item exists to remove.
 */
export function hardCodedSuitePaths(workflow: string): string[] {
	return [...workflow.matchAll(/(?<suite>\S+\.test\.ts)/g)]
		.map(match => match.groups?.suite ?? '');
}

/**
 * Returns true when the workflow reads the resolver through a process
 * substitution, which discards its exit status.
 *
 * `readarray -t SUITES < <(node ...)` succeeds even when the resolver dies:
 * `set -e` never sees the failure, the array ends up empty, and the runner is
 * then invoked with no `--run` arguments — which both runners read as "run
 * everything". Command substitution propagates the status instead.
 */
export function readsResolverUnchecked(workflow: string): boolean {
	return /<\s*<\(\s*node\s+build\/hucode\/test-suites\.ts/.test(workflow);
}

/**
 * Returns the list for one runner, refusing to hand back an empty one.
 *
 * An empty list is never a safe thing to print: the caller would invoke a
 * runner with no `--run` arguments and silently run the entire suite instead
 * of the intended subset.
 */
export function selectRunnerSuites(
	resolved: ResolvedSuites,
	runner: 'electron' | 'node'
): readonly string[] {
	const suites = resolved[runner];
	if (!suites.length) {
		throw new Error(
			`No suites resolved for the ${runner} runner. If that is `
			+ `intended, remove the step from ${WORKFLOW_PATH} rather than `
			+ 'letting it run with an empty list.'
		);
	}
	return suites;
}

/**
 * Renders the inventory for committing.
 */
export function formatSnapshot(resolved: ResolvedSuites): string {
	return `${JSON.stringify(resolved, undefined, '\t')}\n`;
}

/**
 * Validates the inventory and the workflow that consumes it.
 *
 * Generating the lists removes the hand-maintenance failure mode but adds
 * three of its own: an explicit entry that no longer exists, an explicit entry
 * a rule already covers, and a workflow that quietly stopped using the
 * generated lists at all. Each is reported here.
 */
export async function validate(repoRoot: string): Promise<string[]> {
	const problems: string[] = [];

	const allTestFiles: string[] = [];
	await collectTestFiles(repoRoot, 'src', allTestFiles);
	const existing = new Set(allTestFiles);
	const ruleMatched = new Set(await collectRuleMatchedSuites(repoRoot));

	for (const { file } of UPSTREAM_SUITES) {
		if (!existing.has(file)) {
			problems.push(`UPSTREAM_SUITES names a missing file: ${file}`);
		} else if (ruleMatched.has(file)) {
			problems.push(
				`UPSTREAM_SUITES entry is already matched by a rule, so the `
				+ `entry is dead weight: ${file}`
			);
		}
	}

	for (const file of NODE_RUNNER_OVERRIDES) {
		if (!existing.has(file)) {
			problems.push(`NODE_RUNNER_OVERRIDES names a missing file: ${file}`);
		} else if (!explicitAssignmentLayer(file)) {
			problems.push(
				`NODE_RUNNER_OVERRIDES entry needs no override — the Node `
				+ `runner already enumerates it: ${file}`
			);
		}
	}

	const resolved = await resolveSuites(repoRoot);
	if (!resolved.electron.length) {
		problems.push(
			'No suites resolved for the Electron runner, which cannot be '
			+ 'right — the resolver is probably matching nothing.'
		);
	}

	const snapshotPath = path.join(repoRoot, SNAPSHOT_PATH);
	const expected = formatSnapshot(resolved);
	let actual: string | undefined;
	try {
		actual = await fs.readFile(snapshotPath, 'utf8');
	} catch {
		problems.push(`${SNAPSHOT_PATH} is missing.`);
	}
	if (actual !== undefined && actual !== expected) {
		problems.push(
			`${SNAPSHOT_PATH} is stale. Regenerate it with `
			+ '`npm run hucode:test-suites -- --write-snapshot` and commit the '
			+ 'result, so the change to what CI runs is visible in review.'
		);
	}

	const workflow = await fs.readFile(
		path.join(repoRoot, WORKFLOW_PATH),
		'utf8'
	);
	if (!hasNodeRunnerDefaultPass(workflow)) {
		problems.push(
			`${WORKFLOW_PATH} no longer runs \`npm run test-node\` without `
			+ '`--run` in an unconditional step. That pass is what enumerates '
			+ 'node and common suites.'
		);
	}
	if (!hasElectronRunnerInvocation(workflow)) {
		problems.push(
			`${WORKFLOW_PATH} no longer runs \`scripts/test.sh\` in an `
			+ 'unconditional step, so every suite in the browser and electron '
			+ 'layers runs nowhere.'
		);
	}
	if (!usesGeneratedLists(workflow)) {
		problems.push(
			`${WORKFLOW_PATH} has a runner step that does not build its list `
			+ 'from build/hucode/test-suites.ts, so assignment has gone back '
			+ 'to being hand-maintained.'
		);
	}
	for (const suite of hardCodedSuitePaths(workflow)) {
		problems.push(
			`${WORKFLOW_PATH} names a suite directly: ${suite}. Suite paths `
			+ 'belong in build/hucode/test-suites.ts.'
		);
	}
	problems.push(...runnerSelectorProblems(workflow));
	if (readsResolverUnchecked(workflow)) {
		problems.push(
			`${WORKFLOW_PATH} reads the resolver through a process `
			+ 'substitution, which throws away its exit status and would run '
			+ 'the runner with an empty list. Assign the output to a variable '
			+ 'with `$(...)` so a failure fails the step.'
		);
	}

	return problems;
}

function repositoryRoot(): string {
	return path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const repoRoot = repositoryRoot();

	if (args.includes('--write-snapshot')) {
		const resolved = await resolveSuites(repoRoot);
		await fs.writeFile(
			path.join(repoRoot, SNAPSHOT_PATH),
			formatSnapshot(resolved)
		);
		return;
	}

	if (args.includes('--check')) {
		const problems = await validate(repoRoot);
		if (problems.length) {
			throw new Error(problems.join('\n'));
		}
		return;
	}

	const index = args.indexOf('--runner');
	const runner = index === -1 ? undefined : args[index + 1];
	if (runner !== 'electron' && runner !== 'node') {
		throw new Error(
			'Usage: test-suites.ts --runner <electron|node> | --check '
			+ '| --write-snapshot'
		);
	}

	const resolved = await resolveSuites(repoRoot);
	const suites = selectRunnerSuites(resolved, runner);
	process.stdout.write(`${suites.join('\n')}\n`);
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
