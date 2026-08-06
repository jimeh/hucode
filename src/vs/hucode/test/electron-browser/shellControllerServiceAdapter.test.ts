/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { INativeWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/electron-browser/environmentService.js';
import { IHucodeHostedWorkspaceState } from '../../common/omniWindow.js';
import {
	createHucodeShellControllerClient,
	IHucodeShellControllerService,
} from
	'../../../platform/window/common/hucodeShellControllerService.js';
import { DesktopShellControllerServiceAdapter } from
	'../../electron-browser/shellControllerServiceAdapter.js';

suite('DesktopShellControllerServiceAdapter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('waits for the bound shell connection and forwards its state', async () => {
		const connection =
			new DeferredPromise<IHucodeShellControllerService | undefined>();
		const changes = disposables.add(
			new Emitter<IHucodeHostedWorkspaceState>()
		);
		const calls: string[] = [];
		const first = state('first');
		const second = state('second');
		const shell = {
			supportsWorkspaceScreenshotOverlay: true,
			onDidChangeState: changes.event,
			getState: async () => first,
			openWorkspace: async (path: string, projectId?: string) => {
				calls.push(`open:${path}:${projectId}`);
				return first;
			},
		} as unknown as IHucodeShellControllerService;
		const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
			() => connection.p,
			shellEnvironment(true)
		));
		const observed: IHucodeHostedWorkspaceState[] = [];
		disposables.add(adapter.onDidChangeState(value => observed.push(value)));

		const pending = adapter.openWorkspace('/repo', 'project');
		void connection.complete(shell);
		assert.deepStrictEqual(await pending, first);
		changes.fire(second);
		assert.deepStrictEqual(observed, [second]);
		assert.deepStrictEqual(calls, ['open:/repo:project']);
	});

	test('typed client is concrete and cannot be assimilated as a promise',
		async () => {
			const expected = state('bound');
			const calls: string[] = [];
			const changes = disposables.add(
				new Emitter<IHucodeHostedWorkspaceState>()
			);
			const client = createHucodeShellControllerClient({
				call: async (command: string) => {
					calls.push(command);
					return expected;
				},
				listen: () => changes.event,
			} as IChannel);

			assert.strictEqual(
				(client as unknown as { then?: unknown }).then,
				undefined
			);
			assert.strictEqual(await Promise.resolve(client), client);
			assert.deepStrictEqual(await client.getState(), expected);
			assert.deepStrictEqual(calls, ['getState']);
		}
	);

	test('ordinary and hosted workbenches never request the privileged port',
		async () => {
			let connectCalls = 0;
			const adapter = disposables.add(
				new DesktopShellControllerServiceAdapter(
					async () => {
						connectCalls++;
						return undefined;
					},
					shellEnvironment(false)
				)
			);

			await assert.rejects(adapter.getState(), /capability is unavailable/);
			assert.strictEqual(connectCalls, 0);
		}
	);

	test('disposal settles pending work and disposes a late connection',
		async () => {
			const connection =
				new DeferredPromise<IHucodeShellControllerService | undefined>();
			let connectionDisposed = false;
			const adapter = new DesktopShellControllerServiceAdapter(
				() => connection.p,
				shellEnvironment(true)
			);
			const operation = adapter.getState();
			adapter.dispose();
			await assert.rejects(operation, /capability is unavailable/);
			void connection.complete(Object.assign({
				onDidChangeState: () => ({ dispose() { } }),
			} as unknown as IHucodeShellControllerService, {
				dispose: () => connectionDisposed = true,
			}));
			await Promise.resolve();
			assert.strictEqual(connectionDisposed, true);
		}
	);

	test('shutdown does not wait for a pending connection', async () => {
		const connection =
			new DeferredPromise<IHucodeShellControllerService | undefined>();
		const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
			() => connection.p,
			shellEnvironment(true),
			{
				connectionTimeoutMs: 1000,
				shutdownConnectionTimeoutMs: 5,
			}
		));

		await adapter.shutdownWindowWorkspaces(4);
		assert.strictEqual(connection.isSettled, false);
	});

	test('times out acquisition and disposes a late connection', async () => {
		const connection =
			new DeferredPromise<IHucodeShellControllerService | undefined>();
		let connectionDisposed = false;
		const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
			() => connection.p,
			shellEnvironment(true),
			{ connectionTimeoutMs: 5 }
		));

		await assert.rejects(adapter.getState(), /capability is unavailable/);
		void connection.complete(Object.assign({
			onDidChangeState: () => ({ dispose() { } }),
		} as unknown as IHucodeShellControllerService, {
			dispose: () => connectionDisposed = true,
		}));
		await Promise.resolve();
		assert.strictEqual(connectionDisposed, true);
	});
});

function shellEnvironment(
	isOmniShellWindow: boolean
): INativeWorkbenchEnvironmentService {
	return {
		window: { id: 7 },
		isOmniShellWindow,
	} as INativeWorkbenchEnvironmentService;
}

function state(activeInstanceId: string): IHucodeHostedWorkspaceState {
	return {
		activeInstanceId,
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: [],
	};
}
