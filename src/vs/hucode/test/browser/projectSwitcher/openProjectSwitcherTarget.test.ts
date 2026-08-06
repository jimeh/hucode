/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { IProjectManagerService, ProjectRecord } from
	'../../../../platform/projectManager/common/projectManager.js';
import { IHostService } from
	'../../../../workbench/services/host/browser/host.js';
import { IWorkbenchEnvironmentService } from
	'../../../../workbench/services/environment/common/environmentService.js';
import { IHucodeHostedWorkspaceState } from
	'../../../common/omniWindow.js';
import { IHucodeShellControllerService } from
	'../../../../platform/window/common/hucodeShellControllerService.js';
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
	withHucodeHostedShellCachedAvailability,
} from '../../../../platform/window/common/hucodeHostedShellService.js';
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
	): IHucodeShellControllerService {
		return {
			async focusNormalWindowByPath(worktreePath: string) {
				calls.push(`focusNormal:${worktreePath}`);
				if (focusNormalResult instanceof Error) {
					throw focusNormalResult;
				}
				return focusNormalResult;
			},
			async openWorkspace(
				worktreePath: string,
				projectId?: string
			) {
				calls.push(`openWorkspace:${worktreePath}:${projectId}`);
				return emptyHostedWorkspaceState;
			},
			async focusWorkspace() {
				calls.push('focusWorkspace');
			},
			async focusHostedWorkspaceByPath(
				worktreePath: string,
				projectId?: string
			) {
				calls.push(`focusHosted:${worktreePath}:${projectId}`);
				return true;
			},
		} as unknown as IHucodeShellControllerService;
	}

	function hostedShell(
		calls: string[],
		outcome: HucodeHostedShellOperationOutcome =
			HucodeHostedShellOperationOutcome.Accepted,
		available = true
	): IHucodeHostedShellService {
		return withHucodeHostedShellCachedAvailability({
			async navigateToFolder(request: Parameters<
				IHucodeHostedShellService['navigateToFolder']
			>[0]) {
				calls.push(`navigate:${URI.revive(request.folderUri).fsPath}`);
				return outcome;
			},
		} as unknown as IHucodeHostedShellService, () => available);
	}

	test('focuses existing normal window instead of opening in Omni',
		async () => {
			const calls: string[] = [];

			await openProjectSwitcherTargetInWindow(
				target,
				projectManager(calls),
				environment({ isOmniWindow: true }),
				shell(calls, true),
				host(calls)
			);

			assert.deepStrictEqual(calls, [
				'focusNormal:/repo',
				'setLastActive:project:/repo',
			]);
		}
	);

	test('opens hosted workspace when no normal window owns the worktree',
		async () => {
			const calls: string[] = [];

			await openProjectSwitcherTargetInWindow(
				target,
				projectManager(calls),
				environment({ isOmniWindow: true }),
				shell(calls, false),
				host(calls)
			);

			assert.deepStrictEqual(calls, [
				'focusNormal:/repo',
				'openWorkspace:/repo:project',
				'focusWorkspace',
				'setLastActive:project:/repo',
			]);
		}
	);

	test('adopts a promoted path-only target as a project worktree', async () => {
		const calls: string[] = [];

		await openProjectSwitcherTargetInWindow(
			{ worktreePath: '/repo' },
			projectManager(calls),
			environment({ isOmniWindow: true }),
			shell(calls, false),
			host(calls)
		);

		assert.deepStrictEqual(calls, [
			'focusNormal:/repo',
			'openWorkspace:/repo:project',
			'focusWorkspace',
			'setLastActive:project:/repo',
		]);
	});

	test('hosted navigation never consults the privileged shell service',
		async () => {
			const calls: string[] = [];

			await openProjectSwitcherTargetInWindow(
				target,
				projectManager(calls),
				environment({ isHostedOmniWorkspace: true }),
				shell(calls, new Error('must not be called')),
				host(calls),
				hostedShell(calls)
			);

			assert.deepStrictEqual(calls, [
				'navigate:/repo',
			]);
		}
	);

	test('uses an atomic open and focus from a hosted workbench', async () => {
		const calls: string[] = [];

		await openProjectSwitcherTargetInWindow(
			target,
			projectManager(calls),
			environment({ isHostedOmniWorkspace: true }),
			shell(calls, false),
			host(calls),
			hostedShell(calls)
		);

		assert.deepStrictEqual(calls, [
			'navigate:/repo',
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
			projectManager(calls),
			environment({}),
			shell(calls, false),
			hostService
		);

		assert.deepStrictEqual(calls, [
			'hostOpen',
			'setLastActive:project:/repo',
		]);
		assert.deepStrictEqual(opened, [{ folderUri: URI.file('/repo') }]);
		assert.deepStrictEqual(openOptions, { forceReuseWindow: true });
	});

	test('handles every hosted navigation outcome without caller MRU writes',
		async () => {
			for (const outcome of [
				HucodeHostedShellOperationOutcome.Rejected,
				HucodeHostedShellOperationOutcome.Stale,
				HucodeHostedShellOperationOutcome.Unavailable,
				HucodeHostedShellOperationOutcome.Unsupported,
			]) {
				const calls: string[] = [];
				await assert.rejects(() => openProjectSwitcherTargetInWindow(
					target,
					projectManager(calls),
					environment({ isHostedOmniWorkspace: true }),
					shell(calls, false),
					host(calls),
					hostedShell(calls, outcome)
				));
				assert.deepStrictEqual(calls, ['navigate:/repo']);
			}

			const supersededCalls: string[] = [];
			await openProjectSwitcherTargetInWindow(
				target,
				projectManager(supersededCalls),
				environment({ isHostedOmniWorkspace: true }),
				shell(supersededCalls, false),
				host(supersededCalls),
				hostedShell(
					supersededCalls,
					HucodeHostedShellOperationOutcome.Superseded
				)
			);
			assert.deepStrictEqual(supersededCalls, ['navigate:/repo']);
		});

	test('does not await hosted navigation while transport is unavailable',
		async () => {
			const calls: string[] = [];
			await assert.rejects(() => openProjectSwitcherTargetInWindow(
				target,
				projectManager(calls),
				environment({ isHostedOmniWorkspace: true }),
				shell(calls, false),
				host(calls),
				hostedShell(calls,
					HucodeHostedShellOperationOutcome.Accepted, false)
			));
			assert.deepStrictEqual(calls, []);
		});

	test('rejects unknown hosted outcomes without fallback navigation',
		async () => {
			const calls: string[] = [];
			await assert.rejects(() => openProjectSwitcherTargetInWindow(
				target,
				projectManager(calls),
				environment({ isHostedOmniWorkspace: true }),
				shell(calls, false),
				host(calls),
				hostedShell(
					calls,
					'future-outcome' as HucodeHostedShellOperationOutcome
				)
			), /unrecognized workbench switch result/);
			assert.deepStrictEqual(calls, ['navigate:/repo']);
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
