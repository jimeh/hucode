/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { createServer } from 'net';
import os from 'os';
import path from 'path';
import {
	chromium,
	type Browser,
	type Frame,
	type Page,
	type Response,
} from '@playwright/test';
import { fileURLToPath } from 'url';
import {
	assertHostedWorkbenchSmokeCommandVisible,
	hostedWorkbenchSmokeCommands,
	readOmniWorkbenchSmokeRows,
	runHostedWorkbenchClipboardBridgeSmoke,
	runHostedWorkbenchSmokeCommand,
	waitForHostedWorkbenchSmokeSurfaceFocus,
	waitForOmniProjectsSmokeSurfaceFocus,
	waitForOmniProjectsSidebarVisibility,
} from './omni-hosted-command-smoke.ts';

const timeoutMs = 180_000;
const pollIntervalMs = 100;
const maximumLogLength = 64 * 1024;
const omniWorkbenchSelector = '.monaco-workbench.hucode-omni-workbench';
const smokeArtifactRoot = path.join(
	'.build',
	'hucode-smoke-artifacts'
);
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
	const alphaPath = path.join(temporaryRoot, 'Alpha');
	const bravoPath = path.join(temporaryRoot, 'Bravo');
	const bridgeFileName = 'omni-bridge-smoke.txt';
	let launch: IServerLaunch | undefined;
	let browser: Browser | undefined;
	let page: Page | undefined;
	let failure: Error | undefined;
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	const projectEventStreamUrls = new Set<string>();
	let targetInventory = '<not collected>';
	let screenshotPath: string | undefined;

	try {
		await Promise.all([
			fs.mkdir(alphaPath, { recursive: true }),
			fs.mkdir(bravoPath, { recursive: true }),
		]);
		await fs.writeFile(
			path.join(alphaPath, bridgeFileName),
			'omni bridge smoke fixture'
		);
		const port = await getAvailablePort();
		launch = launchServer(serverDataDir, port);
		const deadline = Date.now() + timeoutMs;
		await waitForServer(launch, deadline);

		browser = await chromium.launch({
			executablePath: chromium.executablePath(),
			headless: true,
		});
		page = await browser.newPage();
		await page.context().grantPermissions(
			['clipboard-read', 'clipboard-write'],
			{ origin: new URL(launch.url).origin }
		);
		page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
		page.on('console', message => {
			if (message.type() === 'error') {
				consoleErrors.push(message.text());
			}
		});
		page.on('request', request => {
			const url = new URL(request.url());
			if (request.method() === 'GET' &&
				getVersionedHucodeEndpointPath(url.pathname)?.startsWith(
					'/_hucode/projects/events/'
				)) {
				projectEventStreamUrls.add(url.href);
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
		await waitForWebSmokeTestDriver(page, deadline);
		await openWorkspaceThroughSmokeDriver(page, alphaPath, deadline);
		await waitForWebWorkbenchState(page, deadline, [
			{ label: 'Alpha', state: 'active', active: true },
		]);
		await openWorkspaceThroughSmokeDriver(page, bravoPath, deadline);
		await waitForWebWorkbenchState(page, deadline, [
			{ label: 'Alpha', state: 'loaded', active: false },
			{ label: 'Bravo', state: 'active', active: true },
		]);

		let hostedFrame = await waitForHostedFrame(page, bravoPath, deadline);
		await runHostedWorkbenchSmokeCommand(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.switchWorkbench,
			commandTimeout(deadline),
			'Alpha'
		);
		await waitForWebWorkbenchState(page, deadline, [
			{ label: 'Alpha', state: 'active', active: true },
			{ label: 'Bravo', state: 'loaded', active: false },
		]);
		hostedFrame = await waitForHostedFrame(page, alphaPath, deadline);
		await assertHostedWorkbenchSmokeCommandVisible(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.webHostedFocusWorkbench,
			commandTimeout(deadline)
		);
		await runHostedWorkbenchSmokeCommand(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.webHostedFocusProjects,
			commandTimeout(deadline)
		);
		await waitForOmniProjectsSmokeSurfaceFocus(
			page,
			commandTimeout(deadline)
		);
		await focusWorkspaceThroughSmokeDriver(page, deadline);
		await waitForHostedWorkbenchSmokeSurfaceFocus(
			hostedFrame,
			commandTimeout(deadline)
		);
		await runHostedWorkbenchClipboardBridgeSmoke({
			keyboardPage: page,
			shellPage: page,
			surface: hostedFrame,
			fileName: bridgeFileName,
			timeoutMs: commandTimeout(deadline),
			readClipboardText: () => page!.evaluate(() => (
				globalThis as unknown as {
					readonly navigator: {
						readonly clipboard: { readText(): Promise<string> };
					};
				}
			).navigator.clipboard.readText()),
			writeClipboardText: text => page!.evaluate(value => (
				globalThis as unknown as {
					readonly navigator: {
						readonly clipboard: {
							writeText(text: string): Promise<void>;
						};
					};
				}
			).navigator.clipboard.writeText(value), text),
			readSavedFileText: () => fs.readFile(
				path.join(alphaPath, bridgeFileName),
				'utf8'
			),
		});
		await runHostedWorkbenchSmokeCommand(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.toggleProjectsSidebar,
			commandTimeout(deadline)
		);
		await waitForOmniProjectsSidebarVisibility(
			page,
			false,
			commandTimeout(deadline)
		);
		await runHostedWorkbenchSmokeCommand(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.toggleProjectsSidebar,
			commandTimeout(deadline)
		);
		await waitForOmniProjectsSidebarVisibility(
			page,
			true,
			commandTimeout(deadline)
		);

		await runHostedWorkbenchSmokeCommand(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.previousLoaded,
			commandTimeout(deadline)
		);
		await waitForWebWorkbenchState(page, deadline, [
			{ label: 'Alpha', state: 'loaded', active: false },
			{ label: 'Bravo', state: 'active', active: true },
		]);

		hostedFrame = await waitForHostedFrame(page, bravoPath, deadline);
		await runHostedWorkbenchSmokeCommand(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.nextLoaded,
			commandTimeout(deadline)
		);
		await waitForWebWorkbenchState(page, deadline, [
			{ label: 'Alpha', state: 'active', active: true },
			{ label: 'Bravo', state: 'loaded', active: false },
		]);

		hostedFrame = await waitForHostedFrame(page, alphaPath, deadline);
		await runHostedWorkbenchSmokeCommand(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.lastActive,
			commandTimeout(deadline)
		);
		await waitForWebWorkbenchState(page, deadline, [
			{ label: 'Alpha', state: 'loaded', active: false },
			{ label: 'Bravo', state: 'active', active: true },
		]);

		hostedFrame = await waitForHostedFrame(page, bravoPath, deadline);
		await runHostedWorkbenchSmokeCommand(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.quickSwitchLoaded,
			commandTimeout(deadline),
			'Alpha'
		);
		await waitForWebWorkbenchState(page, deadline, [
			{ label: 'Alpha', state: 'active', active: true },
			{ label: 'Bravo', state: 'loaded', active: false },
		]);

		hostedFrame = await waitForHostedFrame(page, alphaPath, deadline);
		await assertHostedWorkbenchSmokeCommandVisible(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.unloadCurrent,
			commandTimeout(deadline)
		);
		await runHostedWorkbenchSmokeCommand(
			page,
			hostedFrame,
			hostedWorkbenchSmokeCommands.unloadCurrent,
			commandTimeout(deadline)
		);
		await waitForWebWorkbenchState(page, deadline, [
			{ label: 'Alpha', state: 'unloaded', active: false },
			{ label: 'Bravo', state: 'active', active: true },
		]);

		await openWorkspaceThroughSmokeDriver(page, alphaPath, deadline);
		await waitForWebWorkbenchState(page, deadline, [
			{ label: 'Alpha', state: 'active', active: true },
			{ label: 'Bravo', state: 'loaded', active: false },
		]);
		const beforeReload = await waitForHostedFrame(page, alphaPath, deadline);
		await runHostedWorkbenchSmokeCommand(
			page,
			beforeReload,
			hostedWorkbenchSmokeCommands.reloadWeb,
			commandTimeout(deadline)
		);
		const afterReload = await waitForHostedFrame(
			page,
			alphaPath,
			deadline,
			beforeReload
		);
		await waitForWebWorkbenchState(page, deadline, [
			{ label: 'Alpha', state: 'active', active: true },
			{ label: 'Bravo', state: 'loaded', active: false },
		]);
		await runHostedWorkbenchSmokeCommand(
			page,
			afterReload,
			hostedWorkbenchSmokeCommands.webHostedFocusProjects,
			commandTimeout(deadline)
		);
		await waitForOmniProjectsSmokeSurfaceFocus(
			page,
			commandTimeout(deadline)
		);
		await focusWorkspaceThroughSmokeDriver(page, deadline);
		await waitForHostedWorkbenchSmokeSurfaceFocus(
			afterReload,
			commandTimeout(deadline)
		);
		if (projectEventStreamUrls.size !== 1) {
			throw new Error(
				'Expected one shell-owned project event stream after hosted ' +
				`switching, observed ${projectEventStreamUrls.size}: ` +
				[...projectEventStreamUrls].join(', ')
			);
		}
		targetInventory = await formatWebTargetInventory(page);

		console.log(
			`Hucode server user-data Omni smoke passed: observed GET ` +
			`${bootstrap.pathname} (${bootstrap.status}); exercised hosted ` +
			`navigation, clipboard/focus bridging, one shell-owned project ` +
			`event stream, a shell action, unload, and command-driven ` +
			`connection recovery across Alpha and Bravo`
		);
	} catch (error) {
		if (page) {
			targetInventory = await formatWebTargetInventory(page).catch(
				inventoryError => `<inventory failed: ${formatError(inventoryError)}>`
			);
			screenshotPath = await captureWebSmokeScreenshot(page).catch(
				screenshotError => `<screenshot failed: ${formatError(screenshotError)}>`
			);
		}
		failure = new Error([
			`Hucode server user-data Omni smoke failed: ${formatError(error)}`,
			formatDiagnostics('Browser page errors', pageErrors),
			formatDiagnostics('Browser console errors', consoleErrors),
			`Target inventory:\n${targetInventory}`,
			`Screenshot: ${screenshotPath ?? '<none>'}`,
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
			'--enable-smoke-test-driver',
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
				getVersionedHucodeEndpointPath(url.pathname) ===
				'/_hucode/user-data/bootstrap' &&
				response.ok();
		},
		{ timeout: remainingTime(deadline) }
	);
	return {
		pathname: new URL(response.url()).pathname,
		status: response.status(),
	};
}

/**
 * Returns the document-relative endpoint for a versioned Hucode path, or
 * undefined when the path lacks one product segment or a Hucode endpoint.
 */
function getVersionedHucodeEndpointPath(
	pathname: string
): string | undefined {
	const productSegmentEnd = pathname.indexOf('/', 1);
	if (productSegmentEnd <= 1) {
		return undefined;
	}
	const productSegment = pathname.slice(1, productSegmentEnd);
	const separator = productSegment.indexOf('-');
	if (separator <= 0 || separator === productSegment.length - 1) {
		return undefined;
	}
	const endpointPath = pathname.slice(productSegmentEnd);
	return endpointPath.startsWith('/_hucode/') ? endpointPath : undefined;
}

interface IWebWorkbenchExpectation {
	readonly label: string;
	readonly state: string;
	readonly active: boolean;
}

async function waitForWebSmokeTestDriver(
	page: Page,
	deadline: number
): Promise<void> {
	while (Date.now() < deadline) {
		if (await page.evaluate(() =>
			typeof (globalThis as unknown as {
				readonly __hucodeOmniSmokeTestDriver?: unknown;
			}).__hucodeOmniSmokeTestDriver !== 'undefined')) {
			return;
		}
		await delay(pollIntervalMs);
	}
	throw new Error('Timed out waiting for the Omni smoke-test driver');
}

async function openWorkspaceThroughSmokeDriver(
	page: Page,
	worktreePath: string,
	deadline: number
): Promise<void> {
	const operationDeadline = Date.now() + commandTimeout(deadline);
	await withDeadline(page.evaluate(async pathValue => {
		const target = globalThis as unknown as {
			readonly __hucodeOmniSmokeTestDriver?: {
				openWorkspace(path: string): Promise<void>;
			};
		};
		if (!target.__hucodeOmniSmokeTestDriver) {
			throw new Error('Omni smoke-test driver is unavailable');
		}
		await target.__hucodeOmniSmokeTestDriver.openWorkspace(pathValue);
	}, worktreePath), operationDeadline, `open ${worktreePath}`);
}

async function focusWorkspaceThroughSmokeDriver(
	page: Page,
	deadline: number
): Promise<void> {
	const timeout = commandTimeout(deadline);
	await waitForOmniProjectsSmokeSurfaceFocus(page, timeout);
	await withDeadline(page.evaluate(async () => {
		const target = globalThis as unknown as {
			readonly __hucodeOmniSmokeTestDriver?: {
				focusActiveWorkspace(): Promise<void>;
			};
		};
		if (!target.__hucodeOmniSmokeTestDriver) {
			throw new Error('Omni smoke-test driver is unavailable');
		}
		await target.__hucodeOmniSmokeTestDriver.focusActiveWorkspace();
	}), Date.now() + timeout, 'focus active workspace');
}

async function waitForWebWorkbenchState(
	page: Page,
	deadline: number,
	expected: readonly IWebWorkbenchExpectation[]
): Promise<void> {
	let lastObserved = '<not observed>';
	const phaseDeadline = Math.min(deadline, Date.now() + 30_000);
	while (Date.now() < phaseDeadline) {
		try {
			const rows = await readOmniWorkbenchSmokeRows(
				page,
				expected.map(row => row.label)
			);
			lastObserved = JSON.stringify(rows);
			if (expected.every(expectation => rows.some(row =>
				row.label === expectation.label &&
				row.state === expectation.state &&
				row.active === expectation.active &&
				!!row.ariaLabel
			)) && rows.length === expected.length) {
				return;
			}
		} catch (error) {
			lastObserved = formatError(error);
		}
		await delay(pollIntervalMs);
	}
	throw new Error(
		`Timed out waiting for workbench state ${JSON.stringify(expected)}; ` +
		`last observed ${lastObserved}`
	);
}

async function waitForHostedFrame(
	page: Page,
	worktreePath: string,
	deadline: number,
	excludedFrame?: Frame
): Promise<Frame> {
	let lastInventory = '<not observed>';
	const phaseDeadline = Date.now() + commandTimeout(deadline);
	while (Date.now() < phaseDeadline) {
		const matches: Frame[] = [];
		const inventory: unknown[] = [];
		for (const frame of page.frames()) {
			if (frame === excludedFrame) {
				continue;
			}
			try {
				const configuration = await readWebFrameConfiguration(frame);
				const frameWorktreePath = getWebFrameWorktreePath(frame);
				const hostedInstanceId = getWebFrameHostedInstanceId(frame);
				inventory.push({
					url: frame.url(),
					configuration,
					frameWorktreePath,
					hostedInstanceId,
				});
				if (
					(configuration?.isHostedOmniWorkspace === true ||
						frameWorktreePath !== undefined) &&
					(configuration?.workspacePath ?? frameWorktreePath) ===
					worktreePath
				) {
					matches.push(frame);
				}
			} catch (error) {
				inventory.push({ url: frame.url(), error: formatError(error) });
			}
		}
		lastInventory = JSON.stringify(inventory);
		if (matches.length === 1) {
			return matches[0];
		}
		await delay(pollIntervalMs);
	}
	throw new Error(
		`Timed out waiting for hosted frame ${worktreePath}; ` +
		`last inventory ${lastInventory}`
	);
}

function getWebFrameHostedInstanceId(frame: Frame): string | undefined {
	try {
		const payload = new URL(frame.url()).searchParams.get('payload');
		const entries = payload ? JSON.parse(payload) as unknown : undefined;
		if (!Array.isArray(entries)) {
			return undefined;
		}
		for (const entry of entries) {
			if (
				Array.isArray(entry) &&
				entry[0] === 'hostedInstanceId' &&
				typeof entry[1] === 'string'
			) {
				return entry[1];
			}
		}
	} catch {
		// The target inventory will report the malformed URL separately.
	}
	return undefined;
}

function getWebFrameWorktreePath(frame: Frame): string | undefined {
	try {
		const url = new URL(frame.url());
		if (!url.pathname.endsWith('/omni/workbench')) {
			return undefined;
		}
		return url.searchParams.get('folder') ?? undefined;
	} catch {
		return undefined;
	}
}

interface IWebFrameConfiguration {
	readonly isOmniWindow?: boolean;
	readonly isHostedOmniWorkspace?: boolean;
	readonly hostedInstanceId?: string;
	readonly workspacePath?: string;
}

async function readWebFrameConfiguration(
	frame: Frame
): Promise<IWebFrameConfiguration | undefined> {
	return frame.evaluate(async () => {
		const target = globalThis as unknown as {
			readonly vscode?: {
				readonly context?: {
					resolveConfiguration?: () => Promise<{
						readonly isOmniWindow?: boolean;
						readonly isHostedOmniWorkspace?: boolean;
						readonly hostedInstanceId?: string;
						readonly workspace?: {
							readonly uri?: { readonly path?: string };
						};
					}>;
				};
			};
		};
		const resolveConfiguration =
			target.vscode?.context?.resolveConfiguration;
		if (!resolveConfiguration) {
			return undefined;
		}
		const configuration = await resolveConfiguration.call(
			target.vscode?.context
		);
		return {
			isOmniWindow: configuration.isOmniWindow,
			isHostedOmniWorkspace: configuration.isHostedOmniWorkspace,
			hostedInstanceId: configuration.hostedInstanceId,
			workspacePath: configuration.workspace?.uri?.path,
		};
	});
}

async function formatWebTargetInventory(page: Page): Promise<string> {
	const inventory: unknown[] = [];
	for (const frame of page.frames()) {
		try {
			inventory.push({
				url: frame.url(),
				configuration: await readWebFrameConfiguration(frame),
				routeConfiguration: await readWebFrameRouteConfiguration(frame),
			});
		} catch (error) {
			inventory.push({ url: frame.url(), error: formatError(error) });
		}
	}
	return JSON.stringify(inventory, undefined, 2);
}

async function readWebFrameRouteConfiguration(
	frame: Frame
): Promise<object | undefined> {
	return frame.evaluate(() => {
		const target = globalThis as unknown as {
			readonly document: {
				getElementById(id: string): {
					getAttribute(name: string): string | null;
				} | null;
			};
		};
		const encoded = target.document.getElementById(
			'vscode-workbench-web-configuration'
		)?.getAttribute('data-settings');
		if (!encoded) {
			return undefined;
		}
		const configuration = JSON.parse(encoded) as Record<string, unknown>;
		return {
			hucodeOmniShell: configuration.hucodeOmniShell,
			hucodeHostedOmniWorkbench:
				configuration.hucodeHostedOmniWorkbench,
			hucodeWebUserDataStorage:
				configuration.hucodeWebUserDataStorage,
			developmentOptions: configuration.developmentOptions,
		};
	});
}

async function captureWebSmokeScreenshot(page: Page): Promise<string> {
	const artifactRoot = path.join(repoRoot, smokeArtifactRoot);
	await fs.mkdir(artifactRoot, { recursive: true });
	const screenshotPath = path.join(
		artifactRoot,
		'serve-web-hosted-command-smoke.png'
	);
	await page.screenshot({ path: screenshotPath, fullPage: true });
	return screenshotPath;
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

function commandTimeout(deadline: number): number {
	return Math.min(30_000, remainingTime(deadline));
}

async function withDeadline<T>(
	promise: Promise<T>,
	deadline: number,
	operation: string
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Timed out during ${operation}`)),
					remainingTime(deadline)
				);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function formatDiagnostics(label: string, messages: readonly string[]): string {
	const detail = messages.join('\n').slice(-maximumLogLength) || '<none>';
	return `${label} (last ${maximumLogLength} characters):\n${detail}`;
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
