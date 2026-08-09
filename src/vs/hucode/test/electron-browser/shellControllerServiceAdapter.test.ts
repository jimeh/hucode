/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { INativeWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/electron-browser/environmentService.js';
import { IHucodeHostedWorkspaceState } from '../../common/omniWindow.js';
import {
	createHucodeShellControllerServerChannel,
	createHucodeShellControllerClient,
	HUCODE_SHELL_CONTROLLER_REMOTE_MEMBERS,
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
			() => connectionAttempt(connection.p),
			{},
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

	test('recovers an initial denied acquisition without a renderer reload',
		async () => {
			const expected = state('recovered');
			let connectCalls = 0;
			const adapter = disposables.add(
				new DesktopShellControllerServiceAdapter(
					() => connectionAttempt(Promise.resolve(
						++connectCalls === 1
							? undefined
							: {
								onDidChangeState: Event.None,
								getState: async () => expected,
							} as unknown as IHucodeShellControllerService
					)),
					{ connectionTimeoutMs: 500, retryDelaysMs: [0] },
					shellEnvironment(true)
				)
			);

			assert.deepStrictEqual(await adapter.getState(), expected);
			assert.strictEqual(connectCalls, 2);
		}
	);

	test('recovers after the initial readiness budget expires', async () => {
		const expected = state('background-recovery');
		let connectCalls = 0;
		const adapter = disposables.add(
			new DesktopShellControllerServiceAdapter(
				() => connectionAttempt(Promise.resolve(
					++connectCalls === 1
						? undefined
						: {
							onDidChangeState: Event.None,
							getState: async () => expected,
						} as unknown as IHucodeShellControllerService
				)),
				{ connectionTimeoutMs: 5, retryDelaysMs: [20] },
				shellEnvironment(true)
			)
		);
		const recoveredState = Event.toPromise(adapter.onDidChangeState);

		await assert.rejects(adapter.getState(), /capability is unavailable/);
		assert.deepStrictEqual(await recoveredState, expected);
		assert.deepStrictEqual(await adapter.getState(), expected);
		assert.strictEqual(connectCalls, 2);
	});

	test('recovers initial acquisition rejection and timeout', async () => {
		const expected = state('recovered');
		const timedOut = new DeferredPromise<
			IHucodeShellControllerService | undefined
		>();
		let connectCalls = 0;
		let lateConnectionDisposed = false;
		const shell = {
			onDidChangeState: Event.None,
			getState: async () => expected,
		} as unknown as IHucodeShellControllerService;
		const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
			() => {
				connectCalls++;
				if (connectCalls === 1) {
					return connectionAttempt(
						Promise.reject(new Error('denied'))
					);
				}
				if (connectCalls === 2) {
					return connectionAttempt(timedOut.p);
				}
				return connectionAttempt(Promise.resolve(shell));
			},
			{
				acquisitionTimeoutMs: 5,
				connectionTimeoutMs: 500,
				retryDelaysMs: [0],
			},
			shellEnvironment(true)
		));

		assert.deepStrictEqual(await adapter.getState(), expected);
		assert.strictEqual(connectCalls, 3);
		void timedOut.complete(Object.assign({
			onDidChangeState: Event.None,
		} as unknown as IHucodeShellControllerService, {
			dispose: () => lateConnectionDisposed = true,
		}));
		await Promise.resolve();
		assert.strictEqual(lateConnectionDisposed, true);
	});

	test('reacquires after an ambiguous failure without replaying it', async () => {
		const expected = state('replacement');
		let connectCalls = 0;
		let firstOperationCalls = 0;
		const first = {
			onDidChangeState: Event.None,
			getState: async () => state('first'),
			openWorkspace: async () => {
				firstOperationCalls++;
				throw new Error('connection lost after dispatch');
			},
		} as unknown as IHucodeShellControllerService;
		const replacement = {
			onDidChangeState: Event.None,
			getState: async () => expected,
		} as unknown as IHucodeShellControllerService;
		const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
			() => connectionAttempt(Promise.resolve(
				++connectCalls === 1 ? first : replacement
			)),
			{
				connectionTimeoutMs: 500,
				retryDelaysMs: [0],
			},
			shellEnvironment(true)
		));

		await adapter.getState();
		const recoveredState = Event.toPromise(adapter.onDidChangeState);
		await assert.rejects(
			adapter.openWorkspace('/ambiguous'),
			/connection lost after dispatch/
		);
		assert.deepStrictEqual(await recoveredState, expected);
		assert.deepStrictEqual(await adapter.getState(), expected);
		assert.strictEqual(firstOperationCalls, 1);
		assert.strictEqual(connectCalls, 2);
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

	test('server channel exposes only the declared controller surface',
		async () => {
			const calls: string[] = [];
			const service = new Proxy({
				_serviceBrand: undefined,
				supportsWorkspaceScreenshotOverlay: true,
				onDidChangeState: Event.None,
			}, {
				get(target, property) {
					if (Object.hasOwn(target, property)) {
						return target[property as keyof typeof target];
					}
					return () => {
						calls.push(String(property));
						return Promise.resolve(undefined);
					};
				},
			}) as unknown as IHucodeShellControllerService;
			const channelDisposables = disposables.add(new DisposableStore());
			const channel = createHucodeShellControllerServerChannel(
				service,
				channelDisposables
			);

			const listener = channel.listen('test', 'onDidChangeState');
			const listenerDisposable = listener(() => undefined);
			listenerDisposable.dispose();
			const methods = HUCODE_SHELL_CONTROLLER_REMOTE_MEMBERS.filter(
				member => member !== 'onDidChangeState'
			);
			for (const method of methods) {
				await channel.call('test', method, []);
			}
			assert.deepStrictEqual(calls, methods);
			await assert.rejects(
				channel.call('test', 'onDidChangeState'),
				/Method not found: onDidChangeState/
			);
			for (const method of ['constructor', 'toString', 'undeclared']) {
				await assert.rejects(
					channel.call('test', method),
					new RegExp(`Method not found: ${method}`)
				);
			}
			assert.throws(
				() => channel.listen('test', 'getState'),
				/Event not found: getState/
			);
		}
	);

	test('ordinary and hosted workbenches never request the privileged port',
		async () => {
			let connectCalls = 0;
			const adapter = disposables.add(
				new DesktopShellControllerServiceAdapter(
					() => connectionAttempt(Promise.resolve().then(() => {
						connectCalls++;
						return undefined;
					})),
					{},
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
				() => connectionAttempt(connection.p),
				{},
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
		let attemptDisposed = false;
		const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
			() => connectionAttempt(
				connection.p,
				() => attemptDisposed = true
			),
			{
				connectionTimeoutMs: 1000,
				shutdownConnectionTimeoutMs: 5,
			},
			shellEnvironment(true)
		));

		await adapter.shutdownWindowWorkspaces(4);
		assert.strictEqual(connection.isSettled, false);
		adapter.dispose();
		assert.strictEqual(attemptDisposed, true);
	});

	test('times out acquisition and disposes a late connection', async () => {
		const connection =
			new DeferredPromise<IHucodeShellControllerService | undefined>();
		let connectionDisposed = false;
		let attemptDisposed = false;
		const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
			() => connectionAttempt(
				connection.p,
				() => attemptDisposed = true
			),
			{
				acquisitionTimeoutMs: 2,
				connectionTimeoutMs: 5,
				retryDelaysMs: [100],
			},
			shellEnvironment(true)
		));

		await assert.rejects(adapter.getState(), /capability is unavailable/);
		assert.strictEqual(attemptDisposed, true);
		void connection.complete(Object.assign({
			onDidChangeState: () => ({ dispose() { } }),
		} as unknown as IHucodeShellControllerService, {
			dispose: () => connectionDisposed = true,
		}));
		await Promise.resolve();
		assert.strictEqual(connectionDisposed, true);
	});
});

function connectionAttempt(
	promise: Promise<IHucodeShellControllerService | undefined>,
	onDispose: () => void = () => undefined
) {
	return { promise, dispose: onDispose };
}

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
