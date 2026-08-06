/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from 'playwright-core';
import { spawn, type ChildProcess } from 'child_process';
import { constants, promises as fs } from 'fs';
import { createServer } from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
	assertHostedWorkbenchSmokeCommandVisible,
	hostedWorkbenchSmokeCommands,
	readOmniWorkbenchSmokeRows,
	runHostedWorkbenchSmokeCommand,
} from './omni-hosted-command-smoke.ts';

const defaultTimeoutMs = 300_000;
const maximumLaunchAttempts = 3;
const maximumLogLength = 64 * 1024;
const pollIntervalMs = 100;
const workbenchLabels = ['Alpha', 'Bravo'] as const;
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..'
);
const smokeArtifactRoot = path.join(
	repoRoot,
	'.build',
	'hucode-smoke-artifacts'
);

type LinuxOmniWorkbenchLabel = typeof workbenchLabels[number];
type LinuxOmniWorkbenchState =
	| 'restore-pending'
	| 'loading'
	| 'active'
	| 'loaded'
	| 'dormant'
	| 'unloaded'
	| 'missing'
	| 'crashed';

interface ILinuxOmniResolvedConfiguration {
	readonly isOmniWindow?: boolean;
	readonly isHostedOmniWorkspace?: boolean;
	readonly hostedInstanceId?: string;
	readonly workspace?: {
		readonly uri?: {
			readonly scheme?: string;
			readonly path?: string;
		};
	};
}

/**
 * Serializable renderer information used to classify CDP targets.
 */
export interface ILinuxOmniTargetCandidate {
	readonly targetId?: string;
	readonly url: string;
	readonly configuration?: ILinuxOmniResolvedConfiguration;
	readonly configurationError?: string;
	readonly crashed?: boolean;
}

/**
 * One live hosted workbench found through its resolved renderer configuration.
 */
export interface ILinuxOmniWorkbenchTarget {
	readonly targetId?: string;
	readonly url: string;
	readonly worktreePath: string;
	readonly hostedInstanceId: string;
}

/**
 * Strictly classified Omni renderer inventory.
 */
export interface ILinuxOmniTargetInventory {
	readonly shellUrl: string;
	readonly shellTargetId?: string;
	readonly workbenches: readonly ILinuxOmniWorkbenchTarget[];
	readonly crashedRendererUrls: readonly string[];
}

/**
 * One Projects row observed during the lifecycle smoke test.
 */
export interface ILinuxOmniWorkbenchRow {
	readonly label: string;
	readonly state: LinuxOmniWorkbenchState;
	readonly active: boolean;
	readonly ariaLabel?: string;
}

/**
 * Observable shell and target state at one lifecycle phase.
 */
export interface ILinuxOmniLifecycleObservation {
	readonly rows: readonly ILinuxOmniWorkbenchRow[];
	readonly targetPaths: readonly string[];
	readonly shellResponsive: boolean;
	readonly crashedRendererCount: number;
}

/**
 * One Projects row expected during the lifecycle smoke test.
 */
export interface ILinuxOmniExpectedWorkbenchRow {
	readonly label: string;
	readonly state: LinuxOmniWorkbenchState;
	readonly active: boolean;
	readonly ariaDescription: string;
}

/**
 * Expected observable shell and target state at one lifecycle phase.
 */
export interface ILinuxOmniLifecycleExpectation {
	readonly rows: readonly ILinuxOmniExpectedWorkbenchRow[];
	readonly targetPaths: readonly string[];
	readonly crashedRendererCount: number;
}

/**
 * Deterministic persisted state and settings for the lifecycle scenario.
 */
export interface ILinuxOmniSmokeFixture {
	readonly storage: {
		readonly windowsState: object;
	};
	readonly settings: Readonly<Record<string, string>>;
}

/**
 * Named phases emitted in diagnostics by the packaged lifecycle smoke.
 */
export const linuxOmniLifecyclePhases = [
	'initial restore',
	'switch to Bravo',
	'switch to Alpha',
	'hosted full picker to Bravo',
	'hosted previous loaded to Alpha',
	'hosted next loaded to Bravo',
	'hosted last active to Alpha',
	'hosted quick switch to Bravo',
	'hosted unload Bravo',
	'restore Bravo after hosted unload',
	'suspend Bravo',
	'restore Bravo',
	'crash Bravo',
	'recover Bravo',
	'quit',
	'relaunch restore',
] as const;

type LinuxOmniLifecyclePhase = typeof linuxOmniLifecyclePhases[number];

/**
 * Expected UI and renderer inventory for every observable lifecycle phase.
 */
export function createLinuxOmniLifecycleExpectations(
	alphaPath: string,
	bravoPath: string
): Readonly<Partial<Record<
	LinuxOmniLifecyclePhase,
	ILinuxOmniLifecycleExpectation
