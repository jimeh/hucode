/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';

test('hucode web launcher defaults to server user data and preserves overrides', {
	skip: process.platform === 'win32'
}, async t => {
	const tempDirectory = await fs.mkdtemp(
		path.join(os.tmpdir(), 'hucode-web-launcher-')
	);
	t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));

	const binDirectory = path.join(tempDirectory, 'bin');
	const logPath = path.join(tempDirectory, 'node.log');
	const nodeStubPath = path.join(binDirectory, 'node');
	await fs.mkdir(binDirectory);
	await fs.writeFile(nodeStubPath, `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$HUCODE_STUB_NODE_LOG"
`);
	await fs.chmod(nodeStubPath, 0o755);

	const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
	const launch = async (args: string[]): Promise<string[]> => {
		const result = spawnSync('bash', ['scripts/hucode-web.sh', ...args], {
			cwd: repoRoot,
			encoding: 'utf8',
			env: {
				...process.env,
				HUCODE_STUB_NODE_LOG: logPath,
				PATH: `${binDirectory}${path.delimiter}${process.env['PATH']}`
			}
		});
		assert.strictEqual(result.status, 0, result.stderr);
		return (await fs.readFile(logPath, 'utf8')).trim().split('\n');
	};

	assert.deepStrictEqual(
		{
			defaultArguments: await launch(['--port=8123']),
			browserOverrideArguments: await launch([
				'--hucode-web-user-data-storage=browser',
				'--port=8123'
			]),
			standaloneBrowserOverrideArguments: await launch([
				'--hucode-web-user-data-storage',
				'browser',
				'--port=8123'
			])
		},
		{
			defaultArguments: [
				'build/hucode/run-with-mixin.js',
				'--quality',
				'stable',
				'--',
				'./scripts/code-server.sh',
				'--without-connection-token',
				'--hucode-web-omni-root',
				'--hucode-web-user-data-storage=server',
				'--port=8123'
			],
			browserOverrideArguments: [
				'build/hucode/run-with-mixin.js',
				'--quality',
				'stable',
				'--',
				'./scripts/code-server.sh',
				'--without-connection-token',
				'--hucode-web-omni-root',
				'--hucode-web-user-data-storage=browser',
				'--port=8123'
			],
			standaloneBrowserOverrideArguments: [
				'build/hucode/run-with-mixin.js',
				'--quality',
				'stable',
				'--',
				'./scripts/code-server.sh',
				'--without-connection-token',
				'--hucode-web-omni-root',
				'--hucode-web-user-data-storage',
				'browser',
				'--port=8123'
			]
		}
	);
});
