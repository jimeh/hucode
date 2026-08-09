/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	acquirePortOrUndefinedCancellable,
	IMessagePortAcquisitionHost,
} from '../../electron-browser/messagePortAcquisition.js';
import {
	HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
	IHucodeHostedShellState,
	isHucodeHostedShellServiceAvailable,
} from '../../../platform/window/common/hucodeHostedShellService.js';
import { HucodeHostedShellAction } from
	'../../../platform/window/common/hucodeHostedShellActions.js';
import { INativeWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/electron-browser/environmentService.js';
import {
	DesktopHostedShellServiceAdapter,
	IDesktopHostedShellConnectionAttempt,
	IDesktopHostedShellConnectionOptions,
} from
	'../../electron-browser/hostedShellServiceAdapter.js';

suite('DesktopHostedShellServiceAdapter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('returns unavailable while connecting then delegates to the narrow connection',
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
				() => createAttempt(connection.p),
				createHostedEnvironment(),
				createImmediateOptions()
			));
			const forwardedStates: IHucodeHostedShellState[] = [];
			disposables.add(adapter.onDidChangeState(value =>
				forwardedStates.push(value)
			));

			assert.deepStrictEqual(
				await adapter.getState(),
				HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE
			);
			assert.strictEqual(
				isHucodeHostedShellServiceAvailable(adapter),
				false
			);
			void connection.complete(shell);
			await settled();
			assert.strictEqual(
				isHucodeHostedShellServiceAvailable(adapter),
				true
			);
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

	test('disposal cancels a pending connection and disposes a late client', async () => {
		const connection =
			new DeferredPromise<IHucodeHostedShellService | undefined>();
		let attemptDisposed = false;
		let connectionDisposed = false;
		const adapter = new DesktopHostedShellServiceAdapter(
			() => createAttempt(connection.p, () => attemptDisposed = true),
			createHostedEnvironment(),
			createImmediateOptions()
		);
		const operation = adapter.closeSelf();
		adapter.dispose();
		assert.strictEqual(attemptDisposed, true);
		assert.strictEqual(
			isHucodeHostedShellServiceAvailable(adapter),
			false
		);
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

	test('recovers after a denied acquisition', async () => {
		const timers = new ManualTimers();
		const second = new DeferredPromise<
			IHucodeHostedShellService | undefined
		>();
		let attempts = 0;
		const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
			() => {
				attempts++;
				return createAttempt(attempts === 1
					? Promise.resolve(undefined)
					: second.p);
			},
			createHostedEnvironment(),
			timers.options
		));

		await settled();
		assert.strictEqual(attempts, 1);
		timers.fireNext(10);
		assert.strictEqual(attempts, 2);
		void second.complete(createAcceptedShell());
		await settled();
		assert.strictEqual(
			await adapter.closeSelf(),
			HucodeHostedShellOperationOutcome.Accepted
		);
	});

	test('times out acquisition, retries, and closes a late client', async () => {
		const timers = new ManualTimers();
		const first = new DeferredPromise<
			IHucodeHostedShellService | undefined
		>();
		const second = new DeferredPromise<
			IHucodeHostedShellService | undefined
		>();
		let attempts = 0;
		let firstAttemptDisposed = false;
		let lateClientDisposed = false;
		const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
			() => {
				attempts++;
				return createAttempt(
					attempts === 1 ? first.p : second.p,
					attempts === 1
						? () => firstAttemptDisposed = true
						: undefined
				);
			},
			createHostedEnvironment(),
			timers.options
		));

		timers.fireNext(50);
		assert.strictEqual(firstAttemptDisposed, true);
		timers.fireNext(10);
		assert.strictEqual(attempts, 2);
		void first.complete(Object.assign(createAcceptedShell(), {
			dispose: () => lateClientDisposed = true,
		}));
		void second.complete(createAcceptedShell());
		await settled();
		assert.strictEqual(lateClientDisposed, true);
		assert.strictEqual(isHucodeHostedShellServiceAvailable(adapter), true);
	});

	test('response timeout reacquires without replaying the operation', async () => {
		const timers = new ManualTimers();
		const never = new DeferredPromise<HucodeHostedShellOperationOutcome>();
		let operationCalls = 0;
		let attempts = 0;
		let firstShellDisposed = false;
		const firstShell = Object.assign(createAcceptedShell(), {
			closeSelf: async () => {
				operationCalls++;
				return never.p;
			},
			dispose: () => firstShellDisposed = true,
		});
		const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
			() => createAttempt(Promise.resolve(
				++attempts === 1 ? firstShell : createAcceptedShell()
			)),
			createHostedEnvironment(),
			timers.options
		));
		await settled();

		const operation = adapter.closeSelf();
		await settled();
		timers.fireNext(70);
		assert.strictEqual(
			await operation,
			HucodeHostedShellOperationOutcome.Unavailable
		);
		assert.strictEqual(operationCalls, 1);
		assert.strictEqual(firstShellDisposed, true);
		timers.fireNext(10);
		await settled();
		assert.strictEqual(attempts, 2);
		assert.strictEqual(operationCalls, 1);
		assert.strictEqual(
			await adapter.closeSelf(),
			HucodeHostedShellOperationOutcome.Accepted
		);
	});

	test('ignores a late state result from a timed-out connection', async () => {
		const timers = new ManualTimers();
		const lateState = new DeferredPromise<IHucodeHostedShellState>();
		const secondChanges = disposables.add(new Emitter<IHucodeHostedShellState>());
		const firstState: IHucodeHostedShellState = {
			available: true,
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			lifecycleState: 'active',
			active: true,
			visible: true,
		};
		const secondState = {
			...firstState,
			projectsSidebarVisible: false,
		};
		let firstStateCalls = 0;
		let attempts = 0;
		const firstShell = Object.assign(createAcceptedShell(), {
			getState: async () => ++firstStateCalls === 1
				? firstState
				: lateState.p,
		});
		const secondShell = Object.assign(createAcceptedShell(), {
			onDidChangeState: secondChanges.event,
			getState: async () => secondState,
		});
		const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
			() => createAttempt(Promise.resolve(
				++attempts === 1 ? firstShell : secondShell
			)),
			createHostedEnvironment(),
			timers.options
		));
		const forwardedStates: IHucodeHostedShellState[] = [];
		disposables.add(adapter.onDidChangeState(state => forwardedStates.push(state)));
		await settled();

		const timedOutState = adapter.getState();
		await settled();
		timers.fireNext(70);
		assert.deepStrictEqual(
			await timedOutState,
			HUCODE_UNAVAILABLE_HOSTED_SHELL_STATE
		);
		timers.fireNext(10);
		await settled();
		assert.strictEqual(attempts, 2);
		assert.deepStrictEqual(await adapter.getState(), secondState);

		const forwardedBeforeLateState = forwardedStates.length;
		void lateState.complete(firstState);
		await settled();
		secondChanges.fire(secondState);
		assert.strictEqual(forwardedStates.length, forwardedBeforeLateState);
	});

	test('stale generation outcome reacquires without replaying the operation',
		async () => {
			const timers = new ManualTimers();
			let operationCalls = 0;
			let attempts = 0;
			const firstShell = Object.assign(createAcceptedShell(), {
				closeSelf: async () => {
					operationCalls++;
					return HucodeHostedShellOperationOutcome.Stale;
				},
			});
			const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
				() => createAttempt(Promise.resolve(
					++attempts === 1 ? firstShell : createAcceptedShell()
				)),
				createHostedEnvironment(),
				timers.options
			));
			await settled();

			assert.strictEqual(
				await adapter.closeSelf(),
				HucodeHostedShellOperationOutcome.Stale
			);
			assert.strictEqual(operationCalls, 1);
			assert.strictEqual(
				isHucodeHostedShellServiceAvailable(adapter),
				false
			);
			timers.fireNext(10);
			await settled();
			assert.strictEqual(attempts, 2);
			assert.strictEqual(operationCalls, 1);
			assert.strictEqual(
				await adapter.closeSelf(),
				HucodeHostedShellOperationOutcome.Accepted
			);
		});

	test('application rejection preserves concurrent non-idempotent success',
		async () => {
			const timers = new ManualTimers();
			const accepted = new DeferredPromise<
				HucodeHostedShellOperationOutcome
			>();
			let attempts = 0;
			let reloadCalls = 0;
			const shell = Object.assign(createAcceptedShell(), {
				closeSelf: async () => {
					throw new Error('application rejected request');
				},
				reloadSelf: async () => {
					reloadCalls++;
					return accepted.p;
				},
			});
			const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
				() => {
					attempts++;
					return createAttempt(Promise.resolve(shell));
				},
				createHostedEnvironment(),
				timers.options
			));
			await settled();

			const successful = adapter.reloadSelf();
			assert.strictEqual(
				await adapter.closeSelf(),
				HucodeHostedShellOperationOutcome.Rejected
			);
			void accepted.complete(HucodeHostedShellOperationOutcome.Accepted);
			assert.strictEqual(
				await successful,
				HucodeHostedShellOperationOutcome.Accepted
			);
			assert.strictEqual(reloadCalls, 1);
			assert.strictEqual(attempts, 1);
			assert.strictEqual(isHucodeHostedShellServiceAvailable(adapter), true);
		});

	test('application rejection preserves readiness and state availability',
		async () => {
			const timers = new ManualTimers();
			const connectedState: IHucodeHostedShellState = {
				available: true,
				projectsSidebarVisible: true,
				projectSwitcherCanGoBack: false,
				projectSwitcherCanGoForward: false,
				lifecycleState: 'active',
				active: true,
				visible: true,
			};
			let stateCalls = 0;
			let attempts = 0;
			const shell = Object.assign(createAcceptedShell(), {
				getState: async () => {
					if (++stateCalls === 1) {
						return connectedState;
					}
					throw new Error('application rejected state request');
				},
				notifyReady: async () => {
					throw new Error('application rejected readiness');
				},
			});
			const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
				() => {
					attempts++;
					return createAttempt(Promise.resolve(shell));
				},
				createHostedEnvironment(),
				timers.options
			));
			await settled();

			assert.deepStrictEqual(await adapter.getState(), connectedState);
			assert.deepStrictEqual(await adapter.notifyReady(), {
				outcome: HucodeHostedShellOperationOutcome.Rejected,
			});
			assert.strictEqual(
				await adapter.closeSelf(),
				HucodeHostedShellOperationOutcome.Accepted
			);
			assert.strictEqual(attempts, 1);
			assert.strictEqual(isHucodeHostedShellServiceAvailable(adapter), true);
		});

	test('transport cancellation stays unavailable without invalidation',
		async () => {
			let closeCalls = 0;
			const shell = Object.assign(createAcceptedShell(), {
				closeSelf: async () => {
					if (++closeCalls === 1) {
						throw new CancellationError();
					}
					return HucodeHostedShellOperationOutcome.Accepted;
				},
			});
			const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
				() => createAttempt(Promise.resolve(shell)),
				createHostedEnvironment(),
				createImmediateOptions()
			));
			await settled();

			assert.strictEqual(
				await adapter.closeSelf(),
				HucodeHostedShellOperationOutcome.Unavailable
			);
			assert.strictEqual(isHucodeHostedShellServiceAvailable(adapter), true);
			assert.strictEqual(
				await adapter.closeSelf(),
				HucodeHostedShellOperationOutcome.Accepted
			);
		});

	test('returns a success completed after concurrent timeout invalidation',
		async () => {
			const timers = new ManualTimers();
			const accepted = new DeferredPromise<
				HucodeHostedShellOperationOutcome
			>();
			const never = new DeferredPromise<HucodeHostedShellOperationOutcome>();
			let reloadCalls = 0;
			const shell = Object.assign(createAcceptedShell(), {
				closeSelf: async () => never.p,
				reloadSelf: async () => {
					reloadCalls++;
					return accepted.p;
				},
			});
			const adapter = disposables.add(new DesktopHostedShellServiceAdapter(
				() => createAttempt(Promise.resolve(shell)),
				createHostedEnvironment(),
				timers.options
			));
			await settled();

			const successful = adapter.reloadSelf();
			const timedOut = adapter.closeSelf();
			await settled();
			timers.fireNext(70);
			assert.strictEqual(
				await timedOut,
				HucodeHostedShellOperationOutcome.Unavailable
			);
			void accepted.complete(HucodeHostedShellOperationOutcome.Accepted);
			assert.strictEqual(
				await successful,
				HucodeHostedShellOperationOutcome.Accepted
			);
			assert.strictEqual(reloadCalls, 1);
		});
});

