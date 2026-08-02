/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { createServer } from 'net';
import os from 'os';
import path from 'path';
import { chromium, type Browser, type Page, type Response } from '@playwright/test';
import { fileURLToPath } from 'url';

const timeoutMs = 90_000;
const pollIntervalMs = 100;
const maximumLogLength = 64 * 1024;
const omniWorkbenchSelector = '.monaco-workbench.hucode-omni-workbench';
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..'
);

interface IServerLaunch {
	readonly child: ChildProcess;
	readonly url: string;
	readonly getOutput: () => string;
	readonly getSpawnError: () => Error | undefined;
}

interface IMixinTargetSnapshot {
	readonly targetPath: string;
	readonly contents: Buffer | undefined;
}

/** Runs a browser smoke test for the server-authoritative user-data Omni shell. */
export async function runWebServerUserDataSmoke(): Promise<void> {
	const mixinSnapshot = await snapshotMixinTargets();
	const temporaryRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), 'hucode-web-server-user-data-smoke-')
	);
	const serverDataDir = path.join(temporaryRoot, 'server-data');
	let launch: IServerLaunch | undefined;
	let browser: Browser | undefined;
	let failure: Error | undefined;
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];

	try {
		const port = await getAvailablePort();
		launch = launchServer(serverDataDir, port);
		const deadline = Date.now() + timeoutMs;
		await waitForServer(launch, deadline);

		browser = await chromium.launch({
			executablePath: chromium.executablePath(),
			headless: true,
		});
		const page = await browser.newPage();
		page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
		page.on('console', message => {
			if (message.type() === 'error') {
				consoleErrors.push(message.text());
			}
		});
		const bootstrapResponse = observeServerUserDataBootstrap(page, deadline);
		const readiness = Promise.all([
			bootstrapResponse,
			page.waitForSelector(omniWorkbenchSelector, {
				state: 'visible',
				timeout: remainingTime(deadline),
			}),
		]);
		void readiness.catch(() => undefined);

		await page.goto(launch.url, {
			waitUntil: 'domcontentloaded',
			timeout: remainingTime(deadline),
		});
		const [bootstrap] = await readiness;

		console.log(
			`Hucode server user-data Omni smoke passed: observed GET ` +
			`${bootstrap.pathname} (${bootstrap.status}); rendered ${omniWorkbenchSelector}`
		);
	} catch (error) {
		failure = new Error([
			`Hucode server user-data Omni smoke failed: ${formatError(error)}`,
			formatDiagnostics('Browser page errors', pageErrors),
			formatDiagnostics('Browser console errors', consoleErrors),
			`Server output (last ${maximumLogLength} bytes):\n${launch?.getOutput() || '<none>'}`,
		].join('\n\n'));
	} finally {
		const cleanupErrors: unknown[] = [];
		if (browser) {
			try {
				await browser.close();
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (launch) {
			try {
				await terminateProcessGroup(launch.child);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		try {
			await waitForMixinRestore(mixinSnapshot);
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await fs.rm(temporaryRoot, { recursive: true, force: true });
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (cleanupErrors.length) {
			const cleanupDetail = cleanupErrors.map(formatError).join('\n');
			failure = failure
				? new AggregateError(
					[failure, ...cleanupErrors],
					`${failure.message}\n\nCleanup failures:\n${cleanupDetail}`
				)
				: new AggregateError(
					cleanupErrors,
					`Hucode server user-data Omni smoke cleanup failed:\n${cleanupDetail}`
				);
		}
	}
	if (failure) {
		throw failure;
	}
}

function launchServer(serverDataDir: string, port: number): IServerLaunch {
	let output = '';
	let spawnError: Error | undefined;
	const appendOutput = (chunk: Buffer): void => {
		output = (output + chunk.toString()).slice(-maximumLogLength);
	};
	const child = spawn(
		process.platform === 'win32' ? 'npm.cmd' : 'npm',
		[
			'run',
			'hucode:web',
			'--',
			'--hucode-web-user-data-storage=server',
			`--server-data-dir=${serverDataDir}`,
			'--host=127.0.0.1',
			`--port=${port}`,
		],
		{
			cwd: repoRoot,
			detached: process.platform !== 'win32',
			env: withoutInheritedWorkbenchEnvironment(process.env),
			shell: process.platform === 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		}
	);
	child.stdout?.on('data', appendOutput);
	child.stderr?.on('data', appendOutput);
	child.once('error', error => {
		spawnError = error;
		appendOutput(Buffer.from(`\nSpawn error: ${error.stack ?? error.message}\n`));
	});

	return {
		child,
		url: `http://127.0.0.1:${port}/`,
		getOutput: () => output,
		getSpawnError: () => spawnError,
	};
}

async function waitForServer(launch: IServerLaunch, deadline: number): Promise<void> {
	let lastError: unknown;
	while (Date.now() < deadline) {
		const spawnError = launch.getSpawnError();
		if (spawnError) {
			throw new Error(`Unable to start serve-web: ${spawnError.message}`);
		}
		if (launch.child.exitCode !== null || launch.child.signalCode !== null) {
			throw new Error(
				`Serve-web exited before accepting requests ` +
				`(code=${launch.child.exitCode}, signal=${launch.child.signalCode})`
			);
		}
		try {
			const response = await fetch(launch.url, {
				redirect: 'manual',
				signal: AbortSignal.timeout(remainingTime(deadline)),
			});
			await response.body?.cancel();
			return;
		} catch (error) {
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for serve-web response from ${launch.url}`);
			}
			lastError = error;
		}
		await delay(pollIntervalMs);
	}

	const detail = lastError === undefined
		? 'no response attempt completed before the deadline'
		: lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Timed out waiting for serve-web from ${launch.url}: ${detail}`);
}

async function snapshotMixinTargets(): Promise<readonly IMixinTargetSnapshot[]> {
	const mixinRoot = path.join(repoRoot, '.build', 'distro', 'mixin', 'stable');
	let relativePaths: readonly string[];
	try {
		relativePaths = await listFiles(mixinRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(
				'Hucode stable mixin is missing; run `npm run hucode:prepare` first.'
			);
		}
		throw error;
	}
	return Promise.all(relativePaths.map(async relativePath => {
		const targetPath = path.join(repoRoot, relativePath);
		return {
			targetPath,
			contents: await readFileIfPresent(targetPath),
		};
	}));
}

async function observeServerUserDataBootstrap(
	page: Page,
	deadline: number
): Promise<{ readonly pathname: string; readonly status: number }> {
	const response = await page.waitForResponse(
		(response: Response): boolean => {
			const request = response.request();
			const url = new URL(response.url());
			return request.method() === 'GET' &&
				url.pathname === '/_hucode/user-data/bootstrap' &&
				response.ok();
		},
		{ timeout: remainingTime(deadline) }
	);
	return {
		pathname: new URL(response.url()).pathname,
		status: response.status(),
	};
}

async function listFiles(root: string): Promise<readonly string[]> {
	const result: string[] = [];

	async function walk(directory: string): Promise<void> {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(entryPath);
			} else {
				result.push(path.relative(root, entryPath));
			}
		}
	}

	await walk(root);
	return result;
}

async function readFileIfPresent(filePath: string): Promise<Buffer | undefined> {
	try {
		return await fs.readFile(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

async function waitForMixinRestore(
	snapshot: readonly IMixinTargetSnapshot[]
): Promise<void> {
	const deadline = Date.now() + 10_000;
	let changedTargets: string[] = [];
	while (Date.now() < deadline) {
		changedTargets = [];
		for (const target of snapshot) {
			const contents = await readFileIfPresent(target.targetPath);
			if (
				(contents === undefined) !== (target.contents === undefined) ||
				(contents && target.contents && !contents.equals(target.contents))
			) {
				changedTargets.push(path.relative(repoRoot, target.targetPath));
			}
		}
		if (!changedTargets.length) {
			return;
		}
		await delay(pollIntervalMs);
	}
	throw new Error(
		`Serve-web mixin wrapper did not restore: ${changedTargets.join(', ')}`
	);
}

async function getAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('Failed to allocate a serve-web port'));
				return;
			}
			server.close(error => error ? reject(error) : resolve(address.port));
		});
	});
}

