/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../../base/test/common/utils.js';
import { IProjectManagerService } from
	'../../../../../platform/projectManager/common/projectManager.js';
import { IBrowserWorkbenchEnvironmentService } from
	'../../../../services/environment/browser/environmentService.js';
import { tryOpenHucodeOmniBrowserWindow } from
	'../../browser/hucodeOmniBrowserOpen.js';

suite('HucodeOmniBrowserOpen', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('routes arbitrary folders into a retained hosted workbench', async () => {
		const calls: string[] = [];
		const handled = await tryOpenHucodeOmniBrowserWindow(
			[{ folderUri: URI.file('/scratch') }],
			undefined,
			{ isOmniWindow: true } as IBrowserWorkbenchEnvironmentService,
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
				async focusWorkspace(windowId: number) {
					calls.push(`focus:${windowId}`);
				},
			},
			{
				async getProjects() { return []; },
			} as unknown as IProjectManagerService
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
				{
					isOmniWindow: true,
					options: { hucodeServerPathCaseSensitive: false },
				} as unknown as IBrowserWorkbenchEnvironmentService,
				{
					_serviceBrand: undefined,
					async focusHostedWorkspaceByPath() { return false; },
					async focusNormalWindowByPath() { return false; },
					async openWorkspace(_windowId, path, projectId) {
						openedPath = path;
						openedProjectId = projectId;
					},
					async focusWorkspace() { },
				},
				{
					async getProjects() {
						return [{
							id: 'project',
							worktrees: [{ path: '/repos/project' }],
						}];
					},
					async setLastActiveWorktree() { },
				} as unknown as IProjectManagerService
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
				{ isOmniWindow: true } as IBrowserWorkbenchEnvironmentService,
				{
					_serviceBrand: undefined,
					async focusHostedWorkspaceByPath() { return true; },
					async focusNormalWindowByPath() { return false; },
					async openWorkspace() { opened = true; },
					async focusWorkspace() { },
				},
				{
					async getProjects() { return []; },
				} as unknown as IProjectManagerService
			);

			assert.strictEqual(handled, true);
			assert.strictEqual(opened, false);
		});

	test('leaves explicit new-window requests to upstream browser handling',
		async () => {
			const handled = await tryOpenHucodeOmniBrowserWindow(
				[{ folderUri: URI.file('/scratch') }],
				{ forceNewWindow: true },
				{ isOmniWindow: true } as IBrowserWorkbenchEnvironmentService,
				{} as Parameters<typeof tryOpenHucodeOmniBrowserWindow>[3],
				{} as IProjectManagerService
			);

			assert.strictEqual(handled, false);
		});

	test('leaves profile-carrying requests to upstream browser handling',
		async () => {
			const handled = await tryOpenHucodeOmniBrowserWindow(
				[{ folderUri: URI.file('/scratch') }],
				{ forceProfile: 'Development' },
				{ isOmniWindow: true } as IBrowserWorkbenchEnvironmentService,
				{} as Parameters<typeof tryOpenHucodeOmniBrowserWindow>[3],
				{} as IProjectManagerService
			);

			assert.strictEqual(handled, false);
		});

	test('leaves virtual-provider folders to upstream browser handling',
		async () => {
			const handled = await tryOpenHucodeOmniBrowserWindow(
				[{ folderUri: URI.from({ scheme: 'memfs', path: '/scratch' }) }],
				undefined,
				{ isOmniWindow: true } as IBrowserWorkbenchEnvironmentService,
				{} as Parameters<typeof tryOpenHucodeOmniBrowserWindow>[3],
				{} as IProjectManagerService
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
			{ isOmniWindow: true } as IBrowserWorkbenchEnvironmentService,
			{} as Parameters<typeof tryOpenHucodeOmniBrowserWindow>[3],
			{} as IProjectManagerService
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
			{
				isOmniWindow: true,
				remoteAuthority: 'ssh-remote+host',
			} as IBrowserWorkbenchEnvironmentService,
			{} as Parameters<typeof tryOpenHucodeOmniBrowserWindow>[3],
			{} as IProjectManagerService
		);

		assert.strictEqual(handled, false);
	});

	test('routes folder opens from a hosted Omni workbench', async () => {
		let opened = false;
		const handled = await tryOpenHucodeOmniBrowserWindow(
			[{ folderUri: URI.file('/scratch') }],
			undefined,
			{
				isHostedOmniWorkspace: true,
			} as IBrowserWorkbenchEnvironmentService,
			{
				_serviceBrand: undefined,
				async focusHostedWorkspaceByPath() { return false; },
				async focusNormalWindowByPath() { return false; },
				async openWorkspace() { opened = true; },
				async focusWorkspace() { },
			},
			{
				async getProjects() { return []; },
			} as unknown as IProjectManagerService
		);

		assert.strictEqual(handled, true);
		assert.strictEqual(opened, true);
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
			{
				isOmniWindow: true,
				remoteAuthority: 'ssh-remote+host',
			} as IBrowserWorkbenchEnvironmentService,
			{
				_serviceBrand: undefined,
				async focusHostedWorkspaceByPath() { return false; },
				async focusNormalWindowByPath() { return false; },
				async openWorkspace(_windowId, path) { openedPath = path; },
				async focusWorkspace() { },
			},
			{
				async getProjects() { return []; },
			} as unknown as IProjectManagerService
		);

		assert.strictEqual(handled, true);
		assert.strictEqual(openedPath, '/scratch');
	});
});
