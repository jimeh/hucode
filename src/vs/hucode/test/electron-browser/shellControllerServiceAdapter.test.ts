/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, raceTimeout } from '../../../base/common/async.js';
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

	test('reacquires after an ambiguous timeout without replaying it', async () => {
		const expected = state('replacement');
		const hungOperation = new DeferredPromise<IHucodeHostedWorkspaceState>();
		let connectCalls = 0;
		let firstOperationCalls = 0;
		const first = {
			onDidChangeState: Event.None,
			getState: async () => state('first'),
			openWorkspace: async () => {
				firstOperationCalls++;
				return hungOperation.p;
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
				operationTimeoutMs: 5,
				retryDelaysMs: [0],
			},
			shellEnvironment(true)
		));

		await adapter.getState();
		const recoveredState = Event.toPromise(adapter.onDidChangeState);
		await assert.rejects(
			adapter.openWorkspace('/ambiguous'),
			/timed out after dispatch/
		);
		assert.deepStrictEqual(await recoveredState, expected);
		assert.deepStrictEqual(await adapter.getState(), expected);
		assert.strictEqual(firstOperationCalls, 1);
		assert.strictEqual(connectCalls, 2);
	});

	test('application rejection preserves concurrent successful work',
		async () => {
			const initial = state('initial');
			const accepted = state('accepted');
			const acceptedOperation =
				new DeferredPromise<IHucodeHostedWorkspaceState>();
			let connectCalls = 0;
			let acceptedCalls = 0;
			const shell = {
				onDidChangeState: Event.None,
				getState: async () => initial,
				openWorkspace: async (path: string) => {
					if (path === '/rejected') {
						throw new Error('application rejected request');
					}
					acceptedCalls++;
					return acceptedOperation.p;
				},
			} as unknown as IHucodeShellControllerService;
			const adapter = disposables.add(
				new DesktopShellControllerServiceAdapter(
					() => {
						connectCalls++;
						return connectionAttempt(Promise.resolve(shell));
					},
					{ operationTimeoutMs: 500, retryDelaysMs: [0] },
					shellEnvironment(true)
				)
			);

			await adapter.getState();
			const successful = adapter.openWorkspace('/accepted');
			await assert.rejects(
				adapter.openWorkspace('/rejected'),
				/application rejected request/
			);
			void acceptedOperation.complete(accepted);
			assert.deepStrictEqual(await successful, accepted);
			assert.deepStrictEqual(await adapter.getState(), initial);
			assert.strictEqual(acceptedCalls, 1);
			assert.strictEqual(connectCalls, 1);
		}
	);

	test('returns a success completed after concurrent invalidation', async () => {
		const replacementState = state('replacement');
		const staleSuccessState = state('stale-success');
		const hungOperation = new DeferredPromise<IHucodeHostedWorkspaceState>();
		const staleSuccess = new DeferredPromise<IHucodeHostedWorkspaceState>();
		let connectCalls = 0;
		let staleSuccessCalls = 0;
		const first = {
			onDidChangeState: Event.None,
			getState: async () => state('first'),
			openWorkspace: async (path: string) => {
				if (path === '/hung') {
					return hungOperation.p;
				}
				staleSuccessCalls++;
				return staleSuccess.p;
			},
		} as unknown as IHucodeShellControllerService;
		const replacement = {
			onDidChangeState: Event.None,
			getState: async () => replacementState,
		} as unknown as IHucodeShellControllerService;
		const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
			() => connectionAttempt(Promise.resolve(
				++connectCalls === 1 ? first : replacement
			)),
			{
				operationTimeoutMs: 100,
				retryDelaysMs: [0],
			},
			shellEnvironment(true)
		));

		await adapter.getState();
		const recoveredState = Event.toPromise(adapter.onDidChangeState);
		const timedOut = adapter.openWorkspace('/hung');
		await new Promise<void>(resolve => setTimeout(resolve, 20));
		const completedAfterInvalidation = adapter.openWorkspace('/slow-success');
		await assert.rejects(timedOut, /timed out after dispatch/);
		void staleSuccess.complete(staleSuccessState);
		assert.deepStrictEqual(
			await completedAfterInvalidation,
			staleSuccessState
		);
		assert.deepStrictEqual(await recoveredState, replacementState);
		assert.deepStrictEqual(await adapter.getState(), replacementState);
		assert.strictEqual(staleSuccessCalls, 1);
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
			await waitFor(() => connectionDisposed);
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

	test('joins a dispatched shutdown beyond the connection acquisition budget',
		async () => {
			const remoteShutdown = new DeferredPromise<void>();
			let shutdownCalls = 0;
			const shell = {
				onDidChangeState: Event.None,
				getState: async () => state('connected'),
				shutdownWindowWorkspaces: async () => {
					shutdownCalls++;
					return remoteShutdown.p;
				},
			} as unknown as IHucodeShellControllerService;
			const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
				() => connectionAttempt(Promise.resolve(shell)),
				{
					shutdownConnectionTimeoutMs: 5,
					shutdownOperationTimeoutMs: 100,
				},
				shellEnvironment(true)
			));
			await adapter.getState();

			const shutdown = adapter.shutdownWindowWorkspaces(4);
			await waitFor(() => shutdownCalls === 1);
			assert.strictEqual(
				await raceTimeout(shutdown.then(() => 'settled'), 20),
				undefined
			);
			void remoteShutdown.complete();
			await shutdown;
		}
	);

	test('rejoins shutdown after concurrent operation invalidates the port',
		async () => {
			const firstClientShutdown = new DeferredPromise<void>();
			const mainShutdown = new DeferredPromise<void>();
			const hungOperation = new DeferredPromise<IHucodeHostedWorkspaceState>();
			let connectCalls = 0;
			let firstShutdownCalls = 0;
			let replacementShutdownCalls = 0;
			const first = Object.assign({
				onDidChangeState: Event.None,
				getState: async () => state('first'),
				openWorkspace: async () => hungOperation.p,
				shutdownWindowWorkspaces: async () => {
					firstShutdownCalls++;
					return firstClientShutdown.p;
				},
			} as unknown as IHucodeShellControllerService, {
				dispose: () => void firstClientShutdown.error(
					new Error('controller port closed')
				),
			});
			const replacement = {
				onDidChangeState: Event.None,
				getState: async () => state('replacement'),
				shutdownWindowWorkspaces: async () => {
					replacementShutdownCalls++;
					return mainShutdown.p;
				},
			} as unknown as IHucodeShellControllerService;
			const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
				() => connectionAttempt(Promise.resolve(
					++connectCalls === 1 ? first : replacement
				)),
				{
					operationTimeoutMs: 5,
					retryDelaysMs: [0],
					shutdownConnectionTimeoutMs: 50,
					shutdownOperationTimeoutMs: 200,
				},
				shellEnvironment(true)
			));
			await adapter.getState();

			const shutdown = adapter.shutdownWindowWorkspaces(4);
			await waitFor(() => firstShutdownCalls === 1);
			await assert.rejects(
				adapter.openWorkspace('/ambiguous'),
				/timed out after dispatch/
			);
			await waitFor(() => replacementShutdownCalls === 1);
			assert.strictEqual(
				await raceTimeout(shutdown.then(() => 'settled'), 20),
				undefined
			);
			void mainShutdown.complete();
			await shutdown;
			assert.strictEqual(firstShutdownCalls, 1);
			assert.strictEqual(replacementShutdownCalls, 1);
			assert.strictEqual(connectCalls, 2);
		}
	);

	test('bounds a silently hung dispatched shutdown', async () => {
		const hungShutdown = new DeferredPromise<void>();
		let shutdownCalls = 0;
		const shell = {
			onDidChangeState: Event.None,
			getState: async () => state('connected'),
			shutdownWindowWorkspaces: async () => {
				shutdownCalls++;
				return hungShutdown.p;
			},
		} as unknown as IHucodeShellControllerService;
		const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
			() => connectionAttempt(Promise.resolve(shell)),
			{
				shutdownConnectionTimeoutMs: 5,
				shutdownOperationTimeoutMs: 10,
			},
			shellEnvironment(true)
		));
		await adapter.getState();

		const shutdown = adapter.shutdownWindowWorkspaces(4);
		await waitFor(() => shutdownCalls === 1);
		assert.strictEqual(
			await raceTimeout(shutdown.then(() => 'settled'), 100),
			'settled'
		);
	});

	test('shutdown acquires a recovered connection after initial readiness expires',
		async () => {
			let connectCalls = 0;
			let shutdownCalls = 0;
			const shell = {
				onDidChangeState: Event.None,
				getState: async () => state('recovered'),
				shutdownWindowWorkspaces: async () => {
					shutdownCalls++;
				},
			} as unknown as IHucodeShellControllerService;
			const adapter = disposables.add(new DesktopShellControllerServiceAdapter(
				() => connectionAttempt(Promise.resolve(
					++connectCalls === 1 ? undefined : shell
				)),
				{
					connectionTimeoutMs: 5,
					retryDelaysMs: [20],
					shutdownConnectionTimeoutMs: 100,
				},
				shellEnvironment(true)
			));

			await assert.rejects(adapter.getState(), /capability is unavailable/);
			await adapter.shutdownWindowWorkspaces(4);
			assert.strictEqual(connectCalls, 2);
			assert.strictEqual(shutdownCalls, 1);
		}
	);

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
		await waitFor(() => connectionDisposed);
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

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			assert.fail('Timed out waiting for observable test state');
		}
		await new Promise<void>(resolve => setTimeout(resolve, 1));
	}
}
