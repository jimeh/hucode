/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import {
	assertLinuxOmniLifecycleObservation,
	buildLinuxOmniSmokeArguments,
	classifyLinuxOmniTargets,
	createLinuxOmniLifecycleExpectations,
	createLinuxOmniSmokeFixture,
	formatLinuxOmniUnexpectedExit,
	getLinuxOmniLaunchAttemptDeadline,
	getLinuxOmniStabilizationDelay,
	linuxOmniLifecyclePhases,
	parseLinuxOmniSmokeOptions,
	resolveLinuxOmniExecutable,
	summarizeLinuxOmniRenderers,
} from '../../hucode/linux-omni-smoke.ts';

suite('Hucode Linux Omni lifecycle smoke', () => {
	test('parses a caller-supplied packaged application path', () => {
		assert.deepStrictEqual(
			parseLinuxOmniSmokeOptions([
				'--app',
				'/tmp/VSCode-linux-x64',
				'--timeout-ms',
				'30000',
			]),
			{
				executablePath: '/tmp/VSCode-linux-x64',
				timeoutMs: 30_000,
			}
		);
		assert.deepStrictEqual(
			parseLinuxOmniSmokeOptions(['--executable', '/tmp/hucode']),
			{
				executablePath: '/tmp/hucode',
				timeoutMs: 180_000,
			}
		);
	});

	test('rejects missing and malformed command-line options', () => {
		assert.throws(
			() => parseLinuxOmniSmokeOptions([]),
			/Pass --executable/
		);
		assert.throws(
			() => parseLinuxOmniSmokeOptions(['--app']),
			/--app requires a path/
		);
		assert.throws(
			() => parseLinuxOmniSmokeOptions(['--app', '/tmp/app', '--timeout-ms', '0']),
			/Invalid --timeout-ms value: 0/
		);
		assert.throws(
			() => parseLinuxOmniSmokeOptions(['--app', '/tmp/app', '--timeout-ms', 'soon']),
			/Invalid --timeout-ms value: soon/
		);
		assert.throws(
			() => parseLinuxOmniSmokeOptions(['--wat']),
			/Unknown argument: --wat/
		);
	});

	test('reports a missing packaged executable', async () => {
		await assert.rejects(
			resolveLinuxOmniExecutable('/definitely/missing/hucode'),
			/ENOENT/
		);
	});

	test('builds an isolated profile launch with CDP enabled', () => {
		assert.deepStrictEqual(
			buildLinuxOmniSmokeArguments('/tmp/user-data', '/tmp/extensions', 9222),
			[
				'--user-data-dir=/tmp/user-data',
				'--extensions-dir=/tmp/extensions',
				'--remote-debugging-port=9222',
				'--disable-extensions',
				'--disable-workspace-trust',
				'--skip-release-notes',
				'--skip-welcome',
				'--password-store=basic',
				'--enable-smoke-test-driver',
			]
		);
	});

	test('formats the deterministic two-workbench lifecycle fixture', () => {
		const fixture = createLinuxOmniSmokeFixture(
			'/tmp/smoke/Alpha',
			'/tmp/smoke/Bravo'
		);

		assert.deepStrictEqual(fixture.settings, {
			'window.restoreWindows': 'one',
			'window.confirmBeforeClose': 'never',
			'hucode.omni.restoreHostedWorkbenches': 'active',
		});
		assert.deepStrictEqual(fixture.storage, {
			windowsState: {
				lastActiveWindow: {
					windowKind: 'omni',
					omniActiveWorktreePath: '/tmp/smoke/Alpha',
					omniRetainedWorkbenches: [
						{
							id: 'smoke-alpha',
							folderUri: {
								scheme: 'file',
								path: '/tmp/smoke/Alpha',
							},
							label: 'Alpha',
							desiredState: 'loaded',
							order: 0,
							lastActiveAt: 2,
						},
						{
							id: 'smoke-bravo',
							folderUri: {
								scheme: 'file',
								path: '/tmp/smoke/Bravo',
							},
							label: 'Bravo',
							desiredState: 'loaded',
							order: 1,
							lastActiveAt: 1,
						},
					],
					uiState: {
						width: 1200,
						height: 800,
						mode: 0,
					},
				},
				openedWindows: [],
			},
		});
	});

	test('classifies shell and hosted targets by resolved configuration', () => {
		assert.deepStrictEqual(
			classifyLinuxOmniTargets([
				{
					url: 'devtools://devtools/bundled/inspector.html',
				},
				{
					url: 'vscode-file://vscode-app/vs/hucode/electron-browser/omni.html',
					configuration: {
						isOmniWindow: true,
					},
				},
				{
					url: 'vscode-file://vscode-app/vs/code/electron-browser/workbench/workbench.html',
					configuration: {
						isOmniWindow: true,
						isHostedOmniWorkspace: true,
						hostedInstanceId: 'alpha-instance',
						workspace: {
							uri: {
								scheme: 'file',
								path: '/tmp/smoke/Alpha',
							},
						},
					},
				},
			], ['/tmp/smoke/Alpha', '/tmp/smoke/Bravo']),
			{
				shellUrl:
					'vscode-file://vscode-app/vs/hucode/electron-browser/omni.html',
				workbenches: [{
					url: 'vscode-file://vscode-app/vs/code/electron-browser/workbench/workbench.html',
					worktreePath: '/tmp/smoke/Alpha',
					hostedInstanceId: 'alpha-instance',
				}],
				crashedRendererUrls: [],
			}
		);
	});

	test('rejects ambiguous, invalid, and unclassified application targets', () => {
		const shell = {
			url: 'vscode-file://vscode-app/vs/hucode/electron-browser/omni.html',
			configuration: { isOmniWindow: true },
		};
		const alpha = {
			url: 'vscode-file://vscode-app/vs/code/electron-browser/workbench/workbench.html',
			configuration: {
				isOmniWindow: true,
				isHostedOmniWorkspace: true,
				hostedInstanceId: 'alpha-instance',
				workspace: {
					uri: { scheme: 'file', path: '/tmp/smoke/Alpha' },
				},
			},
		};

		assert.throws(
			() => classifyLinuxOmniTargets(
				[shell, { ...shell, url: `${shell.url}?duplicate` }],
				['/tmp/smoke/Alpha']
			),
			/Expected exactly one Omni shell target, observed 2/
		);
		assert.throws(
			() => classifyLinuxOmniTargets(
				[
					shell,
					alpha,
					{
						...alpha,
						url: `${alpha.url}?duplicate`,
						configuration: {
							...alpha.configuration,
							hostedInstanceId: 'alpha-instance-2',
						},
					},
				],
				['/tmp/smoke/Alpha']
			),
			/Expected at most one live hosted target/
		);
		assert.throws(
			() => classifyLinuxOmniTargets(
				[alpha, {
					...alpha,
					url: `${alpha.url}?duplicate`,
					configuration: {
						...alpha.configuration,
						hostedInstanceId: 'alpha-instance-2',
					},
				}],
				['/tmp/smoke/Alpha']
			),
			/Expected exactly one Omni shell target, observed 0/
		);
		assert.throws(
			() => classifyLinuxOmniTargets([
				shell,
				{
					url: alpha.url,
					configuration: {
						...alpha.configuration,
						hostedInstanceId: '',
					},
				},
			], ['/tmp/smoke/Alpha']),
			/invalid hosted target/
		);
		assert.throws(
			() => classifyLinuxOmniTargets([
				shell,
				{
					url: 'about:blank',
					configurationError: 'execution context unavailable',
				},
			], ['/tmp/smoke/Alpha']),
			/Unclassified application target/
		);
	});

	test('tolerates a previously crashed target without counting it twice', () => {
		const shell = {
			url: 'vscode-file://vscode-app/vs/hucode/electron-browser/omni.html',
			configuration: { isOmniWindow: true },
		};
		const result = classifyLinuxOmniTargets([
			shell,
			{
				url: 'vscode-file://vscode-app/vs/code/electron-browser/workbench/workbench.html',
				crashed: true,
			},
			{
				url: 'vscode-file://vscode-app/vs/code/electron-browser/workbench/workbench.html',
				configuration: {
					isOmniWindow: true,
					isHostedOmniWorkspace: true,
					hostedInstanceId: 'replacement',
					workspace: {
						uri: { scheme: 'file', path: '/tmp/smoke/Bravo' },
					},
				},
			},
		], ['/tmp/smoke/Bravo']);

		assert.deepStrictEqual(result.crashedRendererUrls, [
			'vscode-file://vscode-app/vs/code/electron-browser/workbench/workbench.html',
		]);
		assert.strictEqual(result.workbenches[0].hostedInstanceId, 'replacement');
	});

	test('validates every named lifecycle phase with exact rows and targets', () => {
		assert.deepStrictEqual(linuxOmniLifecyclePhases, [
			'initial restore',
			'switch to Bravo',
			'switch to Alpha',
			'suspend Bravo',
			'restore Bravo',
			'crash Bravo',
			'recover Bravo',
			'quit',
			'relaunch restore',
		]);
		const expectations = createLinuxOmniLifecycleExpectations(
			'/tmp/smoke/Alpha',
			'/tmp/smoke/Bravo'
		);
		assert.deepStrictEqual(expectations['crash Bravo'], {
			rows: [
				{ label: 'Alpha', state: 'loaded', active: false },
				{ label: 'Bravo', state: 'crashed', active: false },
			],
			targetPaths: ['/tmp/smoke/Alpha'],
		});
		assert.deepStrictEqual(expectations['relaunch restore'], {
			rows: [
				{ label: 'Alpha', state: 'dormant', active: false },
				{ label: 'Bravo', state: 'active', active: true },
			],
			targetPaths: ['/tmp/smoke/Bravo'],
		});

		assert.doesNotThrow(() => assertLinuxOmniLifecycleObservation(
			'initial restore',
			{
				rows: [
					{
						label: 'Alpha',
						state: 'active',
						active: true,
						ariaLabel: 'Alpha, /tmp/smoke/Alpha, Active',
					},
					{
						label: 'Bravo',
						state: 'dormant',
						active: false,
						ariaLabel: 'Bravo, /tmp/smoke/Bravo, Dormant',
					},
				],
				targetPaths: ['/tmp/smoke/Alpha'],
				shellResponsive: true,
			},
			{
				rows: [
					{ label: 'Alpha', state: 'active', active: true },
					{ label: 'Bravo', state: 'dormant', active: false },
				],
				targetPaths: ['/tmp/smoke/Alpha'],
			}
		));
		assert.throws(
			() => assertLinuxOmniLifecycleObservation(
				'crash Bravo',
				{
					rows: [
						{
							label: 'Alpha',
							state: 'loaded',
							active: false,
							ariaLabel: 'Alpha, /tmp/smoke/Alpha, Loaded',
						},
						{
							label: 'Bravo',
							state: 'loaded',
							active: false,
							ariaLabel: 'Bravo, /tmp/smoke/Bravo, Loaded',
						},
					],
					targetPaths: ['/tmp/smoke/Alpha'],
					shellResponsive: true,
				},
				{
					rows: [
						{ label: 'Alpha', state: 'loaded', active: false },
						{ label: 'Bravo', state: 'crashed', active: false },
					],
					targetPaths: ['/tmp/smoke/Alpha'],
				}
			),
			/crash Bravo.*expected.*crashed.*observed.*loaded/
		);
	});

	test('formats phase-specific unexpected-exit diagnostics', () => {
		assert.strictEqual(
			formatLinuxOmniUnexpectedExit('relaunch restore', 7, null),
			'Packaged application exited during relaunch restore ' +
				'(code=7, signal=null)'
		);
		assert.strictEqual(
			formatLinuxOmniUnexpectedExit('quit', 0, null),
			'Packaged application exited during quit (code=0, signal=null)'
		);
	});

	test('distinguishes Omni from regular application renderers', () => {
		assert.deepStrictEqual(
			summarizeLinuxOmniRenderers([
				'devtools://devtools/bundled/inspector.html',
				'chrome-devtools://devtools/bundled/inspector.html',
				'vscode-file://vscode-app/vs/hucode/electron-browser/omni.html',
				'vscode-file://vscode-app/vs/code/electron-browser/' +
					'workbench/workbench.html',
			]),
			{
				rendererUrls: [
					'devtools://devtools/bundled/inspector.html',
					'chrome-devtools://devtools/bundled/inspector.html',
					'vscode-file://vscode-app/vs/hucode/electron-browser/omni.html',
					'vscode-file://vscode-app/vs/code/electron-browser/' +
						'workbench/workbench.html',
				],
				applicationRendererCount: 2,
				omniRendererCount: 1,
			}
		);
	});

	test('counts blank and error pages as fallback renderers', () => {
		assert.deepStrictEqual(
			summarizeLinuxOmniRenderers([
				'devtools://devtools/bundled/inspector.html',
				'vscode-file://vscode-app/vs/hucode/electron-browser/omni.html',
				'about:blank',
				'chrome-error://chromewebdata/',
			]),
			{
				rendererUrls: [
					'devtools://devtools/bundled/inspector.html',
					'vscode-file://vscode-app/vs/hucode/electron-browser/omni.html',
					'about:blank',
					'chrome-error://chromewebdata/',
				],
				applicationRendererCount: 3,
				omniRendererCount: 1,
			}
		);
	});

	test('shares the remaining timeout across CDP launch attempts', () => {
		assert.strictEqual(
			getLinuxOmniLaunchAttemptDeadline(46_000, 1_000, 3),
			16_000
		);
		assert.strictEqual(
			getLinuxOmniLaunchAttemptDeadline(46_000, 31_000, 1),
			46_000
		);
	});

	test('bounds renderer stabilization by the remaining timeout', () => {
		assert.strictEqual(getLinuxOmniStabilizationDelay(10_000, 1_000), 1_500);
		assert.strictEqual(getLinuxOmniStabilizationDelay(10_000, 9_750), 250);
		assert.strictEqual(getLinuxOmniStabilizationDelay(10_000, 10_001), 0);
	});
});