suite('Hucode desktop MessagePort acquisition', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('cleans renderer and preload listeners on success and denial', async () => {
		for (const port of [createTestPort(), undefined]) {
			const host = new FakeAcquisitionHost();
			const acquisition = acquirePortOrUndefinedCancellable(
				'vscode:request',
				'vscode:response',
				'nonce',
				host
			);
			host.emit('nonce', port);
			assert.strictEqual(await acquisition.promise, port);
			assert.deepStrictEqual(host.counts, {
				added: 1,
				removed: 1,
				acquired: 1,
				cancelled: 1,
				sent: 1,
			});
		}
	});

	test('dispose cleans exactly once and closes an already-dispatched late port',
		async () => {
			const host = new FakeAcquisitionHost();
			const acquisition = acquirePortOrUndefinedCancellable(
				'vscode:request',
				'vscode:response',
				'nonce',
				host
			);
			const dispatchedListener = host.listener;
			acquisition.dispose();
			acquisition.dispose();
			assert.strictEqual(await acquisition.promise, undefined);
			let closed = 0;
			dispatchedListener?.(createPortEvent('nonce', createTestPort(
				() => closed++
			)));
			assert.strictEqual(closed, 1);
			assert.deepStrictEqual(host.counts, {
				added: 1,
				removed: 1,
				acquired: 1,
				cancelled: 1,
				sent: 1,
			});
		});

	test('synchronous request failure cleans both listener layers', () => {
		const host = new FakeAcquisitionHost();
		host.throwOnSend = true;
		assert.throws(() => acquirePortOrUndefinedCancellable(
			'vscode:request',
			'vscode:response',
			'nonce',
			host
		), /request failed/);
		assert.deepStrictEqual(host.counts, {
			added: 1,
			removed: 1,
			acquired: 1,
			cancelled: 1,
			sent: 1,
		});
	});
});

