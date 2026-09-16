/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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

/**
 * Spawns a command from the repository root and streams its output.
 *
 * @param command - string executable to spawn.
 * @param args - string arguments passed to the executable.
 * @param env - NodeJS.ProcessEnv overrides merged with `process.env`.
 * Defaults to `{}`.
 * @returns Promise<void> that resolves when the command exits with code 0.
 * @throws Error when spawning fails or the command exits with a non-zero code.
 */
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

/**
 * Runs one gulp task through npm from the repository root.
 *
 * @param taskName - string gulp task name to pass to `npm run gulp`.
 * @returns Promise<void> that resolves when the gulp task succeeds.
 * @throws Error when the spawned npm command fails or exits non-zero.
 */
async function runGulpTask(taskName: string): Promise<void> {
	await run('npm', ['run', 'gulp', taskName]);
}

/**
 * Writes the current git commit date into `out-build/date`.
 *
 * @returns Promise<void> after creating `out-build` and writing the date file.
 * @throws Error when the output directory or date file cannot be written.
 */
async function writeBuildDate(): Promise<void> {
	const outBuildPath = path.join(repoRoot, 'out-build');
	await fs.promises.mkdir(outBuildPath, { recursive: true });
	await fs.promises.writeFile(
		path.join(outBuildPath, 'date'),
		getGitCommitDate(),
		'utf8'
	);
}

/**
 * Runs the non-bundle core compile checks used by Hucode CI.
 *
 * @returns Promise<void> after writing build metadata, typechecking, and
 * transpiling `src` to `out-build`.
 * @throws Error when typechecking, transpilation, or file writes fail.
 */
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

/**
 * Prepares source-tree and extension inputs required by a bundle job.
 *
 * @returns Promise<void> after generating codicons, extension outputs,
 * extension media, and build metadata.
 * @throws Error when any gulp task or build-date write fails.
 */
async function prepareBundle(): Promise<void> {
	await runGulpTask('copy-codicons');
	await runGulpTask('compile-non-native-extensions-build');
	await runGulpTask('compile-extension-media-build');
	await writeBuildDate();
}

/**
 * Bundles one core compile target using the current repository version.
 *
 * @param target - BundleTarget output to build: `desktop`, `server`, or
 * `server-web`.
 * @returns Promise<void> after the target bundle command exits successfully.
 * @throws Error when the bundle subprocess fails or exits non-zero.
 */
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

/**
 * Validates a CLI argument as a supported bundle target.
 *
 * @param value - string CLI target argument, or undefined when omitted.
 * @returns BundleTarget matching the validated CLI argument.
 * @throws Error when the value is missing or unsupported.
 */
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

/**
 * Dispatches the Hucode core CI helper command requested on the CLI.
 *
 * @returns Promise<void> after the requested command completes successfully.
 * @throws Error when the command is unknown or the selected command fails.
 */
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
