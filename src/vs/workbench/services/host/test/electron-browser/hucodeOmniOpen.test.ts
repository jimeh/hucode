/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IProjectManagerService, ProjectRecord, WorktreeRecord } from '../../../../../platform/projectManager/common/projectManager.js';
import { IOpenWindowOptions, IWindowOpenable } from '../../../../../platform/window/common/window.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IHucodeOmniOpenShellService, tryOpenHucodeOmniWindow } from '../../electron-browser/hucodeOmniOpen.js';

suite('HucodeOmniOpen', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const worktree = (path: string): WorktreeRecord => ({
		path,
		label: path.split('/').at(-1) ?? path,
		isMain: false,
		isDetached: false
	});

	const project = (
		id: string,
		worktrees: readonly WorktreeRecord[]
	): ProjectRecord => ({
		id,
		label: id,
		rootUri: URI.file(`/projects/${id}`),
		pinned: false,
		order: 0,
		worktrees
	});

	const createNativeHostService = () => {
		const openWindowCalls: {
			toOpen: IWindowOpenable[];
			options?: IOpenWindowOptions;
		}[] = [];

		return {
			service: {
				windowId: 7,
				async openWindow(
					toOpen: IWindowOpenable[],
					options?: IOpenWindowOptions
				): Promise<void> {
					openWindowCalls.push({ toOpen, options });
				}
			} as Partial<INativeHostService> as INativeHostService,
			openWindowCalls,
		};
	};

	const createProjectManagerService = (
		projects: readonly ProjectRecord[]
	) => {
		const setLastActiveWorktreeCalls: {
			projectId: string;
			worktreePath: string;
		}[] = [];

		return {
			service: {
				async getProjects(): Promise<readonly ProjectRecord[]> {
					return projects;
				},
				async setLastActiveWorktree(
					projectId: string,
					worktreePath: string
				): Promise<void> {
					setLastActiveWorktreeCalls.push({
						projectId,
						worktreePath
					});
				}
			} as Partial<IProjectManagerService> as IProjectManagerService,
			setLastActiveWorktreeCalls,
		};
	};

	const createShellService = () => {
		const openWorkspaceCalls: {
			windowId: number;
			worktreePath: string;
			projectId?: string;
		}[] = [];
		const focusWorkspaceCalls: number[] = [];

		return {
			service: {
				async openWorkspace(
					windowId: number,
					worktreePath: string,
					projectId?: string
				): Promise<unknown> {
					openWorkspaceCalls.push({
						windowId,
						worktreePath,
						projectId
					});
					return {};
				},
				async focusWorkspace(windowId: number): Promise<void> {
					focusWorkspaceCalls.push(windowId);
				}
			} satisfies IHucodeOmniOpenShellService,
			openWorkspaceCalls,
			focusWorkspaceCalls,
		};
	};

	const environment = (
		options: {
			isOmniWindow?: boolean;
			isHostedOmniWorkspace?: boolean;
		}
	): IWorkbenchEnvironmentService =>
		options as Partial<IWorkbenchEnvironmentService> as IWorkbenchEnvironmentService;

	test('does nothing outside Omni windows', async () => {
		const nativeHost = createNativeHostService();
		const projectManager = createProjectManagerService([
			project('project', [worktree('/repo')])
		]);
		const shell = createShellService();

		assert.strictEqual(
			await tryOpenHucodeOmniWindow(
				[{ folderUri: URI.file('/repo') }],
				undefined,
				nativeHost.service,
				environment({}),
				shell.service,
				projectManager.service
			),
			false
		);
		assert.deepStrictEqual(shell.openWorkspaceCalls, []);
		assert.deepStrictEqual(nativeHost.openWindowCalls, []);
		assert.deepStrictEqual(projectManager.setLastActiveWorktreeCalls, []);
	});

	test('opens known folders inside the Omni hosted workspace', async () => {
		const nativeHost = createNativeHostService();
		const projectManager = createProjectManagerService([
			project('project', [worktree('/repo')])
		]);
		const shell = createShellService();

		assert.strictEqual(
			await tryOpenHucodeOmniWindow(
				[{ folderUri: URI.file('/repo') }],
				undefined,
				nativeHost.service,
				environment({ isOmniWindow: true }),
				shell.service,
				projectManager.service
			),
			true
		);
		assert.deepStrictEqual(
			projectManager.setLastActiveWorktreeCalls,
			[{ projectId: 'project', worktreePath: '/repo' }]
		);
		assert.deepStrictEqual(shell.openWorkspaceCalls, [{
			windowId: nativeHost.service.windowId,
			worktreePath: '/repo',
			projectId: 'project'
		}]);
		assert.deepStrictEqual(
			shell.focusWorkspaceCalls,
			[nativeHost.service.windowId]
		);
		assert.deepStrictEqual(nativeHost.openWindowCalls, []);
	});

	test('falls back to a new window for unknown folders', async () => {
		const nativeHost = createNativeHostService();
		const projectManager = createProjectManagerService([]);
		const shell = createShellService();
		const toOpen = [{ folderUri: URI.file('/outside') }];

		assert.strictEqual(
			await tryOpenHucodeOmniWindow(
				toOpen,
				{ forceReuseWindow: true },
				nativeHost.service,
				environment({ isHostedOmniWorkspace: true }),
				shell.service,
				projectManager.service
			),
			true
		);
		assert.deepStrictEqual(shell.openWorkspaceCalls, []);
		assert.deepStrictEqual(nativeHost.openWindowCalls, [{
			toOpen,
			options: { forceNewWindow: true }
		}]);
	});

	test('falls back to a new window for workspace files', async () => {
		const nativeHost = createNativeHostService();
		const projectManager = createProjectManagerService([]);
		const shell = createShellService();
		const toOpen = [{ workspaceUri: URI.file('/repo/code.code-workspace') }];

		assert.strictEqual(
			await tryOpenHucodeOmniWindow(
				toOpen,
				undefined,
				nativeHost.service,
				environment({ isOmniWindow: true }),
				shell.service,
				projectManager.service
			),
			true
		);
		assert.deepStrictEqual(nativeHost.openWindowCalls, [{
			toOpen,
			options: { forceNewWindow: true }
		}]);
	});

	test('does not handle forced or multi-resource open requests', async () => {
		const nativeHost = createNativeHostService();
		const projectManager = createProjectManagerService([
			project('project', [worktree('/repo')])
		]);
		const shell = createShellService();
		const blockedOptions: IOpenWindowOptions[] = [
			{ forceNewWindow: true },
			{ addMode: true },
			{ removeMode: true },
			{ diffMode: true },
			{ mergeMode: true },
			{ gotoLineMode: true },
			{ waitMarkerFileURI: URI.file('/tmp/wait') },
		];

		for (const options of blockedOptions) {
			assert.strictEqual(
				await tryOpenHucodeOmniWindow(
					[{ folderUri: URI.file('/repo') }],
					options,
					nativeHost.service,
					environment({ isOmniWindow: true }),
					shell.service,
					projectManager.service
				),
				false
			);
		}

		assert.strictEqual(
			await tryOpenHucodeOmniWindow(
				[
					{ folderUri: URI.file('/repo') },
					{ folderUri: URI.file('/repo2') }
				],
				undefined,
				nativeHost.service,
				environment({ isOmniWindow: true }),
				shell.service,
				projectManager.service
			),
			false
		);
		assert.deepStrictEqual(shell.openWorkspaceCalls, []);
		assert.deepStrictEqual(nativeHost.openWindowCalls, []);
		assert.deepStrictEqual(projectManager.setLastActiveWorktreeCalls, []);
	});
});