function remainingTime(deadline: number): number {
	return Math.max(1, deadline - Date.now());
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function formatDiagnostics(label: string, messages: readonly string[]): string {
	return `${label}:\n${messages.length ? messages.join('\n') : '<none>'}`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

function withoutInheritedWorkbenchEnvironment(
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

async function terminateProcessGroup(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}

	signalProcessGroup(child, 'SIGTERM');
	if (await waitForExit(child, 10_000)) {
		return;
	}
	signalProcessGroup(child, 'SIGKILL');
	await waitForExit(child, 5_000);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) {
		return;
	}
	try {
		if (process.platform === 'win32') {
			child.kill(signal);
		} else {
			process.kill(-child.pid, signal);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
			throw error;
		}
	}
}

async function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return true;
	}
	return new Promise<boolean>(resolve => {
		let settled = false;
		function finish(result: boolean): void {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			child.off('exit', onExit);
			resolve(result);
		}
		const onExit = (): void => finish(true);
		const timer = setTimeout(() => finish(false), timeout);
		child.once('exit', onExit);
		if (child.exitCode !== null || child.signalCode !== null) {
			finish(true);
		}
	});
}

async function isMainModule(): Promise<boolean> {
	if (!process.argv[1]) {
		return false;
	}
	const entrypoint = fileURLToPath(import.meta.url);
	const [invokedPath, entrypointPath] = await Promise.all([
		fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1])),
		fs.realpath(entrypoint),
	]);
	return invokedPath === entrypointPath;
}

if (await isMainModule()) {
	await runWebServerUserDataSmoke();
}