class FakeAcquisitionHost implements IMessagePortAcquisitionHost {
	listener: ((event: MessageEvent) => void) | undefined;
	throwOnSend = false;
	readonly counts = {
		added: 0,
		removed: 0,
		acquired: 0,
		cancelled: 0,
		sent: 0,
	};

	addMessageListener(listener: (event: MessageEvent) => void): void {
		this.counts.added++;
		this.listener = listener;
	}

	removeMessageListener(listener: (event: MessageEvent) => void): void {
		this.counts.removed++;
		if (this.listener === listener) {
			this.listener = undefined;
		}
	}

	acquire(): void {
		this.counts.acquired++;
	}

	cancel(): void {
		this.counts.cancelled++;
	}

	send(): void {
		this.counts.sent++;
		if (this.throwOnSend) {
			throw new Error('request failed');
		}
	}

	emit(nonce: string, port: MessagePort | undefined): void {
		this.listener?.(createPortEvent(nonce, port));
	}
}

function createPortEvent(
	nonce: string,
	port: MessagePort | undefined
): MessageEvent {
	return {
		data: nonce,
		ports: port ? [port] : [],
		source: mainWindow,
	} as unknown as MessageEvent;
}

function createTestPort(onClose?: () => void): MessagePort {
	return {
		onmessage: null,
		onmessageerror: null,
		close: () => onClose?.(),
		postMessage() { },
		start() { },
		addEventListener() { },
		removeEventListener() { },
		dispatchEvent: () => true,
	};
}

