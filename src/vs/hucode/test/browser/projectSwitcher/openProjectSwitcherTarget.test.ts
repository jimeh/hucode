/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { errorHandler } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { IProjectManagerService, ProjectRecord } from
	'../../../../platform/projectManager/common/projectManager.js';
import { IHostService } from
	'../../../../workbench/services/host/browser/host.js';
import { IWorkbenchEnvironmentService } from
	'../../../../workbench/services/environment/common/environmentService.js';
import { IHucodeHostedWorkspaceState, IHucodeShellService } from
	'../../../common/omniWindow.js';
import { IProjectSwitcherSelectionTarget } from
	'../../../common/projectSwitcher/switchProjectWorktreeModel.js';
import { openProjectSwitcherTargetInWindow } from
	'../../../browser/projectSwitcher/openProjectSwitcherTarget.js';

suite('OpenProjectSwitcherTarget', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const target: IProjectSwitcherSelectionTarget = {
		projectId: 'project',
		worktreePath: '/repo',
	};
	const emptyHostedWorkspaceState: IHucodeHostedWorkspaceState = {
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: [],
	};

	function projectManager(
		calls: string[],
		projects: readonly ProjectRecord[] = [createProject()]
	): IProjectManagerService {
		return {
			async getProjects() {
				return projects;
			},
			async setLastActiveWorktree(projectId: string, worktreePath: string) {
				calls.push(`setLastActive:${projectId}:${worktreePath}`);
			}
		} as unknown as IProjectManagerService;
	}

	function environment(
		overrides: Partial<IWorkbenchEnvironmentService>
	): IWorkbenchEnvironmentService {
		return {
			isOmniWindow: false,
			isHostedOmniWorkspace: false,
			...overrides,
		} as IWorkbenchEnvironmentService;
	}

	function host(calls: string[]): IHostService {
		return {
			async openWindow(toOpen: unknown, options: unknown) {
				calls.push(`hostOpen:${JSON.stringify({ toOpen, options })}`);
			}
		} as unknown as IHostService;
	}

	function shell(
		calls: string[],
		focusNormalResult: boolean | Error
	): IHucodeShellService {
		return {
			async focusNormalWindowByPath(worktreePath: string) {
				calls.push(`focusNormal:${worktreePath}`);
				if (focusNormalResult instanceof Error) {
					throw focusNormalResult;
				}
				return focusNormalResult;
			},
			async openWorkspace(
				windowId: number,
				worktreePath: string,
				projectId?: string
			) {
				calls.push(`openWorkspace:${windowId}:${worktreePath}:${projectId}`);
				return emptyHostedWorkspaceState;
			},
			async openAndFocusWorkspace(
				windowId: number,
				worktreePath: string,
				projectId?: string
			) {
				calls.push(
					`openAndFocus:${windowId}:${worktreePath}:${projectId}`
				);
				return emptyHostedWorkspaceState;
			},
			async focusWorkspace(windowId: number) {
				calls.push(`focusWorkspace:${windowId}`);
			},
			async focusHostedWorkspaceByPath(
				worktreePath: string,
				projectId?: string
			) {
				calls.push(`focusHosted:${worktreePath}:${projectId}`);
				return true;
			},
		} as unknown as IHucodeShellService;
	}

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

	test('focuses existing normal window instead of opening in Omni',
		async () => {
			const calls: string[] = [];

			await openProjectSwitcherTargetInWindow(
				target,
				7,
				projectManager(calls),
				environment({ isOmniWindow: true }),
				shell(calls, true),
				host(calls)
			);

			assert.deepStrictEqual(calls, [
				'setLastActive:project:/repo',
				'focusNormal:/repo',
			]);
		}
	);

	test('opens hosted workspace when no normal window owns the worktree',
		async () => {
			const calls: string[] = [];

			await openProjectSwitcherTargetInWindow(
				target,
				7,
				projectManager(calls),
				environment({ isOmniWindow: true }),
				shell(calls, false),
				host(calls)
			);

			assert.deepStrictEqual(calls, [
				'setLastActive:project:/repo',
				'focusNormal:/repo',
				'openWorkspace:7:/repo:project',
				'focusWorkspace:7',
			]);
		}
	);

	test('adopts a promoted path-only target as a project worktree', async () => {
		const calls: string[] = [];

		await openProjectSwitcherTargetInWindow(
			{ worktreePath: '/repo' },
			7,
			projectManager(calls),
			environment({ isOmniWindow: true }),
			shell(calls, false),
			host(calls)
		);

		assert.deepStrictEqual(calls, [
			'setLastActive:project:/repo',
			'focusNormal:/repo',
			'openWorkspace:7:/repo:project',
			'focusWorkspace:7',
		]);
	});

	test('falls back to hosted workspace when normal focus lookup fails',
		async () => {
			const calls: string[] = [];

			await withExpectedUnexpectedError(() =>
				openProjectSwitcherTargetInWindow(
					target,
					7,
					projectManager(calls),
					environment({ isHostedOmniWorkspace: true }),
					shell(calls, new Error('lookup failed')),
					host(calls)
				)
			);

			assert.deepStrictEqual(calls, [
				'setLastActive:project:/repo',
				'focusNormal:/repo',
				'openAndFocus:7:/repo:project',
			]);
		}
	);

	test('uses an atomic open and focus from a hosted workbench', async () => {
		const calls: string[] = [];

		await openProjectSwitcherTargetInWindow(
			target,
			7,
			projectManager(calls),
			environment({ isHostedOmniWorkspace: true }),
			shell(calls, false),
			host(calls)
		);

		assert.deepStrictEqual(calls, [
			'setLastActive:project:/repo',
			'focusNormal:/repo',
			'openAndFocus:7:/repo:project',
		]);
	});

	test('reuses current normal window outside Omni', async () => {
		const calls: string[] = [];
		let opened: unknown;
		let openOptions: unknown;
		const hostService = {
			async openWindow(toOpen: unknown, options: unknown) {
				calls.push('hostOpen');
				opened = toOpen;
				openOptions = options;
			}
		} as unknown as IHostService;

		await openProjectSwitcherTargetInWindow(
			target,
			7,
			projectManager(calls),
			environment({}),
			shell(calls, false),
			hostService
		);

		assert.deepStrictEqual(calls, [
			'setLastActive:project:/repo',
			'hostOpen',
		]);
		assert.deepStrictEqual(opened, [{ folderUri: URI.file('/repo') }]);
		assert.deepStrictEqual(openOptions, { forceReuseWindow: true });
	});
});

function createProject(): ProjectRecord {
	return {
		id: 'project',
		label: 'Project',
		rootUri: URI.file('/repo'),
		pinned: false,
		order: 0,
		worktreeState: 'current',
		worktrees: [{
			path: '/repo',
			label: 'repo',
			isMain: true,
			isDetached: false,
		}],
	};
}
