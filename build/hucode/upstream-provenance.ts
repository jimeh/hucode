/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import provenanceJson from './upstream-provenance.json' with { type: 'json' };

const execFileAsync = promisify(execFile);
const FORK_ROOT = 'src/vs/hucode/browser';
const FORK_UPSTREAM_ROOT = 'src/vs/sessions/browser';
const MICROSOFT_NOTICE = 'Copyright (c) Microsoft Corporation';

/**
 * The ways Hucode can own a surface outside its normal source namespace.
 */
export type UpstreamSurfaceKind =
	| 'fork'
	| 'upstream-patch'
	| 'hucode-owned-upstream-path';

/**
 * An upstream-named test suite that Hucode deliberately runs.
 */
export interface ProvenanceTestSuite {

	/** Repository-relative source path. */
	file: string;

	/** Why Hucode owns or extends this suite. */
	reason: string;
}

/**
 * The upstream source revision a Hucode surface was last reconciled against.
 */
export interface UpstreamSource {

	/** Path in the clean upstream tree. */
	path: string;

	/** VS Code release baseline used for the last reconciliation. */
	lastSyncedBaseline: string;

	/** Git blob object ID of the upstream source at that baseline. */
	blob: string;
}

/**
 * One Hucode-owned or Hucode-patched surface and its test coverage.
 */
export interface UpstreamSurface {

	/** Repository-relative path identifying the owned surface. */
	path: string;

	/** How Hucode owns the surface. */
	kind: UpstreamSurfaceKind;

	/** Why the surface belongs in the provenance inventory. */
	reason: string;

	/** Upstream source tracked for upgrade drift, when one exists. */
	upstream?: UpstreamSource;

	/** Upstream-named suites the surface requires Hucode CI to run. */
	testSuites: ProvenanceTestSuite[];
}

/**
 * Machine-readable inventory of upstream-derived and upstream-path surfaces.
 */
export interface UpstreamProvenance {

	/** Schema revision for validation and future migrations. */
	schemaVersion: number;

	/** Hucode surfaces that need explicit upgrade or CI treatment. */
	surfaces: UpstreamSurface[];
}

/**
 * The repository's checked-in upstream provenance inventory.
 */
export const UPSTREAM_PROVENANCE =
	provenanceJson as UpstreamProvenance;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepositoryPath(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& !path.isAbsolute(value)
		&& value.split('/').every(part => part !== '..' && part !== '');
}

/**
 * Validates the shape and uniqueness contracts of provenance data.
 */
