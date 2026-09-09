/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { copyFileSync, existsSync, mkdtempSync, promises as fs, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'net';
import { pathToFileURL } from 'url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createLinuxOmniLaunchEnvironment } from './linux-omni-smoke.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hucode-onboarding-smoke-'));
const executable = process.argv[2] ?? './.build/electron/hucode';
let installation = 'first';
const userDirectory = () => path.join(root, installation, 'user');
const timeout = 30_000;
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let page!: Page;
let port: number;
let output = '';
console.log(`Isolated fixture: ${root}`);

async function waitFor<T>(probe: () => Promise<T>, accepted: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + timeout;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (accepted(value)) { return value; }
		} catch (error) { lastError = error; }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for onboarding: ${String(lastError ?? '')}`);
}

async function stop(): Promise<void> {
	if (child?.pid) {
		const stopped = new Promise<void>(resolve => child!.once('exit', () => resolve()));
		try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The app may already have exited. */ }
		await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 5000))]);
		child = undefined;
	}
	await Promise.race([browser?.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 1000))]);
	browser = undefined;
}

async function launch(): Promise<void> {
	const server = createServer();
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as { port: number }).port;
	await new Promise<void>(resolve => server.close(() => resolve()));
	const applicationArgs = [
		...(process.argv[2] ? [] : ['.']),
		`--user-data-dir=${userDirectory()}`,
		`--shared-data-dir=${path.join(root, installation, 'shared')}`,
		`--extensions-dir=${path.join(root, installation, 'extensions')}`,
		`--remote-debugging-port=${port}`,
		'--disable-workspace-trust', '--skip-release-notes',
		'--password-store=basic', '--enable-smoke-test-driver',
	];
	const isolatedSourceArgs = installation === 'import' ? ['--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--tmpfs', '/home', '--bind', process.cwd(), process.cwd(), '--dir', path.join(os.homedir(), '.vscode', 'extensions'), '--bind', path.join(root, 'source-extensions'), path.join(os.homedir(), '.vscode', 'extensions'), '--', executable] : [];
	child = spawn(installation === 'import' ? 'bwrap' : executable, [...isolatedSourceArgs, ...applicationArgs], { detached: true, env: { ...createLinuxOmniLaunchEnvironment(process.env), XDG_CONFIG_HOME: path.join(root, 'source-config'), ...(process.argv[2] ? {} : { VSCODE_DEV: '1' }) }, stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout?.on('data', chunk => output += String(chunk));
	child.stderr?.on('data', chunk => output += String(chunk));
	browser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${port}`), Boolean);
	page = await waitFor(async () => browser!.contexts()[0].pages().find(candidate => candidate.url().includes('omni-'))!, Boolean);
	page.setDefaultTimeout(timeout);
	page.setDefaultNavigationTimeout(timeout);
	await page.getByRole('tree', { name: 'Workbenches and Projects' }).waitFor({ timeout });
}

// Electron exposes the custom-scheme webview as an OOPIF target. Direct CDP also
// works when Playwright has not attached that target to its parent Frame tree.
async function webview<T>(expression: string): Promise<T> {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
	const target = targets.find(candidate => candidate.type === 'iframe' && candidate.url.startsWith('vscode-webview:'));
	if (!target) { throw new Error('No setup webview'); }
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Webview CDP connection timed out')), 3000);
			socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
			socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Webview CDP connection failed')); }, { once: true });
		});
		return await new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Webview evaluation timed out')), timeout);
			socket.addEventListener('message', event => {
				const response = JSON.parse(String(event.data));
				if (response.id !== 1) { return; }
				clearTimeout(timer);
				if (response.error || response.result.exceptionDetails) { reject(new Error(JSON.stringify(response))); }
				else { resolve(response.result.result.value); }
			});
			socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
				expression: `(() => { const document = globalThis.document.querySelector('#active-frame').contentDocument; return (${expression}); })()`,
				returnByValue: true,
			} }));
		});
	} finally { socket.close(); }
}

async function textIncludes(text: string): Promise<void> {
	await waitFor(() => webview<string>('document.body.innerText'), value => value.includes(text));
}

async function click(label: string): Promise<void> {
	await waitFor(() => webview<boolean>(`(() => {
		const button = [...document.querySelectorAll('button')].find(button => button.innerText.trim() === ${JSON.stringify(label)} || button.innerText.startsWith(${JSON.stringify(label + '\n')}));
		if (!button || button.disabled) { return false; }
		button.click(); return true;
	})()`), Boolean);
}

