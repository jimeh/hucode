/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { suite, test } from 'node:test';
import {
	dispatchUpdateServiceRefresh,
	type IUpdateServiceDispatchDependencies,
	runGhCommand,
} from '../../hucode/dispatch-update-service.ts';

suite('Hucode update service dispatch', () => {
	test('returns after an immediate successful dispatch', async () => {
		const harness = createHarness();

		await dispatchUpdateServiceRefresh(release, harness.dependencies);

		assert.strictEqual(harness.attempts.length, 1);
		assert.deepStrictEqual(harness.delays, []);
		assert.deepStrictEqual(harness.warnings, []);
		assert.deepStrictEqual(harness.errors, []);
		assert.deepStrictEqual(harness.summaries, []);
	});

	test('retries failed attempts with bounded exponential backoff', async () => {
		const harness = createHarness(2);

		await dispatchUpdateServiceRefresh(release, harness.dependencies);

		assert.strictEqual(harness.attempts.length, 3);
		assert.deepStrictEqual(harness.delays, [5_000, 10_000]);
		assert.strictEqual(harness.warnings.length, 2);
		assert.match(harness.warnings[0], /attempt 1 of 4.*5s/);
		assert.match(harness.warnings[1], /attempt 2 of 4.*10s/);
		assert.deepStrictEqual(harness.errors, []);
		assert.deepStrictEqual(harness.summaries, []);
	});

	test('reports terminal failure and appends a step summary alert', async () => {
		const harness = createHarness(Number.POSITIVE_INFINITY);

		await assert.rejects(
			dispatchUpdateServiceRefresh(release, harness.dependencies),
			/failed after 4 attempts.*dispatch 4 failed/s
		);

		assert.strictEqual(harness.attempts.length, 4);
		assert.deepStrictEqual(
			harness.attempts.map(attempt => attempt.timeoutMs),
			[60_000, 60_000, 60_000, 60_000]
		);
		assert.deepStrictEqual(harness.delays, [5_000, 10_000, 20_000]);
		assert.strictEqual(harness.warnings.length, 3);
		assert.strictEqual(harness.errors.length, 1);
		assert.match(harness.errors[0], /^::error::/);
		assert.match(harness.errors[0], /failed after 4 attempts/);
		assert.strictEqual(harness.summaries.length, 1);
		assert.match(
			harness.summaries[0],
			/^### Update metadata refresh failed/m
		);
		assert.match(harness.summaries[0], /v1\.2\.3/);
		assert.match(harness.summaries[0], /0123456789abcdef/);
	});

	test('preserves the dispatch failure when the step summary write also fails', async () => {
		const harness = createHarness(
			Number.POSITIVE_INFINITY,
			new Error('summary write failed')
		);

		await assert.rejects(
			dispatchUpdateServiceRefresh(release, harness.dependencies),
			(error: Error) => {
				assert.match(
					error.message,
					/failed after 4 attempts.*dispatch 4 failed/s
				);
				assert.doesNotMatch(error.message, /summary write failed/);
				return true;
			}
		);

		assert.strictEqual(harness.attempts.length, 4);
		assert.deepStrictEqual(harness.delays, [5_000, 10_000, 20_000]);
		assert.strictEqual(harness.errors.length, 1);
		assert.match(
			harness.errors[0],
			/^::error::Update service dispatch failed after 4 attempts: dispatch 4 failed$/
		);
		assert.strictEqual(harness.summaries.length, 1);
		assert.strictEqual(harness.warnings.length, 4);
		const summaryWarnings = harness.warnings.filter(warning =>
			warning.startsWith(
				'::warning::Failed to append the update dispatch failure'
			)
		);
		assert.strictEqual(summaryWarnings.length, 1);
		assert.match(summaryWarnings[0], /summary write failed/);
	});

	test('keeps multiline diagnostics safe in annotations and the step summary', async () => {
		const harness = createHarness(
			Number.POSITIVE_INFINITY,
			undefined,
			new Error('dispatch % failed\r\nwith more\ncontext')
		);

		await assert.rejects(
			dispatchUpdateServiceRefresh(release, harness.dependencies),
			/dispatch % failed with more context/
		);

		for (const annotation of [...harness.warnings, ...harness.errors]) {
			assert.strictEqual(annotation.split(/\r?\n/).length, 1);
			assert.match(annotation, /dispatch %25 failed with more context/);
		}
		assert.deepStrictEqual(
			harness.summaries[0]
				.split('\n')
				.filter(line => line.startsWith('- Error: ')),
			['- Error: dispatch % failed with more context']
		);
	});

	test('preserves the repository dispatch payload and GH_TOKEN environment', async () => {
		const harness = createHarness();

		await dispatchUpdateServiceRefresh(release, harness.dependencies);

		assert.deepStrictEqual(harness.attempts[0].args, [
			'api',
			'--method',
			'POST',
			'/repos/jimeh/hucode-updates/dispatches',
			'-f',
			'event_type=hucode-release-published',
			'-f',
			'client_payload[tag]=v1.2.3',
			'-f',
			'client_payload[commit]=0123456789abcdef',
		]);
		assert.strictEqual(harness.attempts[0].environment, environment);
		assert.strictEqual(
			harness.attempts[0].environment.GH_TOKEN,
			'release-bot-token'
		);
	});

	test('hard-kills a dispatch process that ignores SIGTERM', async () => {
		const fixtureDirectory = await fs.mkdtemp(
			join(tmpdir(), 'hucode-update-dispatch-')
		);
		const fixturePath = join(fixtureDirectory, 'ignore-sigterm.js');
		await fs.writeFile(fixturePath, [
			'process.on("SIGTERM", () => {});',
			'setTimeout(() => process.exit(23), 2_000);',
		].join('\n'));
		const startedAt = Date.now();

		try {
			await assert.rejects(
				runGhCommand(
					[fixturePath],
					process.env,
					50,
					process.execPath
				)
			);
			assert.ok(
				Date.now() - startedAt < 1_000,
				'dispatch subprocess should reject before its safety exit'
			);
		} finally {
			await fs.rm(fixtureDirectory, { recursive: true, force: true });
		}
	});
});