export function validateProvenanceData(data: unknown): string[] {
	const problems: string[] = [];
	if (!isRecord(data)) {
		return ['Upstream provenance must be an object.'];
	}

	if (data.schemaVersion !== 1) {
		problems.push(
			`Unsupported provenance schema version: ${String(data.schemaVersion)}`
		);
	}
	if (!Array.isArray(data.surfaces)) {
		problems.push('Upstream provenance surfaces must be an array.');
		return problems;
	}

	const surfacePaths = new Set<string>();
	const suiteOwners = new Map<string, string>();
	for (const [index, value] of data.surfaces.entries()) {
		if (!isRecord(value)) {
			problems.push(`Surface ${index} must be an object.`);
			continue;
		}

		if (!isRepositoryPath(value.path)) {
			problems.push(`Surface ${index} has no repository-relative path.`);
		} else if (surfacePaths.has(value.path)) {
			problems.push(`Surface path is duplicated: ${value.path}`);
		} else {
			surfacePaths.add(value.path);
		}

		if (
			value.kind !== 'fork'
			&& value.kind !== 'upstream-patch'
			&& value.kind !== 'hucode-owned-upstream-path'
		) {
			problems.push(`Surface ${index} has an unsupported kind.`);
		}
		if (typeof value.reason !== 'string' || value.reason.length === 0) {
			problems.push(`Surface ${index} has no reason.`);
		}

		if (value.upstream !== undefined) {
			if (!isRecord(value.upstream)) {
				problems.push(`Surface ${index} upstream metadata must be an object.`);
			} else {
				if (!isRepositoryPath(value.upstream.path)) {
					problems.push(`Surface ${index} upstream path is missing.`);
				}
				if (
					typeof value.upstream.lastSyncedBaseline !== 'string'
					|| !/^\d+\.\d+\.\d+$/.test(
						value.upstream.lastSyncedBaseline
					)
				) {
					problems.push(
						`Surface ${index} upstream baseline must be a release version.`
					);
				}
				if (
					typeof value.upstream.blob !== 'string'
					|| !/^[0-9a-f]{40}$/.test(value.upstream.blob)
				) {
					problems.push(
						`Surface ${index} upstream blob must be a `
							+ '40-character Git object ID.'
					);
				}
			}
		} else if (value.kind === 'fork') {
			problems.push(`Fork surface ${index} has no upstream metadata.`);
		}

		if (!Array.isArray(value.testSuites)) {
			problems.push(`Surface ${index} testSuites must be an array.`);
			continue;
		}
		for (const [suiteIndex, suite] of value.testSuites.entries()) {
			if (!isRecord(suite)) {
				problems.push(
					`Surface ${index} suite ${suiteIndex} must be an object.`
				);
				continue;
			}
			if (!isRepositoryPath(suite.file)) {
				problems.push(
					`Surface ${index} suite ${suiteIndex} has no `
						+ 'repository-relative file.'
				);
			} else {
				const owner = suiteOwners.get(suite.file);
				if (owner !== undefined) {
					problems.push(
						`Upstream suite is owned by more than one surface: `
							+ `${suite.file} (${owner}, ${String(value.path)})`
					);
				} else {
					suiteOwners.set(suite.file, String(value.path));
				}
			}
			if (typeof suite.reason !== 'string' || suite.reason.length === 0) {
				problems.push(
					`Surface ${index} suite ${suiteIndex} has no reason.`
				);
			}
		}
	}

	return problems;
}

/**
 * Returns every upstream-named suite registered by a provenance surface.
 */
export function upstreamSuitesFromProvenance(
	provenance: UpstreamProvenance
): ProvenanceTestSuite[] {
	const suites = new Map<string, ProvenanceTestSuite>();
	for (const surface of provenance.surfaces) {
		for (const suite of surface.testSuites) {
			if (!suites.has(suite.file)) {
				suites.set(suite.file, suite);
			}
		}
	}
	return [...suites.values()].sort((left, right) =>
		left.file.localeCompare(right.file)
	);
}

async function isDeliberateFork(
	repoRoot: string,
	target: string
): Promise<boolean> {
	const relative = path.posix.relative(FORK_ROOT, target);
	const upstream = path.join(repoRoot, FORK_UPSTREAM_ROOT, relative);
	try {
		const [source] = await Promise.all([
			fs.readFile(path.join(repoRoot, target), 'utf8'),
			fs.access(upstream),
		]);
		return source.includes(MICROSOFT_NOTICE);
	} catch {
		return false;
	}
}

/**
 * Discovers the workbench and shell Part forks covered by H1.
 */
export async function discoverForkedFiles(
	repoRoot: string
): Promise<string[]> {
	const candidates = [`${FORK_ROOT}/workbench.ts`];
	const partsRoot = path.join(repoRoot, FORK_ROOT, 'parts');
	for (const entry of await fs.readdir(partsRoot, { withFileTypes: true })) {
		if (entry.isFile() && /Part\.ts$/.test(entry.name)) {
			candidates.push(`${FORK_ROOT}/parts/${entry.name}`);
		}
	}

	const forks: string[] = [];
	for (const candidate of candidates) {
		if (await isDeliberateFork(repoRoot, candidate)) {
			forks.push(candidate);
		}
	}
	return forks.sort();
}

/**
 * Validates the checked-out repository without requiring any upstream Git ref.
 */
