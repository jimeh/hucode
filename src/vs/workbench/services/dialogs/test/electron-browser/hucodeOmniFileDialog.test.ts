/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../../base/test/common/utils.js';
import { isFolderToOpen } from
	'../../../../../platform/window/common/window.js';
import {
	IHucodeOmniFileDialogEnvironment,
	IHucodeOmniFileDialogHost,
	tryPickHucodeOmniFolderAndOpen,
} from '../../electron-browser/hucodeOmniFileDialog.js';

suite('HucodeOmniFileDialog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('routes Omni folder selection through the host open interceptor',
		async () => {
			const folder = URI.file('/repos/project');
			const opened: string[] = [];
			const host: IHucodeOmniFileDialogHost = {
				showOpenDialog: async options => {
					assert.deepStrictEqual({
						canSelectFiles: options.canSelectFiles,
						canSelectFolders: options.canSelectFolders,
						canSelectMany: options.canSelectMany,
						defaultUri: options.defaultUri,
					}, {
						canSelectFiles: false,
						canSelectFolders: true,
						canSelectMany: false,
						defaultUri: URI.file('/repos'),
					});
					return [folder];
				},
				openWindow: async openables => {
					const openable = openables[0];
					if (isFolderToOpen(openable)) {
						opened.push(openable.folderUri.fsPath);
					}
				},
			};

			const handled = await tryPickHucodeOmniFolderAndOpen(
				Schemas.file,
				{ defaultUri: URI.file('/repos') },
				{ isOmniWindow: true },
				host
			);

			assert.deepStrictEqual({ handled, opened }, {
				handled: true,
				opened: ['/repos/project'],
			});
		}
	);

	test('handles cancellation without replacing the Omni shell', async () => {
		let openCalls = 0;
		const handled = await tryPickHucodeOmniFolderAndOpen(
			Schemas.file,
			{},
			{ isOmniWindow: false, isHostedOmniWorkspace: true },
			{
				showOpenDialog: async () => undefined,
				openWindow: async () => { openCalls++; },
			}
		);

		assert.deepStrictEqual({ handled, openCalls }, {
			handled: true,
			openCalls: 0,
		});
	});

	test('preserves native routing for special and non-Omni opens', async () => {
		const host: IHucodeOmniFileDialogHost = {
			showOpenDialog: async () => {
				throw new Error('unexpected dialog');
			},
			openWindow: async () => {
				throw new Error('unexpected open');
			},
		};
		const cases: readonly [
			string,
			{ readonly forceNewWindow?: boolean },
			IHucodeOmniFileDialogEnvironment,
		][] = [
				[Schemas.file, {}, { isOmniWindow: false }],
				[Schemas.file, { forceNewWindow: true }, { isOmniWindow: true }],
				['vscode-remote', {}, { isOmniWindow: true }],
				[Schemas.file, {}, {
					isOmniWindow: true,
					extensionDevelopmentLocationURI: [URI.file('/extension')],
				}],
			];

		const results = await Promise.all(cases.map(([schema, options, env]) =>
			tryPickHucodeOmniFolderAndOpen(schema, options, env, host)
		));

		assert.deepStrictEqual(results, [false, false, false, false]);
	});
});
