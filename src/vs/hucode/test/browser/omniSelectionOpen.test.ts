/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { errorHandler } from '../../../base/common/errors.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { INotificationService } from
	'../../../platform/notification/common/notification.js';
import { IProjectManagerService } from
	'../../../platform/projectManager/common/projectManager.js';
import { IHostService } from
	'../../../workbench/services/host/browser/host.js';
import { IHucodeShellService } from '../../common/omniWindow.js';
import { IProjectSwitcherSelectionTarget } from
	'../../common/projectSwitcher/switchProjectWorktreeModel.js';
import {
	openSelectionInOmniWindow,
	openSelectionInStandaloneWindow,
} from '../../browser/omniSelectionOpen.js';

suite('OmniSelectionOpen', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const selection: IProjectSwitcherSelectionTarget = {
		projectId: 'project',
		worktreePath: '/repo',
	};

	function notifications(messages: string[]): INotificationService {
		return {
			info(message: string) {
				messages.push(message);
			}
		} as unknown as INotificationService;
	}

	function projectManager(calls: string[]): IProjectManagerService {
		return {
			async setLastActiveWorktree(projectId: string, worktreePath: string) {
				calls.push(`setLastActive:${projectId}:${worktreePath}`);
			}
		} as unknown as IProjectManagerService;
	}

	function host(calls: string[]): IHostService {
		return {
			async openWindow(toOpen: unknown, options: unknown) {
				calls.push('hostOpen');
				calls.push(JSON.stringify({ toOpen, options }));
			}
		} as unknown as IHostService;
	}

	function shell(
		calls: string[],
		options: {
			readonly focusNormalResult?: boolean | Error;
			readonly hostedOwner?: boolean;
			readonly closeRemovesHostedOwner?: boolean;
			readonly retainedUnloadSucceeds?: boolean;
		} = {}
	): IHucodeShellService {
		const focusNormalResult = options.focusNormalResult ?? false;
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
				return {
					projectsSidebarVisible: false,
					projectSwitcherCanGoBack: false,
					projectSwitcherCanGoForward: false,
					instances: [],
				};
			},
			async findHostedWorkspaceByPath(worktreePath: string) {
				calls.push(`findHosted:${worktreePath}`);
				if (!options.hostedOwner) {
					return undefined;
				}
				return {
					windowId: 3,
					instanceId: 'instance',
					projectId: 'project',
					worktreePath,
				};
			},
			async closeWorkspace(windowId: number, instanceId?: string) {
				calls.push(`closeWorkspace:${windowId}:${instanceId}`);
				return {
					projectsSidebarVisible: false,
					projectSwitcherCanGoBack: false,
					projectSwitcherCanGoForward: false,
					instances: options.closeRemovesHostedOwner
						? []
						: [{
							instanceId: 'instance',
							projectId: 'project',
							worktreePath: '/repo',
							state: 'active',
							visible: true,
							focused: true,
						}],
				};
			},
			async unloadRetainedWorkbench(windowId: number, workbenchId: string) {
				calls.push(`unloadRetained:${windowId}:${workbenchId}`);
				return {
					projectsSidebarVisible: false,
					projectSwitcherCanGoBack: false,
					projectSwitcherCanGoForward: false,
					instances: [],
					retainedWorkbenches: [{
						id: workbenchId,
						folderUri: URI.file('/repo').toJSON(),
						desiredState: options.retainedUnloadSucceeds === false
							? 'loaded'
							: 'unloaded',
						order: 0,
					}],
				};
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

	test('notifies when opening in Omni without a selection', async () => {
		const calls: string[] = [];
		const messages: string[] = [];

		const result = await openSelectionInOmniWindow(
			undefined,
			7,
			shell(calls),
			projectManager(calls),
			notifications(messages),
			'Select first'
		);

		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(messages, ['Select first']);
		assert.deepStrictEqual(calls, []);
	});

	test('focuses existing normal window instead of opening in Omni',
		async () => {
			const calls: string[] = [];

			const result = await openSelectionInOmniWindow(
				selection,
				7,
				shell(calls, { focusNormalResult: true }),
				projectManager(calls),
				notifications([]),
				'Select first'
			);

			assert.strictEqual(result, undefined);
			assert.deepStrictEqual(calls, [
				'setLastActive:project:/repo',
				'focusNormal:/repo',
			]);
		}
	);

	test('opens in Omni when normal-window lookup fails', async () => {
		const calls: string[] = [];

		await withExpectedUnexpectedError(() => openSelectionInOmniWindow(
			selection,
			7,
			shell(calls, { focusNormalResult: new Error('lookup failed') }),
			projectManager(calls),
			notifications([]),
			'Select first'
		));

		assert.deepStrictEqual(calls, [
			'setLastActive:project:/repo',
			'focusNormal:/repo',
			'openWorkspace:7:/repo:project',
		]);
	});

	test('closes hosted owner before focusing standalone window', async () => {
		const calls: string[] = [];

		await openSelectionInStandaloneWindow(
			selection,
			host(calls),
			shell(calls, {
				hostedOwner: true,
				closeRemovesHostedOwner: true,
				focusNormalResult: true,
			}),
			projectManager(calls),
			notifications([]),
			'Select first'
		);

		assert.deepStrictEqual(calls, [
			'setLastActive:project:/repo',
			'findHosted:/repo',
			'closeWorkspace:3:instance',
			'focusNormal:/repo',
		]);
	});

	test('notifies when opening standalone without a selection', async () => {
		const calls: string[] = [];
		const messages: string[] = [];

		await openSelectionInStandaloneWindow(
			undefined,
			host(calls),
			shell(calls),
			projectManager(calls),
			notifications(messages),
			'Select first'
		);

		assert.deepStrictEqual(messages, ['Select first']);
		assert.deepStrictEqual(calls, []);
	});

	test('does not open standalone window when hosted close is vetoed',
		async () => {
			const calls: string[] = [];

			await openSelectionInStandaloneWindow(
				selection,
				host(calls),
				shell(calls, {
					hostedOwner: true,
					closeRemovesHostedOwner: false,
					focusNormalResult: true,
				}),
				projectManager(calls),
				notifications([]),
				'Select first'
			);

			assert.deepStrictEqual(calls, [
				'setLastActive:project:/repo',
				'findHosted:/repo',
				'closeWorkspace:3:instance',
			]);
		}
	);

	test('unloads retained ownership before opening standalone', async () => {
		const calls: string[] = [];

		await openSelectionInStandaloneWindow(
			{ worktreePath: '/repo' },
			host(calls),
			shell(calls),
			projectManager(calls),
			notifications([]),
			'Select first',
			{ windowId: 4, id: 'retained' }
		);

		assert.deepStrictEqual(calls, [
			'unloadRetained:4:retained',
			'findHosted:/repo',
			'focusNormal:/repo',
			'hostOpen',
			JSON.stringify({
				toOpen: [{ folderUri: URI.file('/repo') }],
				options: { forceNewWindow: true },
			}),
		]);
	});

	test('does not open standalone when retained unload is vetoed', async () => {
		const calls: string[] = [];

		await openSelectionInStandaloneWindow(
			{ worktreePath: '/repo' },
			host(calls),
			shell(calls, { retainedUnloadSucceeds: false }),
			projectManager(calls),
			notifications([]),
			'Select first',
			{ windowId: 4, id: 'retained' }
		);

		assert.deepStrictEqual(calls, ['unloadRetained:4:retained']);
	});

	test('opens standalone window when worktree is not already open',
		async () => {
			const calls: string[] = [];

			await openSelectionInStandaloneWindow(
				selection,
				host(calls),
				shell(calls),
				projectManager(calls),
				notifications([]),
				'Select first'
			);

			assert.deepStrictEqual(calls, [
				'setLastActive:project:/repo',
				'findHosted:/repo',
				'focusNormal:/repo',
				'hostOpen',
				JSON.stringify({
					toOpen: [{ folderUri: URI.file('/repo') }],
					options: { forceNewWindow: true },
				}),
			]);
		}
	);

	test('opens standalone window when normal-window lookup fails',
		async () => {
			const calls: string[] = [];

			await withExpectedUnexpectedError(() =>
				openSelectionInStandaloneWindow(
					selection,
					host(calls),
					shell(calls, {
						focusNormalResult: new Error('lookup failed'),
					}),
					projectManager(calls),
					notifications([]),
					'Select first'
				)
			);

			assert.deepStrictEqual(calls, [
				'setLastActive:project:/repo',
				'findHosted:/repo',
				'focusNormal:/repo',
				'hostOpen',
				JSON.stringify({
					toOpen: [{ folderUri: URI.file('/repo') }],
					options: { forceNewWindow: true },
				}),
			]);
		}
	);
});