function record(): { status: string; stage?: string; handoffProfileId?: string } {
	const inspectionRoot = mkdtempSync(path.join(root, 'checkpoint-inspection-'));
	const original = path.join(userDirectory(), 'User', 'globalStorage', 'state.vscdb');
	const copy = path.join(inspectionRoot, 'state.vscdb');
	for (const suffix of ['', '-wal', '-shm', '-journal']) {
		if (existsSync(original + suffix)) { copyFileSync(original + suffix, copy + suffix); }
	}
	// A killed writer may require journal recovery, so inspect a writable copy.
	const database = new DatabaseSync(copy);
	try {
		const row = database.prepare(`SELECT value FROM ItemTable WHERE key = 'hucode.onboarding.state'`).get() as { value: string };
		return JSON.parse(row.value);
	} finally { database.close(); rmSync(inspectionRoot, { recursive: true, force: true }); }
}

async function command(name: string): Promise<void> {
	await page.keyboard.press('F1');
	const input = page.locator('.quick-input-widget input');
	await input.fill(`>${name}`);
	await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: name }).first().waitFor({ timeout });
	await page.keyboard.press('Enter');
}

async function prepareInstallation(): Promise<void> {
	await fs.mkdir(path.join(userDirectory(), 'User'), { recursive: true });
	await fs.writeFile(path.join(userDirectory(), 'User', 'settings.json'), JSON.stringify({ 'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom' }));
}