function createAttempt(
	promise: Promise<IHucodeHostedShellService | undefined>,
	onDispose?: () => void
): IDesktopHostedShellConnectionAttempt {
	let disposed = false;
	return {
		promise,
		dispose() {
			if (!disposed) {
				disposed = true;
				onDispose?.();
			}
		},
	};
}

function createAcceptedShell(): IHucodeHostedShellService {
	return {
		...createUnavailableShell(),
		getState: async () => ({
			available: true,
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			lifecycleState: 'active',
			active: true,
			visible: true,
		}),
		closeSelf: async () => HucodeHostedShellOperationOutcome.Accepted,
		notifyReady: async () => ({
			outcome: HucodeHostedShellOperationOutcome.Accepted,
		}),
	};
}

function createImmediateOptions(): IDesktopHostedShellConnectionOptions {
	return {
		acquisitionTimeoutMs: 1_000,
		operationTimeoutMs: 1_000,
		retryDelaysMs: [0],
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: handle => clearTimeout(handle),
	};
}

class ManualTimers {
	private nextHandle = 1;
	private readonly callbacks = new Map<number, {
		readonly callback: () => void;
		readonly delay: number;
	}>();

	readonly options: IDesktopHostedShellConnectionOptions = {
		acquisitionTimeoutMs: 50,
		operationTimeoutMs: 70,
		retryDelaysMs: [10],
		setTimeout: (callback, delay) => {
			const handle = this.nextHandle++;
			this.callbacks.set(handle, { callback, delay });
			return handle as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: handle => {
			this.callbacks.delete(handle as unknown as number);
		},
	};

	fireNext(delay: number): void {
		const entry = [...this.callbacks.entries()].reverse().find(
			([, value]) => value.delay === delay
		);
		assert.ok(entry, `Expected a pending ${delay}ms timer`);
		this.callbacks.delete(entry[0]);
		entry[1].callback();
	}
}

async function settled(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

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
