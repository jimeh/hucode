/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
	NODE_RUNNER_EXCLUDE_GLOBS,
	NODE_RUNNER_TEST_GLOB,
	WORKFLOW_PATH,
	checkRepository,
	checkTestAssignment,
	collectCandidateSuites,
	formatReport,
	hasNodeRunnerDefaultPass,
	isClean,
	isCoveredByNodeRunner,
	isHucodeSuite,
	parseWorkflowRunArguments,
	type TestAssignmentInput
} from '../../hucode/check-test-assignment.ts';

const repoRoot = path.resolve(
	fileURLToPath(new URL('../../../', import.meta.url))
);

const ELECTRON_SUITE =
	'src/vs/hucode/test/electron-main/hucodeInvented.test.ts';
const NODE_SUITE = 'src/vs/hucode/test/common/hucodeInvented.test.ts';

function input(overrides: Partial<TestAssignmentInput>): TestAssignmentInput {
	const candidates = overrides.candidates ?? [];
	const workflowRunPaths = overrides.workflowRunPaths ?? [];
	return {
		candidates,
		workflowRunPaths,
		nodeRunnerDefaultPass: overrides.nodeRunnerDefaultPass ?? true,
		existingFiles: overrides.existingFiles
			?? new Set([...candidates, ...workflowRunPaths]),
		knownUnassigned: overrides.knownUnassigned ?? [],
	};
}

