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

test('code-server exits with the prelaunch failure without starting the server', {
	skip: process.platform === 'win32'
}, async t => {
	const tempDirectory = await fs.mkdtemp(
		path.join(os.tmpdir(), 'hucode-code-server-prelaunch-')
	);
	t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));

	const binDirectory = path.join(tempDirectory, 'bin');
	const logPath = path.join(tempDirectory, 'node.log');
	const nodeStubPath = path.join(binDirectory, 'node');
	await fs.mkdir(binDirectory);
	await fs.writeFile(nodeStubPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HUCODE_STUB_NODE_LOG"
if [[ "$1" == "build/lib/preLaunch.ts" ]]; then
	exit 42
fi
printf '/usr/bin/true\\n'
`);
	await fs.chmod(nodeStubPath, 0o755);

	const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
	const result = spawnSync('bash', ['scripts/code-server.sh'], {
		cwd: repoRoot,
		encoding: 'utf8',
		env: {
			...process.env,
			HUCODE_STUB_NODE_LOG: logPath,
			PATH: `${binDirectory}${path.delimiter}${process.env['PATH']}`,
			VSCODE_SKIP_PRELAUNCH: ''
		}
	});

	assert.deepStrictEqual(
		{
			status: result.status,
			invocations: (await fs.readFile(logPath, 'utf8')).trim().split('\n')
		},
		{
			status: 42,
			invocations: ['build/lib/preLaunch.ts']
		},
		result.stderr
	);
});
