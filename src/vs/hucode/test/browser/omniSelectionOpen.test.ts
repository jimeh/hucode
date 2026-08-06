/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
import { IHucodeShellControllerService } from
	'../../../platform/window/common/hucodeShellControllerService.js';
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
			readonly prepareSucceeds?: boolean;
		} = {}
	): IHucodeShellControllerService {
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
				worktreePath: string,
				projectId?: string
			) {
				calls.push(`openWorkspace:${worktreePath}:${projectId}`);
				return {
					projectsSidebarVisible: false,
					projectSwitcherCanGoBack: false,
					projectSwitcherCanGoForward: false,
					instances: [],
				};
			},
			async prepareWorkspaceForStandaloneOpen(request: Parameters<
				IHucodeShellControllerService[
				'prepareWorkspaceForStandaloneOpen'
				]
			>[0]) {
				calls.push(
					`prepare:${URI.revive(request.folderUri).fsPath}:` +
					`${request.retainedWorkbenchId ?? ''}`
				);
				return options.prepareSucceeds ?? true;
			},
		} as unknown as IHucodeShellControllerService;
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
				shell(calls, { focusNormalResult: true }),
				projectManager(calls),
				notifications([]),
				'Select first'
			);

			assert.strictEqual(result, undefined);
			assert.deepStrictEqual(calls, [
				'focusNormal:/repo',
				'setLastActive:project:/repo',
			]);
		}
	);

	test('opens in Omni when normal-window lookup fails', async () => {
		const calls: string[] = [];

		await withExpectedUnexpectedError(() => openSelectionInOmniWindow(
			selection,
			shell(calls, { focusNormalResult: new Error('lookup failed') }),
			projectManager(calls),
			notifications([]),
			'Select first'
		));

		assert.deepStrictEqual(calls, [
			'focusNormal:/repo',
			'openWorkspace:/repo:project',
			'setLastActive:project:/repo',
		]);
	});

	test('prepares ownership before focusing standalone window', async () => {
		const calls: string[] = [];

		await openSelectionInStandaloneWindow(
			selection,
			host(calls),
			shell(calls, {
				focusNormalResult: true,
			}),
			projectManager(calls),
			notifications([]),
			'Select first'
		);

		assert.deepStrictEqual(calls, [
			'prepare:/repo:',
			'focusNormal:/repo',
			'setLastActive:project:/repo',
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

	test('does not open standalone window when ownership preparation fails',
		async () => {
			const calls: string[] = [];

			await openSelectionInStandaloneWindow(
				selection,
				host(calls),
				shell(calls, {
					prepareSucceeds: false,
				}),
				projectManager(calls),
				notifications([]),
				'Select first'
			);

			assert.deepStrictEqual(calls, [
				'prepare:/repo:',
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
			{ id: 'retained' }
		);

		assert.deepStrictEqual(calls, [
			'prepare:/repo:retained',
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
			shell(calls, { prepareSucceeds: false }),
			projectManager(calls),
			notifications([]),
			'Select first',
			{ id: 'retained' }
		);

		assert.deepStrictEqual(calls, ['prepare:/repo:retained']);
	});

	test('opens standalone when retained workbench was already dismissed',
		async () => {
			const calls: string[] = [];

			await openSelectionInStandaloneWindow(
				{ worktreePath: '/repo' },
				host(calls),
				shell(calls),
				projectManager(calls),
				notifications([]),
				'Select first',
				{ id: 'retained' }
			);

			assert.deepStrictEqual(calls, [
				'prepare:/repo:retained',
				'focusNormal:/repo',
				'hostOpen',
				JSON.stringify({
					toOpen: [{ folderUri: URI.file('/repo') }],
					options: { forceNewWindow: true },
				}),
			]);
		}
	);

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
				'prepare:/repo:',
				'focusNormal:/repo',
				'hostOpen',
				JSON.stringify({
					toOpen: [{ folderUri: URI.file('/repo') }],
					options: { forceNewWindow: true },
				}),
				'setLastActive:project:/repo',
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
				'prepare:/repo:',
				'focusNormal:/repo',
				'hostOpen',
				JSON.stringify({
					toOpen: [{ folderUri: URI.file('/repo') }],
					options: { forceNewWindow: true },
				}),
				'setLastActive:project:/repo',
			]);
		}
	);
});
