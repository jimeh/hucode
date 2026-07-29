/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../base/browser/window.js';
import { isWeb } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import type { IConfigurationService } from
	'../../../../platform/configuration/common/configuration.js';
import type { INotificationService } from
	'../../../../platform/notification/common/notification.js';
import type { IProjectManagerService } from
	'../../../../platform/projectManager/common/projectManager.js';
import type {
	IInputOptions,
	IQuickInputService,
} from '../../../../platform/quickinput/common/quickInput.js';
import type { INativeRunActionInWindowRequest } from
	'../../../../platform/window/common/window.js';
import type { IWorkbenchEnvironmentService } from
	'../../../../workbench/services/environment/common/environmentService.js';
import type { IHucodeShellService } from
	'../../../common/omniWindow.js';
import {
	WebProjectManagerClient,
	WebProjectManagerFetch,
} from '../../../browser/projectManager/webProjectManagerService.js';
import {
	pickCreateWorktreeBranchName,
	pickCreateWorktreeOptions,
} from '../../../browser/projectSwitcher/createProjectWorktree.contribution.js';
import { CREATE_WORKTREE_COMMAND_ID } from
	'../../../browser/projectSwitcher/projectSwitcherCommon.js';
import { tryForwardShellCreateWorktreeCommand } from
	'../../../browser/projectSwitcher/createProjectWorktreeRouting.js';

