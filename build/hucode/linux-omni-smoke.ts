/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type Browser, chromium } from 'playwright-core';
import { spawn, type ChildProcess } from 'child_process';
import { constants, promises as fs } from 'fs';
import { createServer } from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const defaultTimeoutMs = 45_000;
const maximumLaunchAttempts = 3;
const maximumLogLength = 64 * 1024;
const stabilizationDelayMs = 1_500;

/**
 * Parsed command-line options for the packaged Linux Omni startup smoke test.
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
 * Parses the packaged Linux Omni startup smoke command line.
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
 * Builds arguments for an isolated packaged Hucode startup with CDP enabled.
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
	];
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
 * Bounds renderer stabilization by the caller's remaining timeout.
 */
export function getLinuxOmniStabilizationDelay(
	deadline: number,
	now: number
): number {
	return Math.min(stabilizationDelayMs, Math.max(0, deadline - now));
}

/**
 * Runs the clean-profile startup assertion against a packaged Linux build.
 */
export async function runLinuxOmniSmoke(
	options: ILinuxOmniSmokeOptions
): Promise<ILinuxOmniRendererSummary> {
	if (process.platform !== 'linux') {
		throw new Error('The packaged Omni startup smoke test requires Linux');
	}

	const executablePath = await resolveLinuxExecutable(options.executablePath);
	const temporaryRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), 'hucode-linux-omni-smoke-')
	);
	const userDataDir = path.join(temporaryRoot, 'user-data');
	const extensionsDir = path.join(temporaryRoot, 'extensions');
	await Promise.all([
		fs.mkdir(userDataDir, { recursive: true }),
		fs.mkdir(extensionsDir, { recursive: true }),
	]);

	let child: ChildProcess | undefined;
	let browser: Browser | undefined;
	let output = '';
	const appendOutput = (chunk: Buffer): void => {
		output = (output + chunk.toString()).slice(-maximumLogLength);
	};

	try {
		const deadline = Date.now() + options.timeoutMs;
		let getSpawnError: () => Error | undefined = () => undefined;
		let connectionError: Error | undefined;
		for (
			let attempt = 1;
			attempt <= maximumLaunchAttempts && Date.now() < deadline;
			attempt++
		) {
			const port = await getAvailablePort();
			child = spawn(
				executablePath,
				buildLinuxOmniSmokeArguments(userDataDir, extensionsDir, port),
				{
					detached: true,
					env: withoutInheritedElectronEnvironment(process.env),
					stdio: ['ignore', 'pipe', 'pipe'],
				}
			);
			let spawnError: Error | undefined;
			getSpawnError = () => spawnError;
			child.stdout?.on('data', appendOutput);
			child.stderr?.on('data', appendOutput);
			child.once('error', error => spawnError = error);

			const attemptDeadline = getLinuxOmniLaunchAttemptDeadline(
				deadline,
				Date.now(),
				maximumLaunchAttempts - attempt + 1
			);
			try {
				browser = await connectToCdp(
					port,
					child,
					attemptDeadline,
					getSpawnError
				);
				break;
			} catch (error) {
				connectionError = error instanceof Error
					? error
					: new Error(String(error));
				await terminateProcessGroup(child);
				child = undefined;
			}
		}

		if (!browser || !child) {
			throw connectionError ?? new Error('Timed out launching Hucode');
		}

		await waitForOmniRenderer(browser, child, deadline, getSpawnError);

		// A late fallback is the regression this smoke test is intended to catch.
		await delay(getLinuxOmniStabilizationDelay(deadline, Date.now()));
		const summary = summarizeLinuxOmniRenderers(getRendererUrls(browser));
		if (
			summary.applicationRendererCount !== 1 ||
			summary.omniRendererCount !== 1
		) {
			throw new Error(
				'Expected exactly one Hucode application renderer and one Omni ' +
				`renderer, observed ${JSON.stringify(summary)}`
			);
		}

		return summary;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${detail}\nPackaged application output:\n${output || '<none>'}`
		);
	} finally {
		await browser?.close().catch(() => undefined);
		if (child) {
			await terminateProcessGroup(child);
		}
		await fs.rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function resolveLinuxExecutable(inputPath: string): Promise<string> {
	const resolvedPath = path.resolve(inputPath);
	const stat = await fs.stat(resolvedPath);
	const executablePath = stat.isDirectory()
		? path.join(resolvedPath, 'hucode')
		: resolvedPath;
	await fs.access(executablePath, constants.X_OK);
	return executablePath;
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
	getSpawnError: () => Error | undefined
): Promise<Browser> {
	let lastError: Error | undefined;
	while (Date.now() < deadline) {
		ensureChildIsRunning(child, getSpawnError());
		try {
			return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
				timeout: Math.max(
					1,
					Math.min(1_000, deadline - Date.now())
				)
			});
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			await delay(100);
		}
	}

	throw new Error(`Timed out connecting to CDP: ${lastError?.message}`);
}

async function waitForOmniRenderer(
	browser: Browser,
	child: ChildProcess,
	deadline: number,
	getSpawnError: () => Error | undefined
): Promise<void> {
	while (Date.now() < deadline) {
		ensureChildIsRunning(child, getSpawnError());
		const summary = summarizeLinuxOmniRenderers(getRendererUrls(browser));
		if (summary.omniRendererCount > 0) {
			return;
		}
		await delay(100);
	}

	throw new Error(
		'Timed out waiting for an Omni renderer; observed ' +
		JSON.stringify(getRendererUrls(browser))
	);
}

function getRendererUrls(browser: Browser): string[] {
	return browser.contexts().flatMap(context =>
		context.pages().map(page => page.url())
	);
}

function ensureChildIsRunning(
	child: ChildProcess,
	spawnError: Error | undefined
): void {
	if (spawnError) {
		throw new Error(
			`Failed to launch packaged application: ${spawnError.message}`
		);
	}
	if (child.exitCode !== null || child.signalCode !== null) {
		throw new Error(
			'Packaged application exited before the Omni renderer was ready ' +
			`(code=${child.exitCode}, signal=${child.signalCode})`
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
				'Packaged Linux Omni startup smoke passed: ' +
				JSON.stringify(summary)
			);
		},
		error => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		}
	);
}
