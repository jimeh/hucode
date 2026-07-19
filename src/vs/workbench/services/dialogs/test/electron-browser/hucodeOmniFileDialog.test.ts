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
	IHucodeOmniFileFolderDialogHost,
	IHucodeOmniFileDialogEnvironment,
	IHucodeOmniFileDialogHost,
	tryPickHucodeOmniFileFolderAndOpen,
	tryPickHucodeOmniFolderAndOpen,
} from '../../electron-browser/hucodeOmniFileDialog.js';

suite('HucodeOmniFileDialog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('routes Omni file-or-folder selections by resource type', async () => {
		const selected = [
			[
				URI.file('/repos/project'),
				URI.file('/repos/project/README.md'),
				URI.file('/repos/project/package.json'),
			],
			[URI.file('/repos/other')],
		];
		const opened: string[] = [];
		const host: IHucodeOmniFileFolderDialogHost = {
			showOpenDialog: async options => {
				assert.deepStrictEqual({
					canSelectFiles: options.canSelectFiles,
					canSelectFolders: options.canSelectFolders,
					canSelectMany: options.canSelectMany,
					defaultUri: options.defaultUri,
				}, {
					canSelectFiles: true,
					canSelectFolders: true,
					canSelectMany: true,
					defaultUri: URI.file('/repos'),
				});
				return selected.shift()!;
			},
			isDirectory: async resource =>
				!resource.fsPath.includes('.'),
			openFiles: async resources => {
				opened.push(`files:${resources.map(resource =>
					resource.fsPath
				).join(',')}`);
			},
			openWindow: async openables => {
				const openable = openables[0];
				if (!isFolderToOpen(openable)) {
					throw new Error('unexpected non-folder openable');
				}
				opened.push(`folder:${openable.folderUri.fsPath}`);
			},
		};

		const firstHandled = await tryPickHucodeOmniFileFolderAndOpen(
			Schemas.file,
			{ defaultUri: URI.file('/repos') },
			{ isOmniWindow: true },
			host
		);
		const secondHandled = await tryPickHucodeOmniFileFolderAndOpen(
			Schemas.file,
			{ defaultUri: URI.file('/repos') },
			{ isHostedOmniWorkspace: true, isOmniWindow: false },
			host
		);

		assert.deepStrictEqual({ firstHandled, secondHandled, opened }, {
			firstHandled: true,
			secondHandled: true,
			opened: [
				'files:/repos/project/README.md,' +
				'/repos/project/package.json',
				'folder:/repos/project',
				'folder:/repos/other',
			],
		});
	});

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
		const host: IHucodeOmniFileFolderDialogHost = {
			showOpenDialog: async () => undefined,
			isDirectory: async () => {
				throw new Error('unexpected stat');
			},
			openFiles: async () => { openCalls++; },
			openWindow: async () => { openCalls++; },
		};
		const fileFolderHandled = await tryPickHucodeOmniFileFolderAndOpen(
			Schemas.file,
			{},
			{ isOmniWindow: false, isHostedOmniWorkspace: true },
			host
		);
		const folderHandled = await tryPickHucodeOmniFolderAndOpen(
			Schemas.file,
			{},
			{ isOmniWindow: false, isHostedOmniWorkspace: true },
			host
		);

		assert.deepStrictEqual({ fileFolderHandled, folderHandled, openCalls }, {
			fileFolderHandled: true,
			folderHandled: true,
			openCalls: 0,
		});
	});

	test('preserves native routing for special and non-Omni opens', async () => {
		const host: IHucodeOmniFileFolderDialogHost = {
			showOpenDialog: async () => {
				throw new Error('unexpected dialog');
			},
			isDirectory: async () => {
				throw new Error('unexpected stat');
			},
			openFiles: async () => {
				throw new Error('unexpected files');
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

		const fileFolderResults = await Promise.all(cases.map(
			([schema, options, env]) =>
				tryPickHucodeOmniFileFolderAndOpen(
					schema,
					options,
					env,
					host
				)
		));
		const folderResults = await Promise.all(cases.map(([schema, options, env]) =>
			tryPickHucodeOmniFolderAndOpen(schema, options, env, host)
		));

		assert.deepStrictEqual(fileFolderResults, [false, false, false, false]);
		assert.deepStrictEqual(folderResults, [false, false, false, false]);
	});
});
