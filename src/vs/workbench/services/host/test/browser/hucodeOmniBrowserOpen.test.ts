/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { errorHandler } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../../base/test/common/utils.js';
import {
	IHucodeOmniBrowserEnvironment,
	IHucodeOmniBrowserProjectManager,
	tryNavigateHucodeHostedBrowserWindow,
	tryOpenHucodeOmniBrowserWindow,
} from
	'../../browser/hucodeOmniBrowserOpen.js';
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
	withHucodeHostedShellCachedAvailability,
} from '../../../../../platform/window/common/hucodeHostedShellService.js';

suite('HucodeOmniBrowserOpen', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const environment = (
		overrides: IHucodeOmniBrowserEnvironment = {}
	): IHucodeOmniBrowserEnvironment => overrides;

	const projectManager = (
		projects: readonly {
			readonly id: string;
			readonly worktrees: readonly { readonly path: string }[];
		}[] = []
	): IHucodeOmniBrowserProjectManager => ({
		async getProjects() { return projects; },
		async setLastActiveWorktree() { },
	});

	const shellService = (
	): Parameters<typeof tryOpenHucodeOmniBrowserWindow>[3] => ({
		_serviceBrand: undefined,
		async focusHostedWorkspaceByPath() { return false; },
		async focusNormalWindowByPath() { return false; },
		async openWorkspace() { },
		async openAndFocusWorkspace() { },
		async focusWorkspace() { },
	});

	test('routes arbitrary folders into a retained hosted workbench', async () => {
		const calls: string[] = [];
		const handled = await tryOpenHucodeOmniBrowserWindow(
			[{ folderUri: URI.file('/scratch') }],
			undefined,
			environment({ isOmniWindow: true }),
			{
				_serviceBrand: undefined,
				async focusHostedWorkspaceByPath(path: string) {
					calls.push(`hosted:${path}`);
					return false;
				},
				async focusNormalWindowByPath(path: string) {
					calls.push(`normal:${path}`);
					return false;
				},
				async openWorkspace(
					windowId: number,
					path: string,
					projectId?: string
				) {
					calls.push(`open:${windowId}:${path}:${projectId}`);
				},
				async openAndFocusWorkspace() { },
				async focusWorkspace(windowId: number) {
					calls.push(`focus:${windowId}`);
				},
			},
			projectManager()
		);

		assert.strictEqual(handled, true);
		assert.deepStrictEqual(calls, [
			'hosted:/scratch',
			'normal:/scratch',
			'open:1:/scratch:undefined',
			'focus:1',
		]);
	});

	test('matches projects with configured case-insensitive server paths',
		async () => {
			let openedProjectId: string | undefined;
			let openedPath: string | undefined;
			await tryOpenHucodeOmniBrowserWindow(
				[{ folderUri: URI.file('/repos/PROJECT') }],
				undefined,
				environment({
					isOmniWindow: true,
					options: { hucodeServerPathCaseSensitive: false },
				}),
				{
					_serviceBrand: undefined,
					async focusHostedWorkspaceByPath() { return false; },
					async focusNormalWindowByPath() { return false; },
					async openWorkspace(_windowId, path, projectId) {
						openedPath = path;
						openedProjectId = projectId;
					},
					async openAndFocusWorkspace() { },
					async focusWorkspace() { },
				},
				projectManager([{
					id: 'project',
					worktrees: [{ path: '/repos/project' }],
				}])
			);

			assert.strictEqual(openedProjectId, 'project');
			assert.strictEqual(openedPath, '/repos/project');
		});

	test('focuses an existing hosted workbench without opening a duplicate',
		async () => {
			let opened = false;
			const handled = await tryOpenHucodeOmniBrowserWindow(
				[{ folderUri: URI.file('/scratch') }],
				undefined,
				environment({ isOmniWindow: true }),
				{
					_serviceBrand: undefined,
					async focusHostedWorkspaceByPath() { return true; },
					async focusNormalWindowByPath() { return false; },
					async openWorkspace() { opened = true; },
					async openAndFocusWorkspace() { opened = true; },
					async focusWorkspace() { },
				},
				projectManager()
			);

			assert.strictEqual(handled, true);
			assert.strictEqual(opened, false);
		});

	test('leaves explicit new-window requests to upstream browser handling',
		async () => {
			const handled = await tryOpenHucodeOmniBrowserWindow(
				[{ folderUri: URI.file('/scratch') }],
				{ forceNewWindow: true },
				environment({ isOmniWindow: true }),
				shellService(),
				projectManager()
			);

			assert.strictEqual(handled, false);
		});

	test('leaves profile-carrying requests to upstream browser handling',
		async () => {
			const handled = await tryOpenHucodeOmniBrowserWindow(
				[{ folderUri: URI.file('/scratch') }],
				{ forceProfile: 'Development' },
				environment({ isOmniWindow: true }),
				shellService(),
				projectManager()
			);

			assert.strictEqual(handled, false);
		});

	test('leaves virtual-provider folders to upstream browser handling',
		async () => {
			const handled = await tryOpenHucodeOmniBrowserWindow(
				[{ folderUri: URI.from({ scheme: 'memfs', path: '/scratch' }) }],
				undefined,
				environment({ isOmniWindow: true }),
				shellService(),
				projectManager()
			);

			assert.strictEqual(handled, false);
		});

	test('leaves multi-folder requests to upstream browser handling', async () => {
		const handled = await tryOpenHucodeOmniBrowserWindow(
			[
				{ folderUri: URI.file('/first') },
				{ folderUri: URI.file('/second') },
			],
			undefined,
			environment({ isOmniWindow: true }),
			shellService(),
			projectManager()
		);

		assert.strictEqual(handled, false);
	});

	test('leaves folders from another remote authority to upstream', async () => {
		const handled = await tryOpenHucodeOmniBrowserWindow(
			[{
				folderUri: URI.from({
					scheme: Schemas.vscodeRemote,
					authority: 'ssh-remote+other',
					path: '/scratch',
				}),
			}],
			undefined,
			environment({
				isOmniWindow: true,
				remoteAuthority: 'ssh-remote+host',
			}),
			shellService(),
			projectManager()
		);

		assert.strictEqual(handled, false);
	});

	test('routes folder opens from a hosted Omni workbench', async () => {
		let opened: URI | undefined;
		const handled = await tryNavigateHucodeHostedBrowserWindow(
			[{ folderUri: URI.file('/scratch') }],
			undefined,
			environment({ isHostedOmniWorkspace: true }),
			{
				_serviceBrand: undefined,
				onDidChangeState: Event.None,
				async navigateToFolder(request) {
					opened = URI.revive(request.folderUri);
					return HucodeHostedShellOperationOutcome.Accepted;
				},
			} as Partial<IHucodeHostedShellService> as IHucodeHostedShellService
		);

		assert.strictEqual(handled, true);
		assert.strictEqual(opened?.fsPath, '/scratch');
	});

	test('fails closed when a hosted folder capability is unavailable',
		async () => {
			const originalHandler = errorHandler.getUnexpectedErrorHandler();
			const errors: unknown[] = [];
			errorHandler.setUnexpectedErrorHandler(error => errors.push(error));
			try {
				for (const outcome of [
					HucodeHostedShellOperationOutcome.Unavailable,
					HucodeHostedShellOperationOutcome.Rejected,
					HucodeHostedShellOperationOutcome.Stale,
				]) {
					const expectedErrorCount = errors.length + 1;
					assert.strictEqual(await tryNavigateHucodeHostedBrowserWindow(
						[{ folderUri: URI.file('/scratch') }],
						undefined,
						environment({ isHostedOmniWorkspace: true }),
						{
							_serviceBrand: undefined,
							onDidChangeState: Event.None,
							async navigateToFolder() { return outcome; },
						} as Partial<IHucodeHostedShellService> as
						IHucodeHostedShellService
					), true);
					assert.strictEqual(errors.length, expectedErrorCount);
					assert.ok(String(errors.at(-1)).includes(outcome));
				}

				assert.strictEqual(await tryNavigateHucodeHostedBrowserWindow(
					[{ folderUri: URI.file('/scratch') }],
					undefined,
					environment({ isHostedOmniWorkspace: true }),
					{
						_serviceBrand: undefined,
						onDidChangeState: Event.None,
						async navigateToFolder() {
							return HucodeHostedShellOperationOutcome.Superseded;
						},
					} as Partial<IHucodeHostedShellService> as
					IHucodeHostedShellService
				), true);
				assert.strictEqual(errors.length, 3);

				assert.strictEqual(await tryNavigateHucodeHostedBrowserWindow(
					[{
						folderUri: URI.from({
							scheme: 'memfs', path: '/scratch',
						}),
					}],
					undefined,
					environment({ isHostedOmniWorkspace: true }),
					{
						_serviceBrand: undefined,
						onDidChangeState: Event.None,
						async navigateToFolder() {
							return HucodeHostedShellOperationOutcome.Unsupported;
						},
					} as Partial<IHucodeHostedShellService> as
					IHucodeHostedShellService
				), false);
				assert.strictEqual(errors.length, 3);
			} finally {
				errorHandler.setUnexpectedErrorHandler(originalHandler);
			}
		});

	test('fails fast while the hosted shell transport is unavailable',
		async () => {
			const originalHandler = errorHandler.getUnexpectedErrorHandler();
			const errors: unknown[] = [];
			let navigationCalls = 0;
			errorHandler.setUnexpectedErrorHandler(error => errors.push(error));
			try {
				const hostedShellService =
					withHucodeHostedShellCachedAvailability({
						_serviceBrand: undefined,
						onDidChangeState: Event.None,
						async navigateToFolder() {
							navigationCalls++;
							return HucodeHostedShellOperationOutcome.Accepted;
						},
					} as Partial<IHucodeHostedShellService> as
						IHucodeHostedShellService, () => false);
				assert.strictEqual(await tryNavigateHucodeHostedBrowserWindow(
					[{ folderUri: URI.file('/scratch') }],
					undefined,
					environment({ isHostedOmniWorkspace: true }),
					hostedShellService
				), true);
				assert.strictEqual(navigationCalls, 0);
				assert.strictEqual(errors.length, 1);
				assert.ok(String(errors[0]).includes(
					'Hosted Omni folder navigation is unavailable.'
				));
			} finally {
				errorHandler.setUnexpectedErrorHandler(originalHandler);
			}
		});

	test('routes folders for the current remote authority', async () => {
		let openedPath: string | undefined;
		const handled = await tryOpenHucodeOmniBrowserWindow(
			[{
				folderUri: URI.from({
					scheme: Schemas.vscodeRemote,
					authority: 'ssh-remote+host',
					path: '/scratch',
				}),
			}],
			undefined,
			environment({
				isOmniWindow: true,
				remoteAuthority: 'ssh-remote+host',
			}),
			{
				_serviceBrand: undefined,
				async focusHostedWorkspaceByPath() { return false; },
				async focusNormalWindowByPath() { return false; },
				async openWorkspace(_windowId, path) { openedPath = path; },
				async openAndFocusWorkspace() { },
				async focusWorkspace() { },
			},
			projectManager()
		);

		assert.strictEqual(handled, true);
		assert.strictEqual(openedPath, '/scratch');
	});
});