export async function validateProvenance(
	repoRoot: string,
	provenance: UpstreamProvenance
): Promise<string[]> {
	const problems = validateProvenanceData(provenance);
	if (problems.length > 0) {
		return problems;
	}

	const discoveredForks = new Set(await discoverForkedFiles(repoRoot));
	const registeredForks = new Set(
		provenance.surfaces
			.filter(surface => surface.kind === 'fork')
			.map(surface => surface.path)
	);
	for (const fork of discoveredForks) {
		if (!registeredForks.has(fork)) {
			problems.push(`Provenance is missing a fork entry for: ${fork}`);
		}
	}
	for (const fork of registeredForks) {
		if (!discoveredForks.has(fork)) {
			problems.push(`Provenance has a dead fork entry: ${fork}`);
		}
	}

	for (const surface of provenance.surfaces) {
		try {
			await fs.access(path.join(repoRoot, surface.path));
		} catch {
			problems.push(`Provenance names a missing surface: ${surface.path}`);
		}
		if (surface.upstream) {
			try {
				await fs.access(path.join(repoRoot, surface.upstream.path));
			} catch {
				problems.push(
					`Provenance names a missing upstream source in the `
						+ `checkout: ${surface.upstream.path}`
				);
			}
		}
	}

	for (const suite of upstreamSuitesFromProvenance(provenance)) {
		try {
			await fs.access(path.join(repoRoot, suite.file));
		} catch {
			problems.push(`Provenance names a missing test suite: ${suite.file}`);
		}
	}

	return problems;
}

/**
 * Compares tracked upstream sources with a clean upstream Git ref.
 */
export async function checkUpstreamDrift(
	repoRoot: string,
	provenance: UpstreamProvenance,
	upstreamRef: string
): Promise<string[]> {
	const problems: string[] = [];
	for (const surface of provenance.surfaces) {
		if (!surface.upstream) {
			continue;
		}

		let actual: string;
		try {
			const { stdout } = await execFileAsync(
				'git',
				[
					'rev-parse',
					'--verify',
					'--end-of-options',
					`${upstreamRef}:${surface.upstream.path}`,
				],
				{ cwd: repoRoot }
			);
			actual = stdout.trim();
		} catch {
			problems.push(
				`Provenance cannot read ${surface.upstream.path} from `
					+ `${upstreamRef}.`
			);
			continue;
		}

		if (actual !== surface.upstream.blob) {
			problems.push(
				`Provenance upstream source changed for ${surface.path}: `
					+ `${surface.upstream.path} at ${upstreamRef} is ${actual}, `
					+ `recorded ${surface.upstream.blob} from `
					+ `${surface.upstream.lastSyncedBaseline}.`
			);
		}
	}
	return problems;
}

function repositoryRoot(): string {
	return path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const upstreamRefIndex = args.indexOf('--upstream-ref');
	const allowedLength = upstreamRefIndex === -1 ? 0 : 2;
	if (
		args.length !== allowedLength
		|| (upstreamRefIndex !== -1 && !args[upstreamRefIndex + 1])
	) {
		throw new Error(
			'Usage: upstream-provenance.ts [--upstream-ref <git-ref>]'
		);
	}

	const repoRoot = repositoryRoot();
	const problems = await validateProvenance(repoRoot, UPSTREAM_PROVENANCE);
	if (upstreamRefIndex !== -1) {
		problems.push(...await checkUpstreamDrift(
			repoRoot,
			UPSTREAM_PROVENANCE,
			args[upstreamRefIndex + 1]
		));
	}

	if (problems.length > 0) {
		throw new Error(problems.join('\n'));
	}
	console.log(
		upstreamRefIndex === -1
			? 'Hucode upstream provenance is complete.'
			: `Hucode upstream provenance matches ${args[upstreamRefIndex + 1]}.`
	);
}

if (
	process.argv[1]
	&& path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await main();
}
