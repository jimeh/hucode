/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from
	'../../../../base/common/cancellation.js';
import { CancellationError } from
	'../../../../base/common/errors.js';
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
		let refsToken = CancellationToken.None;
		const projectManagerService = {
			getWorktreeRefs(
				_projectId: string,
				_options: unknown,
				token: CancellationToken
			) {
				refsToken = token;
				return new Promise<never>((_resolve, reject) => {
					const cancellation = token.onCancellationRequested(() => {
						cancellation.dispose();
						reject(new CancellationError());
					});
				});
			},
		} as Partial<IProjectManagerService> as IProjectManagerService;
		const quickInputService = {
			pick(picks: Promise<unknown>) {
				void picks.catch(() => undefined);
				return Promise.resolve(undefined);
			},
		} as Partial<IQuickInputService> as IQuickInputService;

		const result = await pickCreateWorktreeOptions(
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

		assert.strictEqual(result, undefined);
		assert.strictEqual(refsToken.isCancellationRequested, true);
	});

	test('cancels stale and dismissed branch validation', async () => {
		const validationTokens: CancellationToken[] = [];
		const projectManagerService = {
			isValidBranchName(
				_projectId: string,
				_branchName: string,
				token: CancellationToken
			) {
				validationTokens.push(token);
				return new Promise<never>((_resolve, reject) => {
					const cancellation = token.onCancellationRequested(() => {
						cancellation.dispose();
						reject(new CancellationError());
					});
				});
			},
		} as Partial<IProjectManagerService> as IProjectManagerService;
		let dismissedValidation: Promise<unknown> | undefined;
		const quickInputService = {
			async input(options: IInputOptions) {
				const staleValidation = options.validateInput?.('first');
				dismissedValidation = options.validateInput?.('second');
				assert.strictEqual(await staleValidation, undefined);
				return undefined;
			},
		} as Partial<IQuickInputService> as IQuickInputService;

		const result = await pickCreateWorktreeBranchName(
			'project',
			[],
			projectManagerService,
			quickInputService,
			{ isOmniWindow: false } as IWorkbenchEnvironmentService,
			{} as IHucodeShellService
		);

		assert.strictEqual(result, undefined);
		assert.strictEqual(await dismissedValidation, undefined);
		assert.strictEqual(validationTokens.length, 2);
		assert.strictEqual(
			validationTokens.every(token => token.isCancellationRequested),
			true
		);
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