>>> {
	return {
		'initial restore': {
			rows: [
				{
					label: 'Alpha',
					state: 'active',
					active: true,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo',
					state: 'dormant',
					active: false,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath],
			crashedRendererCount: 0,
		},
		'switch to Bravo': {
			rows: [
				{
					label: 'Alpha',
					state: 'loaded',
					active: false,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo',
					state: 'active',
					active: true,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath, bravoPath],
			crashedRendererCount: 0,
		},
		'switch to Alpha': {
			rows: [
				{
					label: 'Alpha',
					state: 'active',
					active: true,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo',
					state: 'loaded',
					active: false,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath, bravoPath],
			crashedRendererCount: 0,
		},
		'hosted full picker to Bravo': {
			rows: [
				{
					label: 'Alpha',
					state: 'loaded',
					active: false,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo',
					state: 'active',
					active: true,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath, bravoPath],
			crashedRendererCount: 0,
		},
		'hosted previous loaded to Alpha': {
			rows: [
				{
					label: 'Alpha',
					state: 'active',
					active: true,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo',
					state: 'loaded',
					active: false,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath, bravoPath],
			crashedRendererCount: 0,
		},
		'hosted next loaded to Bravo': {
			rows: [
				{
					label: 'Alpha', state: 'loaded', active: false,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo', state: 'active', active: true,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath, bravoPath],
			crashedRendererCount: 0,
		},
		'hosted last active to Alpha': {
			rows: [
				{
					label: 'Alpha', state: 'active', active: true,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo', state: 'loaded', active: false,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath, bravoPath],
			crashedRendererCount: 0,
		},
		'hosted quick switch to Bravo': {
			rows: [
				{
					label: 'Alpha', state: 'loaded', active: false,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo', state: 'active', active: true,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath, bravoPath],
			crashedRendererCount: 0,
		},
		'hosted unload Bravo': {
			rows: [
				{
					label: 'Alpha', state: 'active', active: true,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo', state: 'unloaded', active: false,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath],
			crashedRendererCount: 0,
		},
		'restore Bravo after hosted unload': {
			rows: [
				{
					label: 'Alpha', state: 'loaded', active: false,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo', state: 'active', active: true,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath, bravoPath],
			crashedRendererCount: 0,
		},
		'suspend Bravo': {
			rows: [
				{
					label: 'Alpha',
					state: 'active',
					active: true,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo',
					state: 'dormant',
					active: false,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath],
			crashedRendererCount: 0,
		},
		'restore Bravo': {
			rows: [
				{
					label: 'Alpha',
					state: 'loaded',
					active: false,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo',
					state: 'active',
					active: true,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath, bravoPath],
			crashedRendererCount: 0,
		},
		'crash Bravo': {
			rows: [
				{
					label: 'Alpha',
					state: 'loaded',
					active: false,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo',
					state: 'crashed',
					active: true,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath],
			crashedRendererCount: 1,
		},
		'recover Bravo': {
			rows: [
				{
					label: 'Alpha',
					state: 'loaded',
					active: false,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo',
					state: 'active',
					active: true,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [alphaPath, bravoPath],
			crashedRendererCount: 0,
		},
		'relaunch restore': {
			rows: [
				{
					label: 'Alpha',
					state: 'dormant',
					active: false,
					ariaDescription: alphaPath,
				},
				{
					label: 'Bravo',
					state: 'active',
					active: true,
					ariaDescription: bravoPath,
				},
			],
			targetPaths: [bravoPath],
			crashedRendererCount: 0,
		},
	};
}

interface ILinuxOmniLaunch {
	readonly browser: Browser;
	readonly child: ChildProcess;
	readonly getSpawnError: () => Error | undefined;
}

interface ILinuxOmniRuntimeInventory {
	readonly inventory: ILinuxOmniTargetInventory;
	readonly pagesByTargetId: ReadonlyMap<string, Page>;
}

/**
 * Parsed command-line options for the packaged Linux Omni lifecycle smoke.
 */
export interface ILinuxOmniSmokeOptions {
	readonly executablePath: string;
	readonly timeoutMs: number;
}

/**
 * Renderer counts observed through the packaged application's CDP endpoint.
 */
export interface ILinuxOmniRendererSummary {
	readonly rendererUrls: readonly string[];
	readonly applicationRendererCount: number;
	readonly omniRendererCount: number;
}

/**
 * Parses the packaged Linux Omni lifecycle smoke command line.
 */
export function parseLinuxOmniSmokeOptions(
	args: readonly string[]
): ILinuxOmniSmokeOptions {
	let executablePath: string | undefined;
	let timeoutMs = defaultTimeoutMs;

	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		switch (argument) {
			case '--app':
			case '--executable': {
				executablePath = args[++index];
				if (!executablePath) {
					throw new Error(`${argument} requires a path`);
				}
				break;
			}
			case '--timeout-ms': {
				const value = args[++index];
				timeoutMs = Number(value);
				if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
					throw new Error(`Invalid --timeout-ms value: ${value}`);
				}
				break;
			}
			default:
				throw new Error(`Unknown argument: ${argument}`);
		}
	}

	if (!executablePath) {
		throw new Error(
			'Pass --executable <path> or --app <packaged-app-directory>'
		);
	}

	return { executablePath, timeoutMs };
}

/**
 * Builds arguments for an isolated packaged Hucode lifecycle with CDP enabled.
 */
export function buildLinuxOmniSmokeArguments(
	userDataDir: string,
	extensionsDir: string,
	remoteDebuggingPort: number
): string[] {
	return [
		`--user-data-dir=${userDataDir}`,
		`--extensions-dir=${extensionsDir}`,
		`--remote-debugging-port=${remoteDebuggingPort}`,
		'--disable-extensions',
		'--disable-workspace-trust',
		'--skip-release-notes',
		'--skip-welcome',
		'--password-store=basic',
		'--enable-smoke-test-driver',
	];
}

/**
 * Creates the direct FileStorage payload and user settings for two retained
 * arbitrary-folder workbenches.
 */
export function createLinuxOmniSmokeFixture(
	alphaPath: string,
	bravoPath: string
): ILinuxOmniSmokeFixture {
	const createRetainedWorkbench = (
		id: string,
		label: LinuxOmniWorkbenchLabel,
		worktreePath: string,
		order: number,
		lastActiveAt: number
	) => ({
		id,
		folderUri: {
			scheme: 'file',
			path: worktreePath,
		},
		label,
		desiredState: 'loaded',
		order,
		lastActiveAt,
	});

	return {
		storage: {
			windowsState: {
				lastActiveWindow: {
					windowKind: 'omni',
					omniActiveWorktreePath: alphaPath,
					omniRetainedWorkbenches: [
						createRetainedWorkbench(
							'smoke-alpha',
							'Alpha',
							alphaPath,
							0,
							2
						),
						createRetainedWorkbench(
							'smoke-bravo',
							'Bravo',
							bravoPath,
							1,
							1
						),
					],
					uiState: {
						width: 1200,
						height: 800,
						mode: 0,
					},
				},
				openedWindows: [],
			},
		},
		settings: {
			'window.restoreWindows': 'one',
			'window.confirmBeforeClose': 'never',
			'hucode.omni.restoreHostedWorkbenches': 'active',
		},
	};
}

/**
 * Classifies application targets by their resolved sandbox configuration.
 */
export function classifyLinuxOmniTargets(
	candidates: readonly ILinuxOmniTargetCandidate[],
	expectedWorktreePaths: readonly string[]
): ILinuxOmniTargetInventory {
	const expectedPaths = new Set(expectedWorktreePaths.map(normalizeSmokePath));
	const shellCandidates: ILinuxOmniTargetCandidate[] = [];
	const workbenches: ILinuxOmniWorkbenchTarget[] = [];
	const crashedRendererUrls: string[] = [];

	for (const candidate of candidates) {
		if (/^(?:chrome-)?devtools:\/\//.test(candidate.url)) {
			continue;
		}
		if (candidate.crashed) {
			crashedRendererUrls.push(candidate.url);
			continue;
		}

		const configuration = candidate.configuration;
		if (
			configuration?.isOmniWindow === true &&
			configuration.isHostedOmniWorkspace !== true
		) {
			shellCandidates.push(candidate);
			continue;
		}

		if (configuration?.isHostedOmniWorkspace === true) {
			const hostedInstanceId = configuration.hostedInstanceId;
			const workspaceUri = configuration.workspace?.uri;
			const worktreePath = workspaceUri?.scheme === 'file' &&
					typeof workspaceUri.path === 'string'
				? normalizeSmokePath(workspaceUri.path)
				: undefined;
			if (
				!hostedInstanceId ||
				!worktreePath ||
				!expectedPaths.has(worktreePath)
			) {
				throw new Error(
					`Observed invalid hosted target ${JSON.stringify(candidate)}`
				);
			}

			workbenches.push({
				...(candidate.targetId === undefined
					? {}
					: { targetId: candidate.targetId }),
				url: candidate.url,
				worktreePath,
				hostedInstanceId,
			});
			continue;
		}

		throw new Error(
			'Unclassified application target ' +
				JSON.stringify(candidate)
		);
	}

	if (shellCandidates.length !== 1) {
		throw new Error(
			'Expected exactly one Omni shell target, observed ' +
				`${shellCandidates.length}: ${JSON.stringify(shellCandidates)}`
		);
	}

	for (const worktreePath of expectedPaths) {
		const matching = workbenches.filter(
			target => target.worktreePath === worktreePath
		);
		if (matching.length > 1) {
			throw new Error(
				`Expected at most one live hosted target for ${worktreePath}, ` +
					`observed ${matching.length}: ${JSON.stringify(matching)}`
			);
		}
	}

	const instanceIds = workbenches.map(target => target.hostedInstanceId);
	if (new Set(instanceIds).size !== instanceIds.length) {
		throw new Error(
			'Hosted target instance IDs are not unique: ' +
				JSON.stringify(workbenches)
		);
	}

	const shell = shellCandidates[0];
	return {
		shellUrl: shell.url,
		...(shell.targetId === undefined
			? {}
			: { shellTargetId: shell.targetId }),
		workbenches,
		crashedRendererUrls,
	};
}

/**
 * Verifies exact visible lifecycle state without depending on renderer order.
 */
export function assertLinuxOmniLifecycleObservation(
	phase: LinuxOmniLifecyclePhase,
	observation: ILinuxOmniLifecycleObservation,
	expectation: ILinuxOmniLifecycleExpectation
): void {
	const normalizeRows = (rows: readonly Pick<
		ILinuxOmniWorkbenchRow,
		'label' | 'state' | 'active'
	>[]) =>
		[...rows]
			.map(row => ({
				label: row.label,
				state: row.state,
				active: row.active,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	const expectedRows = normalizeRows(expectation.rows);
	const observedRows = normalizeRows(observation.rows);
	const expectedTargets = expectation.targetPaths
		.map(normalizeSmokePath)
		.sort();
	const observedTargets = observation.targetPaths
		.map(normalizeSmokePath)
		.sort();
	const invalidAriaRows = observation.rows.filter(row => {
		const expectedRow = expectation.rows.find(
			candidate => candidate.label === row.label
		);
		const expectedStateLabel =
			row.state === 'restore-pending'
				? 'Loading'
				: row.state.charAt(0).toUpperCase() + row.state.slice(1);
		const ariaParts = row.ariaLabel?.split(', ');
		return (
			ariaParts?.length !== 3 ||
			ariaParts[0] !== row.label ||
			!expectedRow ||
			normalizeSmokePath(ariaParts[1]) !==
				normalizeSmokePath(expectedRow.ariaDescription) ||
			ariaParts[2] !== expectedStateLabel
		);
	});

	if (
		!observation.shellResponsive ||
		JSON.stringify(observedRows) !== JSON.stringify(expectedRows) ||
		JSON.stringify(observedTargets) !== JSON.stringify(expectedTargets) ||
		observation.crashedRendererCount !==
			expectation.crashedRendererCount ||
		invalidAriaRows.length
	) {
		throw new Error(
			`${phase}: expected ${JSON.stringify({
				rows: expectedRows,
				targetPaths: expectedTargets,
				shellResponsive: true,
				crashedRendererCount: expectation.crashedRendererCount,
			})}, observed ${JSON.stringify({
				rows: observedRows,
				targetPaths: observedTargets,
				shellResponsive: observation.shellResponsive,
				crashedRendererCount: observation.crashedRendererCount,
				invalidAriaRows,
			})}`
		);
	}
}

/**
 * Formats an application exit with the lifecycle phase that observed it.
 */
export function formatLinuxOmniUnexpectedExit(
	phase: LinuxOmniLifecyclePhase,
	exitCode: number | null,
	signalCode: NodeJS.Signals | null
): string {
	return (
		`Packaged application exited during ${phase} ` +
		`(code=${exitCode}, signal=${signalCode})`
	);
}

/**
 * Summarizes Hucode application renderer URLs exposed through CDP.
 */
export function summarizeLinuxOmniRenderers(
	rendererUrls: readonly string[]
): ILinuxOmniRendererSummary {
	const relevantRendererUrls = rendererUrls.filter(url =>
		!/^(?:chrome-)?devtools:\/\//.test(url)
	);
	const omniRendererUrls = relevantRendererUrls.filter(url =>
		/\/vs\/hucode\/electron-browser\/omni(?:-dev)?\.html(?:[?#]|$)/
			.test(url)
	);

	return {
		rendererUrls: [...rendererUrls],
		applicationRendererCount: relevantRendererUrls.length,
		omniRendererCount: omniRendererUrls.length,
	};
}

/**
 * Allocates a fair portion of the remaining timeout to one CDP bind attempt.
 */
export function getLinuxOmniLaunchAttemptDeadline(
	deadline: number,
	now: number,
	attemptsRemaining: number
): number {
	return Math.min(
		deadline,
		now + Math.max(1, Math.floor((deadline - now) / attemptsRemaining))
	);
}

/**
 * Runs the packaged Linux Omni hosted-workbench lifecycle scenario.
 */
export async function runLinuxOmniSmoke(
	options: ILinuxOmniSmokeOptions
): Promise<ILinuxOmniRendererSummary> {
	if (process.platform !== 'linux') {
		throw new Error('The packaged Omni lifecycle smoke test requires Linux');
	}

	const executablePath = await resolveLinuxOmniExecutable(
		options.executablePath
	);
	const temporaryRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), 'hucode-linux-omni-smoke-')
	);
	const userDataDir = path.join(temporaryRoot, 'user-data');
	const extensionsDir = path.join(temporaryRoot, 'extensions');
	const alphaPath = path.join(temporaryRoot, 'Alpha');
	const bravoPath = path.join(temporaryRoot, 'Bravo');
	const fixture = createLinuxOmniSmokeFixture(alphaPath, bravoPath);
	await Promise.all([
		fs.mkdir(path.join(userDataDir, 'User', 'globalStorage'), {
			recursive: true,
		}),
		fs.mkdir(extensionsDir, { recursive: true }),
		fs.mkdir(alphaPath, { recursive: true }),
		fs.mkdir(bravoPath, { recursive: true }),
	]);
	await Promise.all([
		fs.writeFile(
			path.join(userDataDir, 'User', 'globalStorage', 'storage.json'),
			JSON.stringify(fixture.storage, null, 4)
		),
		fs.writeFile(
			path.join(userDataDir, 'User', 'settings.json'),
			JSON.stringify(fixture.settings, null, 4)
		),
	]);

	const expectedPaths = [alphaPath, bravoPath];
	const lifecycleExpectations = createLinuxOmniLifecycleExpectations(
		alphaPath,
		bravoPath
	);
	const crashedPages = new Set<Page>();
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	const attachedPages = new WeakSet<Page>();
	let launch: ILinuxOmniLaunch | undefined;
	let output = '';
	const appendOutput = (chunk: Buffer): void => {
		output = (output + chunk.toString()).slice(-maximumLogLength);
	};

	try {
		const deadline = Date.now() + options.timeoutMs;
		launch = await launchLinuxOmni(
			executablePath,
			userDataDir,
			extensionsDir,
			deadline,
			'initial restore',
			appendOutput
		);
		captureLinuxPageDiagnostics(
			launch.browser,
			attachedPages,
			pageErrors,
			consoleErrors
		);

		let runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'initial restore',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(lifecycleExpectations, 'initial restore')
		);
		let shellPage = getShellPage(runtime);
		const initialAlpha = getWorkbenchTarget(
			runtime,
			alphaPath
		);

		await clickWorkbenchRow(
			shellPage,
			'Bravo',
			deadline,
			'switch to Bravo'
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'switch to Bravo',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(lifecycleExpectations, 'switch to Bravo')
		);
		const firstBravo = getWorkbenchTarget(runtime, bravoPath);

		await clickWorkbenchRow(
			shellPage,
			'Alpha',
			deadline,
			'switch to Alpha'
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'switch to Alpha',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(lifecycleExpectations, 'switch to Alpha')
		);
		assertSameInstance('Alpha', initialAlpha, getWorkbenchTarget(
			runtime,
			alphaPath
		));
		assertSameInstance('Bravo', firstBravo, getWorkbenchTarget(
			runtime,
			bravoPath
		));

		let hostedPage = getTargetPage(runtime, getWorkbenchTarget(
			runtime,
			alphaPath
		));
		await runHostedWorkbenchSmokeCommand(
			hostedPage,
			hostedPage,
			hostedWorkbenchSmokeCommands.switchWorkbench,
			getRemainingTimeout(deadline),
			'Bravo'
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'hosted full picker to Bravo',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(
				lifecycleExpectations,
				'hosted full picker to Bravo'
			)
		);

		hostedPage = getTargetPage(runtime, getWorkbenchTarget(
			runtime,
			bravoPath
		));
		await runHostedWorkbenchSmokeCommand(
			hostedPage,
			hostedPage,
			hostedWorkbenchSmokeCommands.previousLoaded,
			getRemainingTimeout(deadline)
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'hosted previous loaded to Alpha',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(
				lifecycleExpectations,
				'hosted previous loaded to Alpha'
			)
		);

		hostedPage = getTargetPage(runtime, getWorkbenchTarget(
			runtime,
			alphaPath
		));
		await runHostedWorkbenchSmokeCommand(
			hostedPage,
			hostedPage,
			hostedWorkbenchSmokeCommands.nextLoaded,
			getRemainingTimeout(deadline)
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'hosted next loaded to Bravo',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(
				lifecycleExpectations,
				'hosted next loaded to Bravo'
			)
		);

		hostedPage = getTargetPage(runtime, getWorkbenchTarget(
			runtime,
			bravoPath
		));
		await runHostedWorkbenchSmokeCommand(
			hostedPage,
			hostedPage,
			hostedWorkbenchSmokeCommands.lastActive,
			getRemainingTimeout(deadline)
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'hosted last active to Alpha',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(
				lifecycleExpectations,
				'hosted last active to Alpha'
			)
		);

		hostedPage = getTargetPage(runtime, getWorkbenchTarget(
			runtime,
			alphaPath
		));
		await runHostedWorkbenchSmokeCommand(
			hostedPage,
			hostedPage,
			hostedWorkbenchSmokeCommands.quickSwitchLoaded,
			getRemainingTimeout(deadline),
			'Bravo'
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'hosted quick switch to Bravo',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(
				lifecycleExpectations,
				'hosted quick switch to Bravo'
			)
		);

		hostedPage = getTargetPage(runtime, getWorkbenchTarget(
			runtime,
			bravoPath
		));
		await assertHostedWorkbenchSmokeCommandVisible(
			hostedPage,
			hostedPage,
			hostedWorkbenchSmokeCommands.unloadCurrent,
			getRemainingTimeout(deadline)
		);
		await runHostedWorkbenchSmokeCommand(
			hostedPage,
			hostedPage,
			hostedWorkbenchSmokeCommands.unloadCurrent,
			getRemainingTimeout(deadline)
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'hosted unload Bravo',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(
				lifecycleExpectations,
				'hosted unload Bravo'
			)
		);

		shellPage = getShellPage(runtime);
		await clickWorkbenchRow(
			shellPage,
			'Bravo',
			deadline,
			'restore Bravo after hosted unload'
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'restore Bravo after hosted unload',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(
				lifecycleExpectations,
				'restore Bravo after hosted unload'
			)
		);
		const commandRestoredBravo = getWorkbenchTarget(runtime, bravoPath);
		assertNewInstance(
			'hosted unload and restore Bravo',
			firstBravo,
			commandRestoredBravo
		);

		shellPage = getShellPage(runtime);
		await suspendWorkbenchThroughSmokeDriver(
			shellPage,
			commandRestoredBravo.hostedInstanceId,
			deadline
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'suspend Bravo',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(lifecycleExpectations, 'suspend Bravo')
		);

		shellPage = getShellPage(runtime);
		await clickWorkbenchRow(
			shellPage,
			'Bravo',
			deadline,
			'restore Bravo'
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'restore Bravo',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(lifecycleExpectations, 'restore Bravo')
		);
		const restoredBravo = getWorkbenchTarget(runtime, bravoPath);
		assertNewInstance(
			'suspend and restore Bravo',
			commandRestoredBravo,
			restoredBravo
		);

		const bravoPage = getTargetPage(runtime, restoredBravo);
		await crashLinuxOmniPage(bravoPage, deadline);
		crashedPages.add(bravoPage);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'crash Bravo',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(lifecycleExpectations, 'crash Bravo')
		);

		shellPage = getShellPage(runtime);
		await clickWorkbenchRow(
			shellPage,
			'Bravo',
			deadline,
			'recover Bravo'
		);
		runtime = await waitForLinuxOmniPhase(
			launch,
			deadline,
			'recover Bravo',
			expectedPaths,
			crashedPages,
			getLifecycleExpectation(lifecycleExpectations, 'recover Bravo')
		);
		const recoveredBravo = getWorkbenchTarget(runtime, bravoPath);
		assertNewInstance('crash recovery for Bravo', restoredBravo, recoveredBravo);

		const quitPage = getTargetPage(runtime, recoveredBravo);
		await quitLinuxOmniThroughKeyboard(
			launch,
			quitPage,
			deadline,
			'hosted Bravo target'
		);
		await launch.browser.close().catch(() => undefined);
		launch = undefined;

		launch = await launchLinuxOmni(
			executablePath,
			userDataDir,
			extensionsDir,
			deadline,
			'relaunch restore',
			appendOutput
		);
		captureLinuxPageDiagnostics(
			launch.browser,
			attachedPages,
			pageErrors,
			consoleErrors
		);
		await waitForLinuxOmniPhase(
			launch,
			deadline,
			'relaunch restore',
			expectedPaths,
			new Set<Page>(),
			getLifecycleExpectation(lifecycleExpectations, 'relaunch restore')
		);

		return summarizeLinuxOmniRenderers(getRendererUrls(launch.browser));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const inventory = launch
			? await formatLinuxBrowserInventory(launch.browser)
			: '<application not running>';
		const screenshot = launch
			? await captureLinuxSmokeScreenshot(launch.browser).catch(
				screenshotError =>
					`<screenshot failed: ${formatError(screenshotError)}>`
			)
			: '<application not running>';
		throw new Error(
			[
				detail,
				formatCappedDiagnostics('Browser page errors', pageErrors),
				formatCappedDiagnostics('Browser console errors', consoleErrors),
				`Target inventory:\n${inventory}`,
				`Screenshot: ${screenshot}`,
				`Packaged application output (last ${maximumLogLength} bytes):\n` +
					(output || '<none>'),
			].join('\n\n')
		);
	} finally {
		await launch?.browser.close().catch(() => undefined);
		if (launch) {
			await terminateProcessGroup(launch.child);
		}
		await fs.rm(temporaryRoot, { recursive: true, force: true });
	}
}

/**
 * Resolves a packaged app directory or executable and verifies executability.
 */
export async function resolveLinuxOmniExecutable(
	inputPath: string
): Promise<string> {
	const resolvedPath = path.resolve(inputPath);
	const stat = await fs.stat(resolvedPath);
	const executablePath = stat.isDirectory()
		? path.join(resolvedPath, 'hucode')
		: resolvedPath;
	await fs.access(executablePath, constants.X_OK);
	return executablePath;
}

async function launchLinuxOmni(
	executablePath: string,
	userDataDir: string,
	extensionsDir: string,
	deadline: number,
	phase: 'initial restore' | 'relaunch restore',
	appendOutput: (chunk: Buffer) => void
): Promise<ILinuxOmniLaunch> {
	let connectionError: Error | undefined;
	for (
		let attempt = 1;
		attempt <= maximumLaunchAttempts && Date.now() < deadline;
		attempt++
	) {
		const port = await getAvailablePort();
		const child = spawn(
			executablePath,
			buildLinuxOmniSmokeArguments(userDataDir, extensionsDir, port),
			{
				detached: true,
				env: withoutInheritedElectronEnvironment(process.env),
				stdio: ['ignore', 'pipe', 'pipe'],
			}
		);
		let spawnError: Error | undefined;
		const getSpawnError = () => spawnError;
		child.stdout?.on('data', appendOutput);
		child.stderr?.on('data', appendOutput);
		child.once('error', error => spawnError = error);

		const attemptDeadline = getLinuxOmniLaunchAttemptDeadline(
			deadline,
			Date.now(),
			maximumLaunchAttempts - attempt + 1
		);
		try {
			const browser = await connectToCdp(
				port,
				child,
				attemptDeadline,
				getSpawnError,
				phase
			);
			return { browser, child, getSpawnError };
		} catch (error) {
			connectionError = error instanceof Error
				? error
				: new Error(String(error));
			await terminateProcessGroup(child);
		}
	}

	throw connectionError ?? new Error('Timed out launching Hucode');
}

async function waitForLinuxOmniPhase(
	launch: ILinuxOmniLaunch,
	deadline: number,
	phase: LinuxOmniLifecyclePhase,
	expectedWorktreePaths: readonly string[],
	crashedPages: ReadonlySet<Page>,
	expectation: ILinuxOmniLifecycleExpectation
): Promise<ILinuxOmniRuntimeInventory> {
	let lastError: Error | undefined;
	while (Date.now() < deadline) {
		ensureChildIsRunning(
			launch.child,
			launch.getSpawnError(),
			phase
		);
		try {
			const runtime = await readLinuxOmniRuntimeInventory(
				launch.browser,
				expectedWorktreePaths,
				crashedPages,
				deadline,
				phase
			);
			const shellPage = getShellPage(runtime);
			const rows = await readWorkbenchRows(
				shellPage,
				deadline,
				phase
			);
			const shellResponsive = await runLinuxOmniBoundedProbe(
				deadline,
				`${phase} shell responsiveness probe`,
				() => shellPage.evaluate(() => {
					const targetGlobal = globalThis as unknown as {
						readonly document?: {
							readonly readyState?: string;
							readonly body?: unknown;
						};
					};
					return (
						targetGlobal.document?.readyState === 'complete' &&
						!!targetGlobal.document.body
					);
				})
			);
			assertLinuxOmniLifecycleObservation(
				phase,
				{
					rows,
					targetPaths: runtime.inventory.workbenches.map(
						target => target.worktreePath
					),
					shellResponsive,
					crashedRendererCount:
						runtime.inventory.crashedRendererUrls.length,
				},
				expectation
			);
			return runtime;
		} catch (error) {
			lastError = error instanceof Error
				? error
				: new Error(String(error));
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				break;
			}
			await delay(Math.min(pollIntervalMs, remaining));
		}
	}

	throw new Error(
		`Timed out during ${phase}: ${lastError?.message ?? 'no observation'}`
	);
}

async function readLinuxOmniRuntimeInventory(
	browser: Browser,
	expectedWorktreePaths: readonly string[],
	crashedPages: ReadonlySet<Page>,
	deadline: number,
	phase: LinuxOmniLifecyclePhase
): Promise<ILinuxOmniRuntimeInventory> {
	const pagesByTargetId = new Map<string, Page>();
	const candidates: ILinuxOmniTargetCandidate[] = [];
	let targetIndex = 0;

	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			const targetId = String(targetIndex++);
			pagesByTargetId.set(targetId, page);
			if (crashedPages.has(page)) {
				candidates.push({
					targetId,
					url: page.url(),
					crashed: true,
				});
				continue;
			}

			try {
				const configuration = await runLinuxOmniBoundedProbe(
					deadline,
					`${phase} target configuration probe`,
					() => page.evaluate(async (): Promise<
						ILinuxOmniResolvedConfiguration
					> => {
						const targetWindow = globalThis as unknown as {
							vscode?: {
								context?: {
									resolveConfiguration?: () => Promise<unknown>;
								};
							};
						};
						const resolveConfiguration =
							targetWindow.vscode?.context?.resolveConfiguration;
						if (!resolveConfiguration) {
							throw new Error(
								'window.vscode.context.resolveConfiguration unavailable'
							);
						}
						const value = await resolveConfiguration.call(
							targetWindow.vscode?.context
						) as ILinuxOmniResolvedConfiguration;
						return {
							isOmniWindow: value.isOmniWindow,
							isHostedOmniWorkspace:
								value.isHostedOmniWorkspace,
							hostedInstanceId: value.hostedInstanceId,
							workspace: value.workspace?.uri
								? {
									uri: {
										scheme: value.workspace.uri.scheme,
										path: value.workspace.uri.path,
									},
								}
								: undefined,
						};
					})
				);
				candidates.push({
					targetId,
					url: page.url(),
					configuration,
				});
			} catch (error) {
				candidates.push({
					targetId,
					url: page.url(),
					configurationError: error instanceof Error
						? error.message
						: String(error),
				});
			}
		}
	}

	return {
		inventory: classifyLinuxOmniTargets(
			candidates,
			expectedWorktreePaths
		),
		pagesByTargetId,
	};
}

async function readWorkbenchRows(
	shellPage: Page,
	deadline: number,
	phase: LinuxOmniLifecyclePhase
): Promise<ILinuxOmniWorkbenchRow[]> {
	return runLinuxOmniBoundedProbe(
		deadline,
		`${phase} Projects row probe`,
		async () => await readOmniWorkbenchSmokeRows(
			shellPage,
			workbenchLabels
		) as ILinuxOmniWorkbenchRow[]
	);
}

async function clickWorkbenchRow(
	shellPage: Page,
	label: LinuxOmniWorkbenchLabel,
	deadline: number,
	phase: LinuxOmniLifecyclePhase
): Promise<void> {
	const row = await getUniqueWorkbenchRow(
		shellPage,
		label,
		deadline,
		phase
	);
	await runLinuxOmniBoundedProbe(
		deadline,
		`${phase} ${label} row click`,
		() => row.click({ timeout: getRemainingTimeout(deadline) })
	);
}

async function suspendWorkbenchThroughSmokeDriver(
	shellPage: Page,
	instanceId: string,
	deadline: number
): Promise<void> {
	await runLinuxOmniBoundedProbe(
		deadline,
		'suspend Bravo smoke-driver call',
		() => shellPage.evaluate(async hostedInstanceId => {
			const targetGlobal = globalThis as unknown as {
				readonly __hucodeOmniSmokeTestDriver?: {
					suspendWorkspace(id: string): Promise<void>;
				};
			};
			const driver = targetGlobal.__hucodeOmniSmokeTestDriver;
			if (!driver) {
				throw new Error(
					'Omni smoke-test suspend driver is unavailable'
				);
			}
			await driver.suspendWorkspace(hostedInstanceId);
		}, instanceId)
	);
}

async function getUniqueWorkbenchRow(
	shellPage: Page,
	label: LinuxOmniWorkbenchLabel,
	deadline: number,
	phase: LinuxOmniLifecyclePhase
) {
	const exactLabel = shellPage.locator(
		'.hucode-project-switcher-workbench ' +
			'.hucode-project-switcher-label'
	).filter({
		hasText: new RegExp(`^${escapeRegExp(label)}$`),
	});
	const row = shellPage.locator(
		'.monaco-list-row:has(.hucode-project-switcher-workbench)'
	).filter({ has: exactLabel });
	const count = await runLinuxOmniBoundedProbe(
		deadline,
		`${phase} ${label} row lookup`,
		() => row.count()
	);
	if (count !== 1) {
		throw new Error(
			`Expected exactly one ${label} workbench row, observed ` +
				`${count}`
		);
	}
	return row;
}

function getShellPage(runtime: ILinuxOmniRuntimeInventory): Page {
	const targetId = runtime.inventory.shellTargetId;
	const page = targetId === undefined
		? undefined
		: runtime.pagesByTargetId.get(targetId);
	if (!page) {
		throw new Error(
			'Classified Omni shell target has no matching Playwright page'
		);
	}
	return page;
}

function getWorkbenchTarget(
	runtime: ILinuxOmniRuntimeInventory,
	worktreePath: string
): ILinuxOmniWorkbenchTarget {
	const normalizedPath = normalizeSmokePath(worktreePath);
	const matching = runtime.inventory.workbenches.filter(
		target => target.worktreePath === normalizedPath
	);
	if (matching.length !== 1) {
		throw new Error(
			`Expected one hosted target for ${normalizedPath}, observed ` +
				`${matching.length}: ${JSON.stringify(matching)}`
		);
	}
	return matching[0];
}

function getTargetPage(
	runtime: ILinuxOmniRuntimeInventory,
	target: ILinuxOmniWorkbenchTarget
): Page {
	const page = target.targetId === undefined
		? undefined
		: runtime.pagesByTargetId.get(target.targetId);
	if (!page) {
		throw new Error(
			`Hosted target ${target.hostedInstanceId} has no Playwright page`
		);
	}
	return page;
}

function assertSameInstance(
	label: LinuxOmniWorkbenchLabel,
	before: ILinuxOmniWorkbenchTarget,
	after: ILinuxOmniWorkbenchTarget
): void {
	if (before.hostedInstanceId !== after.hostedInstanceId) {
		throw new Error(
			`${label} was recreated while switching: ` +
				`${before.hostedInstanceId} -> ${after.hostedInstanceId}`
		);
	}
}

function assertNewInstance(
	operation: string,
	before: ILinuxOmniWorkbenchTarget,
	after: ILinuxOmniWorkbenchTarget
): void {
	if (before.hostedInstanceId === after.hostedInstanceId) {
		throw new Error(
			`${operation} reused hosted instance ${after.hostedInstanceId}`
		);
	}
}

export async function crashLinuxOmniPage(
	page: Page,
	deadline: number
): Promise<void> {
	const crashEvent = new Promise<void>(resolve => {
		page.once('crash', () => resolve());
	});
	const session = await runLinuxOmniBoundedProbe(
		deadline,
		'Bravo crash CDP session creation',
		() => getPageContext(page).newCDPSession(page)
	);
	void session.send('Page.crash').catch(() => undefined);
	await waitForPromise(
		crashEvent,
		deadline,
		'Timed out waiting for the Bravo renderer crash event'
	);
}

async function quitLinuxOmniThroughKeyboard(
	launch: ILinuxOmniLaunch,
	page: Page,
	deadline: number,
	focusedTarget: string
): Promise<void> {
	const exit = new Promise<{
		readonly code: number | null;
		readonly signal: NodeJS.Signals | null;
	}>(resolve => {
		if (
			launch.child.exitCode !== null ||
			launch.child.signalCode !== null
		) {
			resolve({
				code: launch.child.exitCode,
				signal: launch.child.signalCode,
			});
			return;
		}
		launch.child.once('exit', (code, signal) => resolve({ code, signal }));
	});

	await page.keyboard.press('Control+Q');
	const result = await waitForPromise(
		exit,
		deadline,
		`Timed out waiting for Ctrl+Q from ${focusedTarget} to exit Hucode`
	);
	if (result.code !== 0 || result.signal !== null) {
		throw new Error(
			`${formatLinuxOmniUnexpectedExit(
				'quit',
				result.code,
				result.signal
			)} after Ctrl+Q from ${focusedTarget}`
		);
	}
}

function getPageContext(page: Page): BrowserContext {
	return page.context();
}

/**
 * Bounds one renderer or locator probe by the lifecycle's remaining deadline.
 */
export function runLinuxOmniBoundedProbe<T>(
	deadline: number,
	description: string,
	probe: () => Promise<T>
): Promise<T> {
	if (deadline <= Date.now()) {
		return Promise.reject(
			new Error(`Timed out during ${description}`)
		);
	}
	return waitForPromise(
		Promise.resolve().then(probe),
		deadline,
		`Timed out during ${description}`
	);
}

async function waitForPromise<T>(
	promise: Promise<T>,
	deadline: number,
	timeoutMessage: string
): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		throw new Error(timeoutMessage);
	}

	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error(timeoutMessage)),
					remaining
				);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

function getRemainingTimeout(deadline: number): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		throw new Error('The packaged Omni lifecycle deadline expired');
	}
	return remaining;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSmokePath(value: string): string {
	try {
		return path.normalize(decodeURIComponent(value));
	} catch {
		return path.normalize(value);
	}
}

function getLifecycleExpectation(
	expectations: Readonly<Partial<Record<
		LinuxOmniLifecyclePhase,
		ILinuxOmniLifecycleExpectation
	>>>,
	phase: LinuxOmniLifecyclePhase
): ILinuxOmniLifecycleExpectation {
	const expectation = expectations[phase];
	if (!expectation) {
		throw new Error(`Missing lifecycle expectation for ${phase}`);
	}
	return expectation;
}

function withoutInheritedElectronEnvironment(
	environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
	const result = { ...environment };
	delete result.ELECTRON_RUN_AS_NODE;
	for (const key of Object.keys(result)) {
		if (key.startsWith('VSCODE_')) {
			delete result[key];
		}
	}
	return result;
}

async function getAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('Failed to allocate a CDP port'));
				return;
			}
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

async function connectToCdp(
	port: number,
	child: ChildProcess,
	deadline: number,
	getSpawnError: () => Error | undefined,
	phase: 'initial restore' | 'relaunch restore'
): Promise<Browser> {
	let lastError: Error | undefined;
	while (Date.now() < deadline) {
		ensureChildIsRunning(child, getSpawnError(), phase);
		try {
			return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
				timeout: Math.max(
					1,
					Math.min(1_000, deadline - Date.now())
				)
			});
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				break;
			}
			await delay(Math.min(pollIntervalMs, remaining));
		}
	}

	throw new Error(`Timed out connecting to CDP: ${lastError?.message}`);
}

function captureLinuxPageDiagnostics(
	browser: Browser,
	attachedPages: WeakSet<Page>,
	pageErrors: string[],
	consoleErrors: string[]
): void {
	const attach = (page: Page): void => {
		if (attachedPages.has(page)) {
			return;
		}
		attachedPages.add(page);
		page.on('pageerror', error => {
			pageErrors.push(`${page.url()}: ${error.stack ?? error.message}`);
		});
		page.on('console', message => {
			if (message.type() === 'error') {
				consoleErrors.push(`${page.url()}: ${message.text()}`);
			}
		});
	};
	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			attach(page);
		}
		context.on('page', attach);
	}
}

async function formatLinuxBrowserInventory(browser: Browser): Promise<string> {
	return JSON.stringify(browser.contexts().map((context, contextIndex) => ({
		contextIndex,
		pages: context.pages().map((page, pageIndex) => ({
			pageIndex,
			url: page.url(),
			closed: page.isClosed(),
		})),
	})), undefined, 2);
}

async function captureLinuxSmokeScreenshot(browser: Browser): Promise<string> {
	const pages = browser.contexts().flatMap(context => context.pages());
	const page = pages.find(candidate => candidate.url().includes(
		'/vs/hucode/electron-browser/omni.html'
	)) ?? pages[0];
	if (!page) {
		throw new Error('No renderer page was available for a screenshot');
	}
	await fs.mkdir(smokeArtifactRoot, { recursive: true });
	const screenshotPath = path.join(
		smokeArtifactRoot,
		'linux-desktop-hosted-command-smoke.png'
	);
	await page.screenshot({ path: screenshotPath, fullPage: true });
	return screenshotPath;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

function formatCappedDiagnostics(
	label: string,
	messages: readonly string[]
): string {
	const detail = messages.join('\n').slice(-maximumLogLength) || '<none>';
	return `${label} (last ${maximumLogLength} characters):\n${detail}`;
}

function getRendererUrls(browser: Browser): string[] {
	return browser.contexts().flatMap(context =>
		context.pages().map(page => page.url())
	);
}

function ensureChildIsRunning(
	child: ChildProcess,
	spawnError: Error | undefined,
	phase: LinuxOmniLifecyclePhase
): void {
	if (spawnError) {
		throw new Error(
			`Failed to launch packaged application: ${spawnError.message}`
		);
	}
	if (child.exitCode !== null || child.signalCode !== null) {
		throw new Error(
			formatLinuxOmniUnexpectedExit(
				phase,
				child.exitCode,
				child.signalCode
			)
		);
	}
}

async function terminateProcessGroup(child: ChildProcess): Promise<void> {
	if (child.pid) {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			child.kill('SIGTERM');
		}
	}

	if (child.exitCode === null && child.signalCode === null) {
		await Promise.race([
			new Promise<void>(resolve => child.once('exit', () => resolve())),
			delay(3_000),
		]);
	}

	if (child.exitCode === null && child.signalCode === null && child.pid) {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {
			child.kill('SIGKILL');
		}
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	runLinuxOmniSmoke(parseLinuxOmniSmokeOptions(process.argv.slice(2))).then(
		summary => {
			console.log(
				'Packaged Linux Omni lifecycle smoke passed: ' +
				JSON.stringify(summary)
			);
		},
		error => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		}
	);
}
