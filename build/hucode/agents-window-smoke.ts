/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type Browser, chromium, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
	createLinuxOmniLaunchEnvironment,
	getAvailablePort,
	type ILinuxOmniSmokeOptions,
	parseLinuxOmniSmokeOptions,
	removeLinuxOmniTemporaryRoot,
	resolveLinuxOmniExecutable,
	terminateProcessGroup,
} from './linux-omni-smoke.ts';

const maximumLogLength = 64 * 1024;
const smokeArtifactRoot = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'.build',
	'hucode-smoke-artifacts'
);
const sessionsPagePattern =
	/\/vs\/sessions\/electron-browser\/sessions(?:-dev)?\.html$/;
const serviceRegistrationErrorPattern =
	/depends on \S+ which is NOT registered|depends on UNKNOWN service/;

/**
 * Builds arguments that open only the Agents window in an isolated profile.
 */
export function buildAgentsWindowSmokeArguments(
	temporaryRoot: string,
	remoteDebuggingPort: number
): string[] {
	return [
		`--user-data-dir=${path.join(temporaryRoot, 'user-data')}`,
		`--shared-data-dir=${path.join(temporaryRoot, 'shared')}`,
		`--extensions-dir=${path.join(temporaryRoot, 'extensions')}`,
		`--remote-debugging-port=${remoteDebuggingPort}`,
		'--disable-extensions',
		'--disable-workspace-trust',
		'--skip-release-notes',
		'--skip-welcome',
		'--password-store=basic',
		'--agents',
	];
}

/**
 * Returns the unique service-registration failures in the application's
 * renderer console output.
 */
export function findServiceRegistrationErrors(output: string): string[] {
	return [...new Set(output
		.split('\n')
		.filter(line => serviceRegistrationErrorPattern.test(line))
		.map(line => line.trim()))];
}

/**
 * Launches Hucode with `--agents` and verifies that the Agents window renders
 * its workbench and finishes startup without unregistered service
 * dependencies.
 *
 * The Agents window has its own renderer entrypoint, so a Hucode patch to a
 * shared desktop service can pass every other check and still leave this
 * window blank.
 */
export async function runAgentsWindowSmoke(
	options: ILinuxOmniSmokeOptions
): Promise<void> {
	if (process.platform !== 'linux') {
		throw new Error('The Agents window smoke test requires Linux');
	}

	const executablePath = await resolveLinuxOmniExecutable(
		options.executablePath
	);
	const temporaryRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), 'hucode-agents-window-smoke-')
	);
	const deadline = Date.now() + options.timeoutMs;
	let output = '';
	const outputListeners = new Set<() => void>();
	const appendOutput = (chunk: Buffer): void => {
		output = (output + chunk.toString()).slice(-maximumLogLength);
		for (const listener of outputListeners) {
			listener();
		}
	};
	let child: ChildProcess | undefined;
	let browser: Browser | undefined;
	let page: Page | undefined;

	try {
		const port = await getAvailablePort();
		child = spawn(
			executablePath,
			buildAgentsWindowSmokeArguments(temporaryRoot, port),
			{
				detached: true,
				env: {
					...createLinuxOmniLaunchEnvironment(process.env),
					// Mirrors renderer console messages to stderr from the first
					// line, before CDP can attach a listener.
					ELECTRON_ENABLE_LOGGING: '1',
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			}
		);
		child.stdout?.on('data', appendOutput);
		child.stderr?.on('data', appendOutput);
		const exited = new Promise<never>((_, reject) => {
			child!.once('error', reject);
			child!.once('exit', (code, signal) => reject(new Error(
				`Hucode exited before the Agents window finished startup ` +
				`(code ${code}, signal ${signal})`
			)));
		});
		exited.catch(() => undefined);

		browser = await Promise.race([
			connectToCdp(port, deadline),
			exited,
		]);
		page = await Promise.race([
			waitForSessionsPage(browser, deadline),
			exited,
		]);

		// The workbench class is added once the window's service graph has
		// resolved; reaching Eventually means every startup contribution was
		// created.
		await Promise.race([
			page.waitForFunction(() => {
				const { document } = globalThis as unknown as {
					readonly document: {
						querySelector(selector: string): unknown;
					};
				};
				return !!document.querySelector(
					'.monaco-workbench.agent-sessions-workbench'
				) &&
					performance.getEntriesByName(
						'code/LifecyclePhase/Eventually'
					).length > 0;
			},
				undefined,
				{ timeout: getRemainingTimeout(deadline) }
			),
			exited,
		]);

		// Console output reaches stderr in order, so once this marker arrives
		// every message logged during startup has been captured.
		const marker = `hucode-agents-window-smoke-${randomUUID()}`;
		const markerSeen = waitForOutput(
			() => output.includes(marker),
			outputListeners,
			deadline
		);
		await page.evaluate(value => console.warn(value), marker);
		await Promise.race([markerSeen, exited]);

		if (findServiceRegistrationErrors(output).length > 0) {
			throw new Error(
				'The Agents window started with unregistered service dependencies'
			);
		}
	} catch (error) {
		const screenshot = page
			? await captureScreenshot(page).catch(screenshotError =>
				`<unavailable: ${formatError(screenshotError)}>`
			)
			: '<no Agents window page>';
		const rendererUrls = browser
			? browser.contexts().flatMap(context =>
				context.pages().map(candidate => candidate.url())
			)
			: [];
		// A missing service usually breaks startup before any assertion runs,
		// so name it ahead of the symptom it caused.
		const registrationErrors = findServiceRegistrationErrors(output);
		throw new Error([
			`Agents window smoke failed: ${formatError(error)}`,
			`Service registration errors: ${registrationErrors.length > 0
				? `\n${registrationErrors.join('\n')}`
				: '<none>'}`,
			`Renderer URLs: ${JSON.stringify(rendererUrls)}`,
			`Screenshot: ${screenshot}`,
			`Application output (last ${maximumLogLength} characters):`,
			output || '<none>',
		].join('\n'));
	} finally {
		await browser?.close().catch(() => undefined);
		if (child) {
			await terminateProcessGroup(child);
		}
		await removeLinuxOmniTemporaryRoot(temporaryRoot);
	}
}