const release = {
	tagName: 'v1.2.3',
	commitSha: '0123456789abcdef',
};
const environment: NodeJS.ProcessEnv = {
	GH_TOKEN: 'release-bot-token',
};

function createHarness(
	failures = 0,
	summaryFailure?: Error,
	dispatchFailure?: Error
): {
	readonly attempts: Array<{
		readonly args: readonly string[];
		readonly environment: NodeJS.ProcessEnv;
		readonly timeoutMs: number;
	}>;
	readonly delays: number[];
	readonly warnings: string[];
	readonly errors: string[];
	readonly summaries: string[];
	readonly dependencies: IUpdateServiceDispatchDependencies;
} {
	const attempts: Array<{
		readonly args: readonly string[];
		readonly environment: NodeJS.ProcessEnv;
		readonly timeoutMs: number;
	}> = [];
	const delays: number[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const summaries: string[] = [];

	return {
		attempts,
		delays,
		warnings,
		errors,
		summaries,
		dependencies: {
			environment,
			runGh: async (args, commandEnvironment, timeoutMs) => {
				attempts.push({
					args: [...args],
					environment: commandEnvironment,
					timeoutMs,
				});
				if (attempts.length <= failures) {
					throw dispatchFailure ??
					new Error(`dispatch ${attempts.length} failed`);
				}
			},
			sleep: async delay => {
				delays.push(delay);
			},
			warning: message => warnings.push(message),
			error: message => errors.push(message),
			appendSummary: async message => {
				summaries.push(message);
				if (summaryFailure) {
					throw summaryFailure;
				}
			},
		},
	};
}
