/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import {
	buildLinuxOmniSmokeArguments,
	parseLinuxOmniSmokeOptions,
	summarizeLinuxOmniRenderers,
} from '../../hucode/linux-omni-smoke.ts';

suite('Hucode Linux Omni smoke', () => {
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
			]
		);
	});

	test('distinguishes Omni from regular application renderers', () => {
		assert.deepStrictEqual(
			summarizeLinuxOmniRenderers([
				'devtools://devtools/bundled/inspector.html',
				'vscode-file://vscode-app/vs/hucode/electron-browser/omni.html',
				'vscode-file://vscode-app/vs/code/electron-browser/' +
					'workbench/workbench.html',
			]),
			{
				rendererUrls: [
					'devtools://devtools/bundled/inspector.html',
					'vscode-file://vscode-app/vs/hucode/electron-browser/omni.html',
					'vscode-file://vscode-app/vs/code/electron-browser/' +
						'workbench/workbench.html',
				],
				applicationRendererCount: 2,
				omniRendererCount: 1,
			}
		);
	});
});
