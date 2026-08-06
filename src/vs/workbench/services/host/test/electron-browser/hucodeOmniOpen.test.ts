/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { errorHandler } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IProjectManagerService, ProjectRecord, WorktreeRecord } from '../../../../../platform/projectManager/common/projectManager.js';
import { IOpenWindowOptions, IWindowOpenable } from '../../../../../platform/window/common/window.js';
import {
	HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
} from '../../../../../platform/window/common/hucodeHostedShellService.js';
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
		worktreeState: 'current',
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
			worktreePath: string;
			projectId?: string;
		}[] = [];
		const focusWorkspaceCalls: string[] = [];
		const focusHostedWorkspaceByPathCalls: string[] = [];
		const focusNormalWindowByPathCalls: string[] = [];
		const hostedWorkspacePaths = new Set<string>();
		const normalWindowPaths = new Set<string>();
		let focusNormalWindowByPathError: Error | undefined;

		return {
			service: {
				async focusHostedWorkspaceByPath(
					worktreePath: string
				): Promise<boolean> {
					focusHostedWorkspaceByPathCalls.push(worktreePath);
					return hostedWorkspacePaths.has(worktreePath);
				},
				async focusNormalWindowByPath(
					worktreePath: string
				): Promise<boolean> {
					focusNormalWindowByPathCalls.push(worktreePath);
					if (focusNormalWindowByPathError) {
						throw focusNormalWindowByPathError;
					}

					return normalWindowPaths.has(worktreePath);
				},
				async openWorkspace(
					worktreePath: string,
					projectId?: string
				): Promise<unknown> {
					openWorkspaceCalls.push({
						worktreePath,
						projectId
					});
					return {};
				},
				async focusWorkspace(): Promise<void> {
					focusWorkspaceCalls.push('focus');
				}
			} satisfies IHucodeOmniOpenShellService,
			openWorkspaceCalls,
			focusWorkspaceCalls,
			focusHostedWorkspaceByPathCalls,
			focusNormalWindowByPathCalls,
			hostedWorkspacePaths,
			normalWindowPaths,
			setFocusNormalWindowByPathError(error: Error): void {
				focusNormalWindowByPathError = error;
			},
		};
	};

	const unavailable = async () =>
		HucodeHostedShellOperationOutcome.Unavailable;
	let hostedNavigationCalls: URI[];
	let hostedNavigationOutcome: HucodeHostedShellOperationOutcome;
	let hostedShellService: IHucodeHostedShellService;
	setup(() => {
		hostedNavigationCalls = [];
		hostedNavigationOutcome = HucodeHostedShellOperationOutcome.Accepted;
		hostedShellService = {
			_serviceBrand: undefined,
			onDidChangeState: Event.None,
			getState: async () => HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
			notifyReady: async () => ({
				outcome: HucodeHostedShellOperationOutcome.Unavailable,
			}),
			closeSelf: unavailable,
			reopenSelfInNormalWindow: unavailable,
			reloadSelf: unavailable,
			focusSelf: unavailable,
			focusShell: unavailable,
			requestShellAction: unavailable,
			async navigateToFolder(request) {
				hostedNavigationCalls.push(URI.revive(request.folderUri));
				return hostedNavigationOutcome;
			},
			triggerPasteInSelf: unavailable,
			captureSelfScreenshot: async () => undefined,
		};
	});

	const environment = (
		options: {
			isOmniWindow?: boolean;
			isHostedOmniWorkspace?: boolean;
		}
	): IWorkbenchEnvironmentService =>
		options as Partial<IWorkbenchEnvironmentService> as IWorkbenchEnvironmentService;

	const withExpectedUnexpectedError = async <T>(
		callback: () => Promise<T>
	): Promise<T> => {
		const originalHandler = errorHandler.getUnexpectedErrorHandler();
		const errors: unknown[] = [];
		errorHandler.setUnexpectedErrorHandler(error => errors.push(error));
		try {
			const result = await callback();
			assert.strictEqual(errors.length, 1);
			return result;
		} finally {
			errorHandler.setUnexpectedErrorHandler(originalHandler);
		}
	};

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
				hostedShellService,
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
				hostedShellService,
				projectManager.service
			),
			true
		);
		assert.deepStrictEqual(
			shell.focusNormalWindowByPathCalls,
			['/repo']
		);
		assert.deepStrictEqual(
			projectManager.setLastActiveWorktreeCalls,
			[{ projectId: 'project', worktreePath: '/repo' }]
		);
		assert.deepStrictEqual(shell.openWorkspaceCalls, [{
			worktreePath: '/repo',
			projectId: 'project'
		}]);
		assert.deepStrictEqual(
			shell.focusWorkspaceCalls,
			['focus']
		);
		assert.deepStrictEqual(nativeHost.openWindowCalls, []);
	});

	test('focuses an existing normal window for known folders', async () => {
		const nativeHost = createNativeHostService();
		const projectManager = createProjectManagerService([
			project('project', [worktree('/repo')])
		]);
		const shell = createShellService();
		shell.normalWindowPaths.add('/repo');

		assert.strictEqual(
			await tryOpenHucodeOmniWindow(
				[{ folderUri: URI.file('/repo') }],
				undefined,
				nativeHost.service,
				environment({ isOmniWindow: true }),
				shell.service,
				hostedShellService,
				projectManager.service
			),
			true
		);
		assert.deepStrictEqual(shell.focusNormalWindowByPathCalls, ['/repo']);
		assert.deepStrictEqual(shell.openWorkspaceCalls, []);
		assert.deepStrictEqual(shell.focusWorkspaceCalls, []);
		assert.deepStrictEqual(
			projectManager.setLastActiveWorktreeCalls,
			[{ projectId: 'project', worktreePath: '/repo' }]
		);
		assert.deepStrictEqual(nativeHost.openWindowCalls, []);
	});

	test('focuses an existing hosted workbench before opening a duplicate',
		async () => {
			const nativeHost = createNativeHostService();
			const projectManager = createProjectManagerService([
				project('project', [worktree('/outside')])
			]);
			const shell = createShellService();
			shell.hostedWorkspacePaths.add('/outside');

			const handled = await tryOpenHucodeOmniWindow(
				[{ folderUri: URI.file('/outside') }],
				undefined,
				nativeHost.service,
				environment({ isOmniWindow: true }),
				shell.service,
				hostedShellService,
				projectManager.service
			);
			assert.deepStrictEqual({
				handled,
				focusHosted: shell.focusHostedWorkspaceByPathCalls,
				focusNormal: shell.focusNormalWindowByPathCalls,
				openWorkspace: shell.openWorkspaceCalls,
				setLastActive: projectManager.setLastActiveWorktreeCalls,
			}, {
				handled: true,
				focusHosted: ['/outside'],
				focusNormal: [],
				openWorkspace: [],
				setLastActive: [{
					projectId: 'project',
					worktreePath: '/outside',
				}],
			});
		});

	test('opens known folders in Omni when normal-window lookup fails', async () => {
		const nativeHost = createNativeHostService();
		const projectManager = createProjectManagerService([
			project('project', [worktree('/repo')])
		]);
		const shell = createShellService();
		shell.setFocusNormalWindowByPathError(new Error('lookup failed'));

		await withExpectedUnexpectedError(async () =>
			assert.strictEqual(
				await tryOpenHucodeOmniWindow(
					[{ folderUri: URI.file('/repo') }],
					undefined,
					nativeHost.service,
					environment({ isOmniWindow: true }),
					shell.service,
					hostedShellService,
					projectManager.service
				),
				true
			)
		);
		assert.deepStrictEqual(shell.focusNormalWindowByPathCalls, ['/repo']);
		assert.deepStrictEqual(shell.openWorkspaceCalls, [{
			worktreePath: '/repo',
			projectId: 'project'
		}]);
		assert.deepStrictEqual(nativeHost.openWindowCalls, []);
	});

	test('routes hosted folder opens through the bound capability', async () => {
		const nativeHost = createNativeHostService();
		const projectManager = createProjectManagerService([]);
		const shell = createShellService();
		const toOpen = [{ folderUri: URI.file('/outside') }];

		const handled = await tryOpenHucodeOmniWindow(
			toOpen,
			{ forceReuseWindow: true },
			nativeHost.service,
			environment({ isHostedOmniWorkspace: true }),
			shell.service,
			hostedShellService,
			projectManager.service
		);
		assert.deepStrictEqual({
			handled,
			hostedNavigation: hostedNavigationCalls.map(uri => uri.fsPath),
			openWorkspace: shell.openWorkspaceCalls,
			focusWorkspace: shell.focusWorkspaceCalls,
			openWindow: nativeHost.openWindowCalls,
		}, {
			handled: true,
			hostedNavigation: ['/outside'],
			openWorkspace: [],
			focusWorkspace: [],
			openWindow: [],
		});
	});

	test('reports hosted folder opens that the bound capability drops',
		async () => {
			const nativeHost = createNativeHostService();
			const projectManager = createProjectManagerService([]);
			const shell = createShellService();
			hostedNavigationOutcome =
				HucodeHostedShellOperationOutcome.Unavailable;

			await withExpectedUnexpectedError(async () =>
				assert.strictEqual(await tryOpenHucodeOmniWindow(
					[{ folderUri: URI.file('/outside') }],
					undefined,
					nativeHost.service,
					environment({ isHostedOmniWorkspace: true }),
					shell.service,
					hostedShellService,
					projectManager.service
				), true)
			);
			assert.deepStrictEqual(nativeHost.openWindowCalls, []);

			const originalHandler = errorHandler.getUnexpectedErrorHandler();
			const errors: unknown[] = [];
			errorHandler.setUnexpectedErrorHandler(error => errors.push(error));
			try {
				hostedNavigationOutcome =
					HucodeHostedShellOperationOutcome.Superseded;
				assert.strictEqual(await tryOpenHucodeOmniWindow(
					[{ folderUri: URI.file('/newer-intent-won') }],
					undefined,
					nativeHost.service,
					environment({ isHostedOmniWorkspace: true }),
					shell.service,
					hostedShellService,
					projectManager.service
				), true);
				assert.deepStrictEqual(errors, []);
			} finally {
				errorHandler.setUnexpectedErrorHandler(originalHandler);
			}
		});

	test('leaves remote folders for native window handling', async () => {
		const nativeHost = createNativeHostService();
		const projectManager = createProjectManagerService([]);
		const shell = createShellService();

		const handled = await tryOpenHucodeOmniWindow(
			[{
				folderUri: URI.parse(
					'vscode-remote://ssh-remote+host/repo'
				),
			}],
			undefined,
			nativeHost.service,
			environment({ isOmniWindow: true }),
			shell.service,
			hostedShellService,
			projectManager.service
		);
		assert.deepStrictEqual({
			handled,
			focusHosted: shell.focusHostedWorkspaceByPathCalls,
			focusNormal: shell.focusNormalWindowByPathCalls,
			openWorkspace: shell.openWorkspaceCalls,
			openWindow: nativeHost.openWindowCalls,
			setLastActive: projectManager.setLastActiveWorktreeCalls,
		}, {
			handled: false,
			focusHosted: [],
			focusNormal: [],
			openWorkspace: [],
			openWindow: [],
			setLastActive: [],
		});
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
				hostedShellService,
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
			{ forceProfile: 'Development' },
			{ forceTempProfile: true },
			{ chatSessionToOpen: URI.file('/tmp/chat') },
		];

		for (const options of blockedOptions) {
			assert.strictEqual(
				await tryOpenHucodeOmniWindow(
					[{ folderUri: URI.file('/repo') }],
					options,
					nativeHost.service,
					environment({ isOmniWindow: true }),
					shell.service,
					hostedShellService,
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
				hostedShellService,
				projectManager.service
			),
			false
		);

		assert.strictEqual(
			await tryOpenHucodeOmniWindow(
				[{ folderUri: URI.file('/repo') }],
				undefined,
				nativeHost.service,
				{
					...environment({ isOmniWindow: true }),
					extensionDevelopmentLocationURI: [
						URI.file('/extension'),
					],
				},
				shell.service,
				hostedShellService,
				projectManager.service
			),
			false
		);
		assert.deepStrictEqual(shell.openWorkspaceCalls, []);
		assert.deepStrictEqual(nativeHost.openWindowCalls, []);
		assert.deepStrictEqual(projectManager.setLastActiveWorktreeCalls, []);
	});
});
