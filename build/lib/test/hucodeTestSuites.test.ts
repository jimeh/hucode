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
	NODE_RUNNER_OVERRIDES,
	NODE_RUNNER_TEST_GLOB,
	SNAPSHOT_PATH,
	UPSTREAM_SUITES,
	WORKFLOW_PATH,
	collectRuleMatchedSuites,
	formatSnapshot,
	hardCodedSuitePaths,
	hasElectronRunnerInvocation,
	hasNodeRunnerDefaultPass,
	isCoveredByNodeRunner,
	isHucodeSuite,
	parseWorkflowSteps,
	partitionSuites,
	resolveSuites,
	usesGeneratedLists,
	validate
} from '../../hucode/test-suites.ts';

const repoRoot = path.resolve(
	fileURLToPath(new URL('../../../', import.meta.url))
);

const readWorkflow = () =>
	fs.readFile(path.join(repoRoot, WORKFLOW_PATH), 'utf8');

suite('Hucode test suite inventory', () => {

	test('the repository passes every validation rule', async () => {
		const problems = await validate(repoRoot);
		assert.deepStrictEqual(problems, []);
	});

	test('the committed snapshot matches what resolves today', async () => {
		const expected = formatSnapshot(await resolveSuites(repoRoot));
		const actual = await fs.readFile(
			path.join(repoRoot, SNAPSHOT_PATH),
			'utf8'
		);

		assert.strictEqual(actual, expected);
	});

	test('resolution is not vacuously empty', async () => {
		const resolved = await resolveSuites(repoRoot);

		assert.ok(
			resolved.electron.length > 20,
			`expected many Electron suites, found ${resolved.electron.length}`
		);
		assert.ok(resolved.automatic.length > 10);
		assert.ok((await collectRuleMatchedSuites(repoRoot)).length > 20);
	});

	test('resolution is deterministic and sorted', async () => {
		// Suites that have never shared a runner can leak state into each
		// other, so ordering has to be stable and any change deliberate.
		const first = await resolveSuites(repoRoot);
		const second = await resolveSuites(repoRoot);

		assert.deepStrictEqual(first, second);
		for (const list of [first.electron, first.node, first.automatic]) {
			assert.deepStrictEqual(list, [...list].sort());
		}
	});

	test('every suite reaches exactly one runner', async () => {
		const resolved = await resolveSuites(repoRoot);
		const all = [
			...resolved.electron,
			...resolved.node,
			...resolved.automatic,
		];

		assert.strictEqual(new Set(all).size, all.length);
	});

	suite('partitioning', () => {

		test('sends an excluded-layer suite to the Electron runner', () => {
			const file = 'src/vs/hucode/test/electron-main/a.test.ts';

			assert.deepStrictEqual(partitionSuites([file]).electron, [file]);
		});

		test('leaves a node-layer suite to the default pass', () => {
			const file = 'src/vs/hucode/test/common/a.test.ts';
			const resolved = partitionSuites([file]);

			assert.deepStrictEqual(resolved.automatic, [file]);
			assert.deepStrictEqual(resolved.electron, []);
		});

		test('honours the Node runner overrides', async () => {
			const resolved = await resolveSuites(repoRoot);

			for (const file of NODE_RUNNER_OVERRIDES) {
				// The override only means anything because the layer rule
				// would otherwise send these to the Electron runner.
				assert.ok(
					!isCoveredByNodeRunner(file),
					`${file} would not need an override`
				);
				assert.ok(
					resolved.node.includes(file),
					`${file} should run under the Node runner`
				);
				assert.ok(!resolved.electron.includes(file));
			}
		});

		test('the Node list is only the overrides', async () => {
			const resolved = await resolveSuites(repoRoot);

			// Anything else named there would already run in the default
			// pass, which is duplicated work rather than coverage.
			assert.deepStrictEqual(
				[...resolved.node].sort(),
				[...NODE_RUNNER_OVERRIDES].sort()
			);
		});
	});

	suite('validation', () => {

		test('every upstream entry exists and is not rule-matched', async () => {
			const ruleMatched = new Set(await collectRuleMatchedSuites(repoRoot));

			for (const { file, reason } of UPSTREAM_SUITES) {
				await fs.access(path.join(repoRoot, file));
				assert.ok(
					!ruleMatched.has(file),
					`${file} is already found by a rule; the entry is dead`
				);
				assert.ok(reason.length > 10, `${file} needs a real reason`);
			}
		});

		test('upstream entries are all in an excluded layer', async () => {
			// An entry the default pass already enumerates would be listed
			// for no reason, and would quietly stop being checked.
			for (const { file } of UPSTREAM_SUITES) {
				assert.ok(
					!isCoveredByNodeRunner(file),
					`${file} needs no entry — the Node runner enumerates it`
				);
			}
		});
	});

	suite('workflow contract', () => {

		test('both runners are invoked unconditionally', async () => {
			const workflow = await readWorkflow();

			assert.ok(hasNodeRunnerDefaultPass(workflow));
			assert.ok(hasElectronRunnerInvocation(workflow));
		});

		test('the workflow builds its lists from the resolver', async () => {
			assert.ok(usesGeneratedLists(await readWorkflow()));
		});

		test('no suite paths are hard-coded back into the workflow', async () => {
			assert.deepStrictEqual(
				hardCodedSuitePaths(await readWorkflow()),
				[],
				'suite paths belong in build/hucode/test-suites.ts'
			);
		});

		test('one generated step does not excuse a hard-coded sibling', () => {
			const workflow = [
				'      - name: Run Hucode Node and common unit tests',
				'        run: |',
				'          readarray -t S < <(node '
					+ 'build/hucode/test-suites.ts --runner node)',
				'          npm run test-node -- "${S[@]/#/--run=}"',
				'      - name: Run Hucode Electron unit tests',
				'        run: |',
				'          ./scripts/test.sh --run=src/vs/hucode/a.test.ts',
			].join('\n');

			assert.ok(!usesGeneratedLists(workflow));
		});

		test('a conditional or commented step does not count', () => {
			const disabled = [
				'      - name: Run Node unit tests',
				'        if: false',
				'        run: npm run test-node',
				'',
				'      - name: Run Hucode Electron unit tests',
				'        run: |',
				'          # xvfb-run ./scripts/test.sh',
			].join('\n');

			assert.ok(!hasNodeRunnerDefaultPass(disabled));
			assert.ok(!hasElectronRunnerInvocation(disabled));
		});

		test('a mention outside a run body does not count', () => {
			const workflow = [
				'      - name: replaces npm run test-node someday',
				'        uses: ./.github/actions/setup-hucode-linux',
			].join('\n');

			assert.ok(!hasNodeRunnerDefaultPass(workflow));
		});

		test('the default pass needs an invocation without --run', () => {
			const workflow = [
				'      - name: Run Hucode Node and common unit tests',
				'        run: npm run test-node -- --run=src/a.test.ts',
			].join('\n');

			assert.ok(!hasNodeRunnerDefaultPass(workflow));
		});

		test('steps carry their own conditional flag', () => {
			const steps = parseWorkflowSteps([
				'      - name: One',
				'        if: false',
				'        run: echo one',
				'      - name: Two',
				'        run: echo two',
			].join('\n'));

			assert.deepStrictEqual(
				steps.map(step => step.conditional),
				[true, false]
			);
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
			assert.ok(!isHucodeSuite(
				'src/vs/hucode/browser/webShellService.ts'
			));
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
			// Trailing `//` comments are stripped first: upstream writes prose
			// there, and an apostrophe in it would otherwise be read as a glob
			// delimiter — failing on exactly the upgrade this test exists for.
			const declared = [...excludeMatch[1]
				.split('\n')
				.map(line => line.replace(/\/\/.*$/, ''))
				.join('\n')
				.matchAll(/'([^']+)'/g)]
				.map(entry => entry[1]);

			assert.deepStrictEqual(declared, NODE_RUNNER_EXCLUDE_GLOBS);
		});

		test('exclude the layers that need explicit assignment', () => {
			assert.ok(!isCoveredByNodeRunner(
				'src/vs/hucode/test/electron-main/a.test.ts'
			));
			assert.ok(!isCoveredByNodeRunner(
				'src/vs/hucode/test/browser/a.test.ts'
			));
			assert.ok(isCoveredByNodeRunner(
				'src/vs/hucode/test/common/a.test.ts'
			));
			assert.ok(isCoveredByNodeRunner(
				'src/vs/hucode/test/node/a.test.ts'
			));
		});

		test('honour the non-layer exclusions too', () => {
			assert.ok(!isCoveredByNodeRunner(
				'src/vs/platform/environment/test/node/nativeModules.test.ts'
			));
			assert.ok(!isCoveredByNodeRunner(
				'src/vs/base/parts/storage/test/node/storage.test.ts'
			));
		});

		test('ignore files outside a test directory', () => {
			assert.ok(!isCoveredByNodeRunner('src/vs/hucode/common/a.test.ts'));
		});
	});
});
