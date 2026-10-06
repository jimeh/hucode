/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { dump, load } from 'js-yaml';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface IPnpmLockfile {
	importers?: Record<string, Record<string, JsonValue>>;
	readonly [key: string]: JsonValue | Record<string, Record<string, JsonValue>> | undefined;
}

const ROOT = path.join(import.meta.dirname, '../../..');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const LOCKFILE_NAME = 'pnpm-lock.yaml';
const IMPORTER_DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function jsonEquals(first: JsonValue | undefined, second: JsonValue | undefined): boolean {
	return JSON.stringify(first) === JSON.stringify(second);
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Seeds regeneration with the base lockfile, minus every importer dependency the PR
 * added or changed, so pnpm resolves those again while keeping the base resolution
 * of everything else.
 */
export function createLockfileRegenerationSeed(base: IPnpmLockfile | undefined, submitted: IPnpmLockfile): IPnpmLockfile | undefined {
	if (!base) {
		return undefined;
	}

	const seed = structuredClone(base);
	for (const [importerId, importer] of Object.entries(seed.importers ?? {})) {
		const submittedImporter = submitted.importers?.[importerId];
		for (const group of IMPORTER_DEPENDENCY_GROUPS) {
			const dependencies = importer[group];
			if (!isRecord(dependencies)) {
				continue;
			}
			const submittedDependencies = submittedImporter?.[group];
			for (const name of Object.keys(dependencies)) {
				const submittedDependency = isRecord(submittedDependencies) ? submittedDependencies[name] : undefined;
				if (!jsonEquals(dependencies[name], submittedDependency)) {
					delete dependencies[name];
				}
			}
		}
	}

	return seed;
}

function normalizeForComparison(value: JsonValue, key?: string): JsonValue {
	// Registry mirrors can describe the same tarball with different integrity algorithms (for example, sha1 versus sha512).
	if (key === 'integrity') {
		return '<registry integrity>';
	}
	if (Array.isArray(value)) {
		return value.map(item => normalizeForComparison(item));
	}
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, normalizeForComparison(childValue, childKey)]));
	}
	return value;
}

function formatValue(value: JsonValue | undefined): string {
	return value === undefined ? '<missing>' : JSON.stringify(value);
}

export function findLockfileDifferences(expected: IPnpmLockfile, submitted: IPnpmLockfile, limit = 50): string[] {
	const differences: string[] = [];

	function compare(expectedValue: JsonValue | undefined, submittedValue: JsonValue | undefined, propertyPath: string): void {
		if (differences.length >= limit || jsonEquals(expectedValue, submittedValue)) {
			return;
		}
		if (!isRecord(expectedValue) || !isRecord(submittedValue)) {
			differences.push(`${propertyPath}: expected ${formatValue(expectedValue)}, submitted ${formatValue(submittedValue)}`);
			return;
		}

		const keys = new Set([...Object.keys(expectedValue), ...Object.keys(submittedValue)]);
		for (const key of [...keys].sort()) {
			compare(expectedValue[key], submittedValue[key], propertyPath ? `${propertyPath}.${key}` : key);
		}
	}

	compare(normalizeForComparison(expected as JsonValue), normalizeForComparison(submitted as JsonValue), '');
	return differences;
}

function readLockfile(contents: string, filePath: string): IPnpmLockfile {
	try {
		const lockfile = load(contents);
		if (!isRecord(lockfile as JsonValue)) {
			throw new Error('not a YAML mapping');
		}
		return lockfile as IPnpmLockfile;
	} catch (error) {
		throw new Error(`Cannot parse ${filePath}: ${error}`);
	}
}

function git(...args: string[]): string {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function getBaseLockfile(baseRef: string, relativeLockPath: string): IPnpmLockfile | undefined {
	try {
		const contents = git('show', `${baseRef}:${relativeLockPath}`);
		return readLockfile(contents, `${baseRef}:${relativeLockPath}`);
	} catch {
		return undefined;
	}
}

function regenerateLockfile(lockPath: string, seed: IPnpmLockfile | undefined): IPnpmLockfile {
	const submittedContents = fs.readFileSync(lockPath, 'utf8');
	try {
		if (seed) {
			fs.writeFileSync(lockPath, dump(seed, { lineWidth: -1 }));
		} else {
			fs.rmSync(lockPath);
		}
		execFileSync(PNPM, ['install', '--lockfile-only', '--ignore-scripts'], {
			cwd: path.dirname(lockPath),
			stdio: 'inherit',
			shell: process.platform === 'win32'
		});
		return readLockfile(fs.readFileSync(lockPath, 'utf8'), lockPath);
	} finally {
		fs.writeFileSync(lockPath, submittedContents);
	}
}

function main(): void {
	const args = process.argv.slice(2);
	const baseRef = args.find(arg => !arg.startsWith('--')) ?? 'origin/main';
	const changedFiles = new Set(git('diff', '--name-only', `${baseRef}...HEAD`).split('\n'));
	if (args.includes('--include-working-tree')) {
		for (const file of git('diff', '--name-only').split('\n')) {
			changedFiles.add(file);
		}
	}
	const changedLockfiles = [...changedFiles].filter(file => file && path.basename(file) === LOCKFILE_NAME);

	if (changedLockfiles.length === 0) {
		console.log(`No changed ${LOCKFILE_NAME} files to validate.`);
		return;
	}

	let failed = false;
	for (const relativeLockPath of changedLockfiles) {
		const lockPath = path.join(ROOT, relativeLockPath);
		if (!fs.existsSync(lockPath)) {
			continue;
		}

		console.log(`Regenerating ${relativeLockPath} with pnpm ${process.env.npm_config_user_agent ?? ''}...`);
		const submitted = readLockfile(fs.readFileSync(lockPath, 'utf8'), lockPath);
		const seed = createLockfileRegenerationSeed(getBaseLockfile(baseRef, relativeLockPath), submitted);
		const expected = regenerateLockfile(lockPath, seed);
		const differences = findLockfileDifferences(expected, submitted);

		if (differences.length === 0) {
			console.log(`Verified ${relativeLockPath}.`);
			continue;
		}

		failed = true;
		console.error(`\n${relativeLockPath} contains changes that are not produced by the repository's pnpm version:`);
		for (const difference of differences) {
			console.error(`  - ${difference}`);
		}
		console.error(`Regenerate ${relativeLockPath} with the pnpm version pinned in package.json and commit the resulting lockfile.`);
	}

	if (failed) {
		process.exit(1);
	}
}

if (import.meta.filename === process.argv[1]) {
	main();
}
