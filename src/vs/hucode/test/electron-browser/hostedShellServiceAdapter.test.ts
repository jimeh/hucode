/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
	IHucodeHostedShellState,
} from '../../../platform/window/common/hucodeHostedShellService.js';
import { HucodeHostedShellAction } from
	'../../../platform/window/common/hucodeHostedShellActions.js';
import { INativeWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/electron-browser/environmentService.js';
import { DesktopHostedShellServiceAdapter } from
	'../../electron-browser/hostedShellServiceAdapter.js';

suite('DesktopHostedShellServiceAdapter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('waits for and delegates only to the narrow hosted connection',
		async () => {
			const connection =
				new DeferredPromise<IHucodeHostedShellService | undefined>();
			const changes = disposables.add(new Emitter<IHucodeHostedShellState>());
			const calls: string[] = [];
			let state: IHucodeHostedShellState = {
				available: true,
				projectsSidebarVisible: true,
				projectSwitcherCanGoBack: false,
				projectSwitcherCanGoForward: true,
				lifecycleState: 'active',
				active: true,
				visible: true,
			};
			const shell: IHucodeHostedShellService = {
				_serviceBrand: undefined,
				onDidChangeState: changes.event,
				getState: async () => state,
				notifyReady: async () => ({
					outcome: HucodeHostedShellOperationOutcome.Accepted,
					state,
				}),
				closeSelf: async () => {
					calls.push('close');
					return HucodeHostedShellOperationOutcome.Accepted;
				},
				reopenSelfInNormalWindow: async () =>
					HucodeHostedShellOperationOutcome.Accepted,
				reloadSelf: async () => HucodeHostedShellOperationOutcome.Accepted,
				focusSelf: async () => HucodeHostedShellOperationOutcome.Accepted,
				focusShell: async () => HucodeHostedShellOperationOutcome.Accepted,
				requestShellAction: async action => {
					calls.push(`action:${action}`);
					return HucodeHostedShellOperationOutcome.Accepted;
				},
				navigateToFolder: async () =>
					HucodeHostedShellOperationOutcome.Accepted,
				triggerPasteInSelf: async () => {
					calls.push('paste');
					return HucodeHostedShellOperationOutcome.Accepted;
				},
				captureSelfScreenshot: async () => VSBuffer.fromString('self'),
			};
			const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
				() => connection.p,
				createHostedEnvironment()
			));
			const forwardedStates: IHucodeHostedShellState[] = [];
			disposables.add(adapter.onDidChangeState(value =>
				forwardedStates.push(value)
			));

			const statePromise = adapter.getState();
			void connection.complete(shell);
			assert.deepStrictEqual(await statePromise, state);
			state = {
				...state,
				projectsSidebarVisible: false,
			};
			changes.fire(state);
			assert.deepStrictEqual(forwardedStates.at(-1), state);
			assert.deepStrictEqual(await adapter.getState(), state);
			assert.strictEqual(
				await adapter.requestShellAction(HucodeHostedShellAction.AddProject),
				HucodeHostedShellOperationOutcome.Accepted
			);
			assert.strictEqual(
				await adapter.triggerPasteInSelf(),
				HucodeHostedShellOperationOutcome.Accepted
			);
			assert.strictEqual(
				(await adapter.captureSelfScreenshot())?.toString(),
				'self'
			);
			assert.deepStrictEqual(calls, ['action:addProject', 'paste']);
		});

	test('disposal settles a pending connection without fallback', async () => {
		const connection =
			new DeferredPromise<IHucodeHostedShellService | undefined>();
		let connectionDisposed = false;
		const adapter = new DesktopHostedShellServiceAdapter(
			() => connection.p,
			createHostedEnvironment()
		);
		const operation = adapter.closeSelf();
		adapter.dispose();
		assert.strictEqual(
			await operation,
			HucodeHostedShellOperationOutcome.Unavailable
		);
		assert.deepStrictEqual(
			await adapter.getState(),
			HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE
		);
		void connection.complete(Object.assign(createUnavailableShell(), {
			dispose: () => connectionDisposed = true,
		}));
		await Promise.resolve();
		assert.strictEqual(connectionDisposed, true);
	});

	test('maps rejected port operations to unavailable outcomes', async () => {
		const changes = disposables.add(new Emitter<IHucodeHostedShellState>());
		const shell = Object.assign(createUnavailableShell(), {
			onDidChangeState: changes.event,
			getState: async () => {
				throw new Error('connection disposed');
			},
			closeSelf: async () => {
				throw new Error('connection disposed');
			},
		});
		const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
			async () => shell,
			createHostedEnvironment()
		));

		assert.deepStrictEqual(
			await adapter.getState(),
			HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE
		);
		assert.strictEqual(
			await adapter.closeSelf(),
			HucodeHostedShellOperationOutcome.Unavailable
		);
	});
});

function createUnavailableShell(): IHucodeHostedShellService {
	return {
		_serviceBrand: undefined,
		onDidChangeState: () => ({ dispose() { } }),
		getState: async () => HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
		notifyReady: async () => ({
			outcome: HucodeHostedShellOperationOutcome.Unavailable,
		}),
		closeSelf: async () => HucodeHostedShellOperationOutcome.Unavailable,
		reopenSelfInNormalWindow: async () =>
			HucodeHostedShellOperationOutcome.Unavailable,
		reloadSelf: async () => HucodeHostedShellOperationOutcome.Unavailable,
		focusSelf: async () => HucodeHostedShellOperationOutcome.Unavailable,
		focusShell: async () => HucodeHostedShellOperationOutcome.Unavailable,
		requestShellAction: async () =>
			HucodeHostedShellOperationOutcome.Unavailable,
		navigateToFolder: async () =>
			HucodeHostedShellOperationOutcome.Unavailable,
		triggerPasteInSelf: async () =>
			HucodeHostedShellOperationOutcome.Unavailable,
		captureSelfScreenshot: async () => undefined,
	};
}

function createHostedEnvironment(): INativeWorkbenchEnvironmentService {
	return {
		window: { id: 7 },
		isHostedOmniWorkspace: true,
		hostedInstanceId: 'self',
	} as INativeWorkbenchEnvironmentService;
}