suite('Hucode test assignment check', () => {

	test('every committed Hucode suite has a runner', async () => {
		const report = await checkRepository(repoRoot);
		assert.ok(isClean(report), formatReport(report));
	});

	test('the repository inventory is not vacuously empty', async () => {
		const candidates = await collectCandidateSuites(repoRoot);
		assert.ok(
			candidates.length > 20,
			`expected to discover Hucode suites, found ${candidates.length}`
		);
		assert.ok(
			candidates.some(file => !isCoveredByNodeRunner(file)),
			'expected some suites to require explicit assignment'
		);
	});

	test('reports a suite that no runner enumerates', () => {
		const report = checkTestAssignment(
			input({ candidates: [ELECTRON_SUITE] })
		);

		assert.deepStrictEqual(
			report.unassigned.map(entry => entry.file),
			[ELECTRON_SUITE]
		);
		assert.match(report.unassigned[0].remedy, /Electron test list/);
		assert.match(report.unassigned[0].remedy, /electron-main layer/);
		assert.match(formatReport(report), /no CI runner executes/);
	});

	test('accepts an Electron-layer suite named by the workflow', () => {
		const report = checkTestAssignment(input({
			candidates: [ELECTRON_SUITE],
			workflowRunPaths: [ELECTRON_SUITE],
		}));

		assert.ok(isClean(report), formatReport(report));
	});

	test('accepts a suite the Node runner enumerates automatically', () => {
		const report = checkTestAssignment(input({ candidates: [NODE_SUITE] }));

		assert.ok(isClean(report), formatReport(report));
	});

	test('reports a suite outside a test directory', () => {
		const stray = 'src/vs/hucode/browser/hucodeStray.test.ts';
		const report = checkTestAssignment(input({ candidates: [stray] }));

		assert.deepStrictEqual(
			report.unassigned.map(entry => entry.file),
			[stray]
		);
		assert.match(report.unassigned[0].remedy, /Electron test list/);
	});

	test('reports a non-layer suite outside a test directory', () => {
		const stray = 'src/vs/hucode/common/hucodeStray.test.ts';
		const report = checkTestAssignment(input({ candidates: [stray] }));

		assert.match(report.unassigned[0].remedy, /move it under a `test\/`/);
	});

	test('reports a workflow reference to a missing file', () => {
		const report = checkTestAssignment(input({
			candidates: [],
			workflowRunPaths: [ELECTRON_SUITE],
			existingFiles: new Set<string>(),
		}));

		assert.deepStrictEqual(report.missingWorkflowRefs, [ELECTRON_SUITE]);
		assert.match(formatReport(report), /do not exist/);
	});

	test('an opt-out entry suppresses an unassigned suite', () => {
		const report = checkTestAssignment(input({
			candidates: [ELECTRON_SUITE],
			knownUnassigned: [ELECTRON_SUITE],
		}));

		assert.ok(isClean(report), formatReport(report));
	});

	test('reports an opt-out entry whose file is gone', () => {
		const report = checkTestAssignment(input({
			candidates: [],
			knownUnassigned: [ELECTRON_SUITE],
			existingFiles: new Set<string>(),
		}));

		assert.deepStrictEqual(report.staleOptOuts, [ELECTRON_SUITE]);
		assert.match(formatReport(report), /Stale KNOWN_UNASSIGNED/);
	});

	test('reports an opt-out entry that is in fact assigned', () => {
		const report = checkTestAssignment(input({
			candidates: [ELECTRON_SUITE],
			workflowRunPaths: [ELECTRON_SUITE],
			knownUnassigned: [ELECTRON_SUITE],
		}));

		assert.deepStrictEqual(report.staleOptOuts, [ELECTRON_SUITE]);
	});

	test('explicit assignment overrides the layer rule', async () => {
		// Two Electron-layer suites are deliberately run by `npm run
		// test-node` through explicit `--run` arguments, which bypass the Node
		// runner's layer exclusions. A layer-derived rule would misreport them.
		const crossRunner = [
			'src/vs/platform/update/test/electron-main/'
				+ 'hucodeLinuxUpdate.test.ts',
			'src/vs/workbench/services/dialogs/test/electron-browser/'
				+ 'hucodeOmniFileDialog.test.ts',
		];
		const workflow = await fs.readFile(
			path.join(repoRoot, WORKFLOW_PATH),
			'utf8'
		);
		const workflowRunPaths = parseWorkflowRunArguments(workflow);

		for (const file of crossRunner) {
			assert.ok(
				!isCoveredByNodeRunner(file),
				`${file} should need explicit assignment`
			);
			assert.ok(
				workflowRunPaths.includes(file),
				`${file} should be named by ${WORKFLOW_PATH}`
			);
		}
	});

	test('stops trusting automatic coverage without the Node default pass', () => {
		const report = checkTestAssignment(input({
			candidates: [NODE_SUITE],
			nodeRunnerDefaultPass: false,
		}));

		assert.ok(report.nodeRunnerNotInvoked);
		assert.deepStrictEqual(
			report.unassigned.map(entry => entry.file),
			[NODE_SUITE]
		);
		assert.match(formatReport(report), /no longer runs `npm run test-node`/);
	});

	suite('workflow parsing', () => {

		test('reads arguments across line continuations', () => {
			const workflow = [
				'          run: |',
				'            ./scripts/test.sh \\',
				'              --run \\',
				'              src/vs/hucode/test/browser/a.test.ts \\',
				'              --run \\',
				'              src/vs/hucode/test/browser/b.test.ts',
			].join('\n');

			assert.deepStrictEqual(parseWorkflowRunArguments(workflow), [
				'src/vs/hucode/test/browser/a.test.ts',
				'src/vs/hucode/test/browser/b.test.ts',
			]);
		});

		test('reads inline and equals-delimited arguments', () => {
			const workflow = '--run src/a.test.ts --run=src/b.test.ts';

			assert.deepStrictEqual(parseWorkflowRunArguments(workflow), [
				'src/a.test.ts',
				'src/b.test.ts',
			]);
		});

		test('normalises compiled paths back to source paths', () => {
			// Both runners accept a `.test.js` argument, so the inventory has
			// to see it as the source suite rather than a missing reference.
			assert.deepStrictEqual(
				parseWorkflowRunArguments('--run src/a.test.js'),
				['src/a.test.ts']
			);
		});

		test('ignores commented-out arguments', () => {
			const workflow = [
				'          run: |',
				'            ./scripts/test.sh \\',
				'              --run \\',
				'              src/vs/hucode/test/browser/a.test.ts',
				'              # disabled while flaky:',
				'              # --run src/vs/hucode/test/browser/b.test.ts',
				'              # --run \\',
				'              src/vs/hucode/test/browser/c.test.ts',
			].join('\n');

			assert.deepStrictEqual(parseWorkflowRunArguments(workflow), [
				'src/vs/hucode/test/browser/a.test.ts',
			]);
		});

		test('finds the real workflow arguments', async () => {
			const workflow = await fs.readFile(
				path.join(repoRoot, WORKFLOW_PATH),
				'utf8'
			);
			const found = parseWorkflowRunArguments(workflow);

			// Guards against a workflow reformat silently blinding the parser,
			// which would make every suite look assigned to nothing.
			assert.ok(
				found.length > 40,
				`expected many --run arguments, found ${found.length}`
			);
			assert.ok(found.includes(
				'src/vs/hucode/test/browser/webShellService.test.ts'
			));
		});
	});

	suite('Node runner default pass', () => {

		test('is detected in the real workflow', async () => {
			const workflow = await fs.readFile(
				path.join(repoRoot, WORKFLOW_PATH),
				'utf8'
			);

			assert.ok(hasNodeRunnerDefaultPass(workflow));
		});

		test('is not satisfied by an explicit --run invocation alone', () => {
			const workflow = [
				'      - name: Run Hucode Node and common unit tests',
				'        run: |',
				'          npm run test-node -- \\',
				'            --run \\',
				'            src/vs/hucode/test/common/a.test.ts',
			].join('\n');

			assert.ok(!hasNodeRunnerDefaultPass(workflow));
		});

		test('is not satisfied by a commented-out invocation', () => {
			const workflow = '        # run: npm run test-node';

			assert.ok(!hasNodeRunnerDefaultPass(workflow));
		});
	});

	suite('suite classification', () => {

		test('recognises Hucode-owned and Hucode-named suites', () => {
			assert.ok(isHucodeSuite('src/vs/hucode/test/common/a.test.ts'));
			assert.ok(isHucodeSuite(
				'src/vs/platform/list/test/browser/hucodeListService.test.ts'
			));
		});

		test('ignores upstream suites and non-test files', () => {
			assert.ok(!isHucodeSuite(
				'src/vs/platform/windows/test/electron-main/'
					+ 'windowsFinder.test.ts'
			));
			assert.ok(!isHucodeSuite('src/vs/hucode/browser/webShellService.ts'));
		});
	});

	suite('Node runner rules', () => {

		test('mirror the runner definitions', async () => {
			const source = await fs.readFile(
				path.join(repoRoot, 'test/unit/node/index.js'),
				'utf8'
			);

			const globMatch = /const TEST_GLOB = '([^']+)'/.exec(source);
			assert.ok(globMatch, 'TEST_GLOB not found in the Node runner');
			assert.strictEqual(globMatch[1], NODE_RUNNER_TEST_GLOB);

			const excludeMatch =
				/const excludeGlobs = \[([\s\S]*?)\n\];/.exec(source);
			assert.ok(excludeMatch, 'excludeGlobs not found in the Node runner');
			const declared = [...excludeMatch[1].matchAll(/'([^']+)'/g)]
				.map(entry => entry[1]);

			assert.deepStrictEqual(declared, NODE_RUNNER_EXCLUDE_GLOBS);
		});

		test('exclude the layers that need explicit assignment', () => {
			assert.ok(!isCoveredByNodeRunner(ELECTRON_SUITE));
			assert.ok(!isCoveredByNodeRunner(
				'src/vs/hucode/test/browser/a.test.ts'
			));
			assert.ok(isCoveredByNodeRunner(NODE_SUITE));
			assert.ok(isCoveredByNodeRunner(
				'src/vs/hucode/test/node/a.test.ts'
			));
		});
	});
});