async function connectToCdp(port: number, deadline: number): Promise<Browser> {
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
				timeout: Math.max(1, Math.min(1_000, deadline - Date.now())),
			});
		} catch (error) {
			lastError = error;
			await delay(250);
		}
	}
	throw new Error(
		`Timed out connecting to the CDP endpoint: ${formatError(lastError)}`
	);
}

async function waitForSessionsPage(
	browser: Browser,
	deadline: number
): Promise<Page> {
	const context = browser.contexts()[0];
	if (!context) {
		throw new Error('The CDP connection exposed no browser context');
	}
	const findPage = () => context.pages().find(candidate =>
		sessionsPagePattern.test(new URL(candidate.url()).pathname)
	);
	const existing = findPage();
	if (existing) {
		return existing;
	}
	return new Promise<Page>((resolve, reject) => {
		const timer = setTimeout(() => {
			context.off('page', onPage);
			reject(new Error(
				'Timed out waiting for the Agents window renderer. Pages: ' +
				JSON.stringify(context.pages().map(candidate => candidate.url()))
			));
		}, getRemainingTimeout(deadline));
		const onPage = (): void => {
			const page = findPage();
			if (page) {
				clearTimeout(timer);
				context.off('page', onPage);
				resolve(page);
			}
		};
		context.on('page', onPage);
		onPage();
	});
}

function waitForOutput(
	accepted: () => boolean,
	listeners: Set<() => void>,
	deadline: number
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			listeners.delete(listener);
			reject(new Error(
				'Timed out waiting for renderer console output on stderr'
			));
		}, getRemainingTimeout(deadline));
		const listener = (): void => {
			if (accepted()) {
				clearTimeout(timer);
				listeners.delete(listener);
				resolve();
			}
		};
		listeners.add(listener);
		listener();
	});
}

async function captureScreenshot(page: Page): Promise<string> {
	await fs.mkdir(smokeArtifactRoot, { recursive: true });
	const screenshotPath = path.join(
		smokeArtifactRoot,
		'agents-window-smoke.png'
	);
	await page.screenshot({ path: screenshotPath, timeout: 5_000 });
	return screenshotPath;
}

function getRemainingTimeout(deadline: number): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		throw new Error('The Agents window smoke test timed out');
	}
	return remaining;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	runAgentsWindowSmoke(parseLinuxOmniSmokeOptions(process.argv.slice(2))).then(
		() => console.log('Agents window smoke passed'),
		error => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		}
	);
}
