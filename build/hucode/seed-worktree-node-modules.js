/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'child_process';
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirs } from '../npm/dirs.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function parseArgs(args) {
	const options = {
		source: process.env.HUCODE_NODE_MODULES_SOURCE,
		target: process.env.CODEX_WORKTREE_PATH || repoRoot,
	};

	function readPathValue(option, index) {
		const value = args[index + 1];
		if (!value || value.startsWith('--')) {
			throw new Error(`${option} requires a path value.`);
		}

		return value;
	}

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--source':
				options.source = readPathValue(args[i], i);
				i++;
				break;
			case '--target':
				options.target = readPathValue(args[i], i);
				i++;
				break;
			default:
				throw new Error(`Unknown argument: ${args[i]}`);
		}
	}

	return options;
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
	});

	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		throw new Error(`${command} exited with code ${result.status ?? 'null'}.`);
	}

	return result.stdout;
}

function getInstalledWorktrees(targetRoot) {
	const stdout = run('git', ['worktree', 'list', '--porcelain'], targetRoot);
	const worktrees = [];

	for (const block of stdout.trim().split(/\n\n+/)) {
		const worktreeLine = block.split('\n')
			.find(line => line.startsWith('worktree '));
		if (worktreeLine) {
			worktrees.push(worktreeLine.slice('worktree '.length));
		}
	}

	return worktrees.filter(worktree =>
		existsSync(path.join(worktree, 'node_modules'))
	);
}

function resolveSource(source, targetRoot) {
	if (source) {
		return path.resolve(source);
	}

	const targetRealpath = realpathSync.native(targetRoot);
	return getInstalledWorktrees(targetRoot).find(worktree =>
		realpathSync.native(worktree) !== targetRealpath
	);
}

function copyNodeModules(source, target) {
	rmSync(target, { recursive: true, force: true });
	mkdirSync(path.dirname(target), { recursive: true });

	const args = process.platform === 'darwin'
		? ['-cR', source, target]
		: ['-a', source, target];
	const result = spawnSync('cp', args, { stdio: 'inherit' });
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`cp exited with code ${result.status ?? 'null'}.`);
	}
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const targetRoot = path.resolve(options.target);
	const sourceRoot = resolveSource(options.source, targetRoot);

	if (!sourceRoot) {
		console.log('No installed source worktree found; skipping dependency seed.');
		return;
	}

	if (!existsSync(path.join(sourceRoot, 'node_modules'))) {
		console.log(`Source worktree has no node_modules: ${sourceRoot}`);
		return;
	}

	if (realpathSync.native(sourceRoot) === realpathSync.native(targetRoot)) {
		console.log('Source and target worktrees match; skipping dependency seed.');
		return;
	}

	let copied = 0;
	for (const dir of dirs) {
		const source = path.join(sourceRoot, dir, 'node_modules');
		const target = path.join(targetRoot, dir, 'node_modules');
		if (!existsSync(source)) {
			continue;
		}

		copyNodeModules(source, target);
		copied++;
	}

	console.log(`Seeded ${copied} node_modules trees from ${sourceRoot}.`);
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exit(1);
}