suite('CreateProjectWorktreeRouting', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps web Omni Create Worktree in the shell', async () => {
		const calls: IForwardedAction[] = [];
		const handle = { $treeItemHandle: 'project:pinned:project' };
		assert.strictEqual(await tryForwardShellCreateWorktreeCommand(
			{ isOmniWindow: true, isWebClient: true },
			shell(calls),
			7,
			handle
		), false);

		assert.deepStrictEqual(calls, []);
	});

	test('forwards native Omni Create Worktree to the workbench', async () => {
		const calls: IForwardedAction[] = [];
		const handle = { $treeItemHandle: 'project:pinned:project' };
		assert.strictEqual(await tryForwardShellCreateWorktreeCommand(
			{ isOmniWindow: true, isWebClient: false },
			shell(calls),
			7,
			handle
		), true);

		assert.deepStrictEqual(calls, [{
			windowId: 7,
			request: {
				id: CREATE_WORKTREE_COMMAND_ID,
				from: 'mouse',
				args: [handle],
			},
		}]);
	});

	test('returns false when native Omni forwarding misses', async () => {
		const calls: IForwardedAction[] = [];
		assert.strictEqual(await tryForwardShellCreateWorktreeCommand(
			{ isOmniWindow: true, isWebClient: false },
			shell(calls, false),
			7
		), false);
		assert.deepStrictEqual(calls, [{
			windowId: 7,
			request: {
				id: CREATE_WORKTREE_COMMAND_ID,
				from: 'mouse',
				args: undefined,
			},
		}]);
	});

	test('does not forward Create Worktree outside Omni', async () => {
		const calls: IForwardedAction[] = [];
		assert.strictEqual(await tryForwardShellCreateWorktreeCommand(
			{ isOmniWindow: false, isWebClient: false },
			shell(calls),
			7
		), false);
		assert.deepStrictEqual(calls, []);
	});

	test('cancels ref loading when the picker is dismissed', async () => {
		let requestSignal: AbortSignal | undefined;
		let resolveRequestAbort: (() => void) | undefined;
		const requestAborted = new Promise<void>(resolve => {
			resolveRequestAbort = resolve;
		});
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (event: PromiseRejectionEvent) => {
			unhandledRejections.push(event.reason);
			event.preventDefault();
		};
		mainWindow.addEventListener(
			'unhandledrejection',
			onUnhandledRejection
		);
		const fakeFetch: WebProjectManagerFetch = async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				requestSignal?.addEventListener(
					'abort',
					() => {
						reject(requestSignal?.reason);
						resolveRequestAbort?.();
					},
					{ once: true }
				);
			});
		};
		const projectManagerService = new WebProjectManagerClient(
			'/api/projects',
			{ fetch: fakeFetch }
		);
		const quickInputService = {
			pick(_picks: Promise<unknown>) {
				return Promise.resolve(undefined);
			},
		} as Partial<IQuickInputService> as IQuickInputService;

		try {
			const result = await pickCreateWorktreeOptions(
				'project',
				projectManagerService,
				quickInputService,
				{} as INotificationService,
				{
					getValue: () => 'committerdate',
				} as Partial<IConfigurationService> as IConfigurationService,
				{ isOmniWindow: false } as IWorkbenchEnvironmentService,
				{} as IHucodeShellService,
				true
			);

			assert.strictEqual(result, undefined);
			assert.strictEqual(requestSignal?.aborted, true);
			await requestAborted;
			await Promise.resolve();
			for (let turn = 0; turn < 5; turn++) {
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
			assert.deepStrictEqual(unhandledRejections, []);
		} finally {
			mainWindow.removeEventListener(
				'unhandledrejection',
				onUnhandledRejection
			);
			projectManagerService.dispose();
		}
	});

	test('uses the platform request-cancellation contract',
		async () => {
			const argumentCounts: number[] = [];
			const projectManagerService = {
				getWorktreeRefs(...args: unknown[]) {
					argumentCounts.push(args.length);
					return Promise.resolve([]);
				},
				isValidBranchName(...args: unknown[]) {
					argumentCounts.push(args.length);
					return Promise.resolve(true);
				},
			} as Partial<IProjectManagerService> as IProjectManagerService;
			const quickInputService = {
				async pick(picks: Promise<unknown>) {
					await picks;
					return undefined;
				},
				async input(options: IInputOptions) {
					await options.validateInput?.('branch');
					return undefined;
				},
			} as Partial<IQuickInputService> as IQuickInputService;

			await pickCreateWorktreeOptions(
				'project',
				projectManagerService,
				quickInputService,
				{} as INotificationService,
				{
					getValue: () => 'committerdate',
				} as Partial<IConfigurationService> as IConfigurationService,
				{ isOmniWindow: false } as IWorkbenchEnvironmentService,
				{} as IHucodeShellService
			);
			await pickCreateWorktreeBranchName(
				'project',
				[],
				projectManagerService,
				quickInputService,
				{ isOmniWindow: false } as IWorkbenchEnvironmentService,
				{} as IHucodeShellService
			);

			assert.deepStrictEqual(
				argumentCounts,
				isWeb ? [3, 3] : [2, 2]
			);
		});

	test('does not accept a branch from superseded validation', async () => {
		const requestSignals: AbortSignal[] = [];
		const fakeFetch: WebProjectManagerFetch = async (_input, init) => {
			const signal = init?.signal;
			assert.ok(signal);
			requestSignals.push(signal);
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => reject(signal.reason),
					{ once: true }
				);
			});
		};
		const projectManagerService = new WebProjectManagerClient(
			'/api/projects',
			{ fetch: fakeFetch }
		);
		let staleAccepted = false;
		let dismissedValidation: Promise<unknown> | undefined;
		const quickInputService = {
			async input(options: IInputOptions) {
				const staleValidation = options.validateInput?.('first');
				const staleAcceptance = staleValidation?.then(result => {
					if (!result) {
						staleAccepted = true;
					}
				});
				dismissedValidation = options.validateInput?.('second');
				await staleAcceptance;
				return undefined;
			},
		} as Partial<IQuickInputService> as IQuickInputService;

		try {
			const result = await pickCreateWorktreeBranchName(
				'project',
				[],
				projectManagerService,
				quickInputService,
				{ isOmniWindow: false } as IWorkbenchEnvironmentService,
				{} as IHucodeShellService,
				true
			);

			assert.strictEqual(result, undefined);
			assert.ok(await dismissedValidation);
			assert.strictEqual(staleAccepted, false);
			assert.strictEqual(requestSignals.length, 2);
			assert.strictEqual(
				requestSignals.every(signal => signal.aborted),
				true
			);
		} finally {
			projectManagerService.dispose();
		}
	});

	test('does not accept late native validation after supersession', async () => {
		const validations: ((valid: boolean) => void)[] = [];
		const projectManagerService = {
			isValidBranchName() {
				return new Promise<boolean>(resolve => {
					validations.push(resolve);
				});
			},
		} as Partial<IProjectManagerService> as IProjectManagerService;
		let staleAccepted = false;
		let dismissedValidation: Promise<unknown> | undefined;
		const quickInputService = {
			async input(options: IInputOptions) {
				const staleValidation = options.validateInput?.('first');
				const staleAcceptance = staleValidation?.then(result => {
					if (!result) {
						staleAccepted = true;
					}
				});
				dismissedValidation = options.validateInput?.('second');
				validations[0](true);
				await staleAcceptance;
				return undefined;
			},
		} as Partial<IQuickInputService> as IQuickInputService;

		const result = await pickCreateWorktreeBranchName(
			'project',
			[],
			projectManagerService,
			quickInputService,
			{ isOmniWindow: false } as IWorkbenchEnvironmentService,
			{} as IHucodeShellService,
			false
		);
		validations[1](true);

		assert.strictEqual(result, undefined);
		assert.ok(await dismissedValidation);
		assert.strictEqual(staleAccepted, false);
	});
});

/** Records a forwarded shell action for routing assertions. */
interface IForwardedAction {
	readonly windowId: number;
	readonly request: INativeRunActionInWindowRequest;
}

/** Creates a shell-service stub that records forwarded actions. */
function shell(
	calls: IForwardedAction[],
	result = true
): Pick<IHucodeShellService, 'runActionInWorkspace'> {
	return {
		async runActionInWorkspace(windowId, request) {
			calls.push({ windowId, request });
			return result;
		},
	};
}
