/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getGitCommitDate } from '../lib/date.ts';
import { getVersion } from '../lib/getVersion.ts';
import { spawnTsgo } from '../lib/tsgo.ts';

type BundleTarget = 'desktop' | 'server' | 'server-web';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const bundleTargets: Record<BundleTarget, string> = {
	desktop: 'out-vscode-min',
	server: 'out-vscode-reh-min',
	'server-web': 'out-vscode-reh-web-min'
};

async function run(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv = {}
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repoRoot,
			env: { ...process.env, ...env },
			shell: process.platform === 'win32',
			stdio: 'inherit'
		});

		child.on('error', reject);
		child.on('close', code => {
			if (code === 0) {
				resolve();
				return;
			}

			const renderedCommand = `${command} ${args.join(' ')}`;
			reject(
				new Error(
					`${renderedCommand} exited with code ${code ?? 'unknown'}`
				)
			);
		});
	});
}

async function runGulpTask(taskName: string): Promise<void> {
	await run('npm', ['run', 'gulp', taskName]);
}

async function writeBuildDate(): Promise<void> {
	const outBuildPath = path.join(repoRoot, 'out-build');
	await fs.promises.mkdir(outBuildPath, { recursive: true });
	await fs.promises.writeFile(
		path.join(outBuildPath, 'date'),
		getGitCommitDate(),
		'utf8'
	);
}

async function check(): Promise<void> {
	await writeBuildDate();
	await spawnTsgo(
		path.join(repoRoot, 'src', 'tsconfig.json'),
		{ taskName: 'tsgo-typecheck', noEmit: true }
	);
	await run(process.execPath, [
		path.join('build', 'next', 'index.ts'),
		'transpile',
		'--out',
		'out-build'
	]);
}

async function prepareBundle(): Promise<void> {
	await runGulpTask('copy-codicons');
	await runGulpTask('compile-non-native-extensions-build');
	await runGulpTask('compile-extension-media-build');
	await writeBuildDate();
}

async function bundle(target: BundleTarget): Promise<void> {
	const commit = getVersion(repoRoot);
	const sourceMapBaseUrl =
		`https://main.vscode-cdn.net/sourcemaps/${commit}/core`;
	const args = [
		path.join('build', 'next', 'index.ts'),
		'bundle',
		'--out',
		bundleTargets[target],
		'--target',
		target,
		'--minify',
		'--mangle-privates',
		'--nls',
		'--source-map-base-url',
		sourceMapBaseUrl
	];

	await run(process.execPath, args);
}

function assertBundleTarget(value: string | undefined): BundleTarget {
	if (value === 'desktop' || value === 'server' || value === 'server-web') {
		return value;
	}

	throw new Error(
		`Expected bundle target to be one of: ${
			Object.keys(bundleTargets).join(', ')
		}`
	);
}

async function main(): Promise<void> {
	const [command, target] = process.argv.slice(2);

	switch (command) {
		case 'check':
			await check();
			return;
		case 'prepare-bundle':
			await prepareBundle();
			return;
		case 'bundle':
			await bundle(assertBundleTarget(target));
			return;
		default:
			throw new Error(
				'Usage: node build/hucode/core-ci.ts check | prepare-bundle | ' +
				'bundle <desktop|server|server-web>'
			);
	}
}

await main();