async function reviewSyntheticImport(): Promise<void> {
	await textIncludes('Which Application Should Hucode Import From?');
	await click('Visual Studio Code');
	await click('Continue');
	await textIncludes('Where Should Hucode Import This Setup?');
	await webview(`(() => {
		const input = document.querySelector('#target-new-name');
		Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set.call(input, 'Smoke Imported');
		input.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await click('Use New Profile');
	await click('Review Import');
	await textIncludes('Import review is ready.');
}

try {
	await prepareInstallation();
	await launch();
	await textIncludes('Bring Your Setup to Hucode');
	assert.equal(await page.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).count(), 1);
	await page.screenshot({ path: path.join(root, 'first-launch.png') });
	console.log('PASS fresh launch: one modal and acknowledged bring on disk');

	await stop();
	assert.deepStrictEqual(record(), { version: 2, status: 'inProgress', stage: 'bring' });
	await launch();
	await textIncludes('Bring Your Setup to Hucode');
	console.log('PASS whole-process kill after bring: resumes bring');
	console.log('PHASE dismiss and reload');
	await click('Do This Later');
	await page.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).waitFor({ state: 'hidden', timeout });
	await command('Developer: Reload Window');
	await textIncludes('Bring Your Setup to Hucode');
	console.log('PASS dismissal and renderer reload: resumes without completion');

	await click('Skip Import');
	await textIncludes('Choose How Hucode Looks');
	await stop();
	assert.equal(record().stage, 'appearance');
	await launch();
	await textIncludes('Choose How Hucode Looks');
	await click('Continue');
	await textIncludes('Meet Omni');
	await click('Finish');
	await page.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).waitFor({ state: 'hidden', timeout });
	await stop();
	assert.equal(record().status, 'completed');
	await launch();
	await page.waitForTimeout(2000);
	assert.equal(await page.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).count(), 0);
	console.log('PASS Skip Import, appearance process-kill resume, Finish, and terminal process-kill suppression');

	await command('Hucode: Open Onboarding');
	await textIncludes('Welcome to Hucode');
	const dismissed = page.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).waitFor({ state: 'hidden', timeout });
	await Promise.race([page.keyboard.press('Escape'), dismissed]);
	await dismissed;
	await stop();
	assert.equal(record().status, 'completed');
	console.log('PASS manual rerun dismissal preserves completion');
	installation = 'skipped';
	await prepareInstallation();
	await launch();
	await textIncludes('Bring Your Setup to Hucode');
	await click('Skip');
	await page.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).waitFor({ state: 'hidden', timeout });
	await stop();
	assert.equal(record().status, 'skipped');
	await launch();
	await page.waitForTimeout(2000);
	assert.equal(await page.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).count(), 0);
	await stop();
	console.log('PASS explicit Skip survives process termination and suppresses restart onboarding');

	installation = 'import';
	await prepareInstallation();
	const source = path.join(root, 'source-config', 'Code', 'User');
	await fs.mkdir(source, { recursive: true });
	await fs.writeFile(path.join(source, 'settings.json'), JSON.stringify({ 'editor.fontSize': 23, 'editor.minimap.enabled': false }));
	await fs.mkdir(path.join(root, 'source-extensions'));
	await fs.writeFile(path.join(root, 'source-extensions', 'extensions.json'), '[]');
	await launch();
	await textIncludes('Bring Your Setup to Hucode');
	await click('Import from Another Editor');
	await reviewSyntheticImport();
	const operationsRoot = path.join(userDirectory(), 'User', 'hucode', 'migration', 'operations');
	await stop();
	assert.equal(record().stage, 'migrate');
	assert.deepStrictEqual(await fs.readdir(operationsRoot).catch(() => []), []);
	await launch();
	await reviewSyntheticImport();
	console.log('PASS pre-Apply process kill resumes a fresh review without an admitted operation');
	await click('Import');
	await textIncludes('Recovery data stays available');
	await stop();
	const operationIds = await fs.readdir(operationsRoot);
	assert.equal(operationIds.length, 1);
	const operationPath = path.join(operationsRoot, operationIds[0], 'operation.json');
	const operationBytes = await fs.readFile(operationPath, 'utf8');
	const operation = JSON.parse(operationBytes) as { stage: string; target: { profileId: string }; aggregateOutcome: string };
	assert.equal(operation.stage, 'settled');
	assert.equal(record().stage, 'migrate');
	await launch();
	await textIncludes('Continue an Earlier Import');
	await click('View or Continue');
	await textIncludes('Recovery data stays available');
	await click('Continue');
	await textIncludes('Meet Omni');
	if (operation.aggregateOutcome !== 'completed') { await textIncludes('Some import items still need attention'); }
	await stop();
	assert.equal(await fs.readFile(operationPath, 'utf8'), operationBytes);
	assert.equal(record().handoffProfileId, operation.target.profileId);
	await launch();
	await textIncludes('Meet Omni');
	const folder = path.join(root, 'first-folder');
	const repository = path.join(root, 'repository');
	await fs.mkdir(repository);
	const git = (args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'ignore' });
	git(['init', '--initial-branch=main']);
	await fs.writeFile(path.join(repository, 'README.md'), 'Synthetic onboarding project.\n');
	git(['add', 'README.md']);
	git(['-c', 'user.name=Hucode Smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Initial fixture']);
	git(['worktree', 'add', '-b', 'feature', folder]);
	await click('Add Project');
	const folderInput = page.locator('.quick-input-widget input');
	await folderInput.fill(folder + '/');
	await page.waitForTimeout(500);
	await page.keyboard.press('Enter');
	await page.getByRole('button', { name: 'Use Smoke Imported', exact: true }).click();
	const hosted = await waitFor(async () => {
		for (const candidate of browser!.contexts()[0].pages()) {
			const config = await candidate.evaluate(() => (globalThis as unknown as { vscode?: { context?: { resolveConfiguration(): Promise<{ isHostedOmniWorkspace?: boolean; profiles?: { profile?: { id: string } }; workspace?: { uri?: { path: string } } }> } } }).vscode?.context?.resolveConfiguration()).catch(() => undefined);
			if (config?.isHostedOmniWorkspace) { return config; }
		}
		return undefined;
	}, Boolean);
	assert.equal(hosted!.profiles?.profile?.id, operation.target.profileId);
	assert.equal(hosted!.workspace?.uri?.path, folder);
	await page.locator('.monaco-list-row[aria-current="true"]:has(.hucode-project-switcher-worktree-loaded)').waitFor({ timeout });
	assert.equal(await page.locator('.monaco-list-row[aria-current="true"]').count(), 1);
	await page.screenshot({ path: path.join(root, 'imported-workbench.png') });
	await stop();
	assert.equal(record().status, 'completed');
	const profilesState = JSON.parse(await fs.readFile(path.join(userDirectory(), 'User', 'globalStorage', 'storage.json'), 'utf8'));
	assert.deepStrictEqual(profilesState.profileAssociations.workspaces, { [pathToFileURL(folder).toString()]: operation.target.profileId });
	assert.equal(await fs.readFile(operationPath, 'utf8'), operationBytes);
	await launch();
	await page.waitForTimeout(2000);
	assert.equal(await page.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).count(), 0);
	console.log('PASS reviewed synthetic import, results and Meet Omni process-kill recovery without reapplying, explicit actual-profile selected-worktree handoff with one active owner and no sibling association, and completed restart');
	console.log(`Artifacts: ${root}`);
} finally {
	await stop();
	await fs.writeFile(path.join(root, 'app.log'), output);
	console.log(`Isolated user, shared, and extension data retained at ${root}`);
}
