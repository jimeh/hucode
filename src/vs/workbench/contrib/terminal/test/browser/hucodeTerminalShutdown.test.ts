/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { runWithFakedTimers } from
	'../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../../base/test/common/utils.js';
import { TestConfigurationService } from
	'../../../../../platform/configuration/test/common/testConfigurationService.js';
import {
	IConfirmation,
	IConfirmationResult,
	IDialogService,
} from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from
	'../../../../../platform/dialogs/test/common/testDialogService.js';
import { ITerminalBackend } from
	'../../../../../platform/terminal/common/terminal.js';
import { ILifecycleService, ShutdownReason } from
	'../../../../services/lifecycle/common/lifecycle.js';
import { TestLifecycleService, workbenchInstantiationService } from
	'../../../../test/browser/workbenchTestServices.js';
import {
	ITerminalInstanceService,
	ITerminalInstance,
	ITerminalGroupService,
	ITerminalService,
} from '../../browser/terminal.js';
import { TerminalService } from '../../browser/terminalService.js';
import { IRemoteAgentService } from
	'../../../../services/remote/common/remoteAgentService.js';

suite('Terminal hosted shutdown', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let terminalService: TerminalService;
	let lifecycleService: TestLifecycleService;
	let backend: TestPersistentTerminalBackend;
	let dialogService: CountingDialogService;

	setup(async () => {
		const instantiationService = workbenchInstantiationService({
			configurationService: () => new TestConfigurationService({
				files: {},
				terminal: {
					integrated: {
						confirmOnKill: 'never',
						confirmOnExit: 'always',
						enablePersistentSessions: true,
					},
				},
			}),
		}, disposables);
		dialogService = new CountingDialogService({
			confirmed: true,
		});
		instantiationService.stub(IDialogService, dialogService);
		instantiationService.stub(
			ITerminalInstanceService,
			'getBackend',
			undefined
		);
		instantiationService.stub(
			ITerminalInstanceService,
			'getRegisteredBackends',
			[]
		);
		instantiationService.stub(IRemoteAgentService, 'getConnection', null);
		lifecycleService = disposables.add(new TestLifecycleService());
		instantiationService.stub(ILifecycleService, lifecycleService);

		terminalService = disposables.add(
			instantiationService.createInstance(TerminalService)
		);
		instantiationService.stub(ITerminalService, terminalService);
		await timeout(0);
		backend = new TestPersistentTerminalBackend();
		Reflect.set(terminalService, '_primaryBackend', backend);
		setBackgroundedTerminal(terminalService, 13);
		const terminalGroupService = Reflect.get(
			terminalService,
			'_terminalGroupService'
		) as ITerminalGroupService;
		Reflect.set(terminalGroupService, 'instances', [createPersistentTerminal()]);
	});

	test('keeps web preparation side-effect free', async () => {
		Reflect.set(terminalService, '_platformIsWeb', true);

		assert.strictEqual(
			invokeBeforeShutdown(terminalService, ShutdownReason.QUIT),
			false
		);
		assert.strictEqual(dialogService.confirmCount, 0);
		await runWithFakedTimers({}, async () => saveState(terminalService));

		assert.deepStrictEqual(backend.layoutUpdates, [{
			tabs: [],
			background: [13],
		}]);
	});

	test('suppresses persistence after preparation until shutdown commits',
		async () => {
			assert.strictEqual(await prepareShutdown(lifecycleService), false);
			assert.strictEqual(dialogService.confirmCount, 1);

			await runWithFakedTimers({}, async () => saveState(terminalService));

			assert.deepStrictEqual(backend.layoutUpdates, []);
		});

	test('suppresses persistence while confirmation is pending and replays after refusal',
		async () => {
			enableProcessRevival(terminalService);
			const confirmation = dialogService.deferConfirmation();
			let preparation!: boolean | Promise<boolean>;
			await runWithFakedTimers({}, async () => {
				preparation = invokeBeforeShutdown(
					terminalService,
					ShutdownReason.QUIT
				);
				await dialogService.whenConfirmationRequested;
			});
			assert.strictEqual(backend.persistTerminalStateCalls, 1);

			await runWithFakedTimers({}, async () => saveState(terminalService));
			assert.deepStrictEqual(backend.layoutUpdates, []);

			setBackgroundedTerminal(terminalService, 21);
			await runWithFakedTimers({}, async () => saveState(terminalService));
			assert.deepStrictEqual(backend.layoutUpdates, []);

			await runWithFakedTimers({}, async () => {
				confirmation.complete({ confirmed: false });
				assert.strictEqual(await preparation, true);
			});

			assert.deepStrictEqual(backend.layoutUpdates, [{
				tabs: [],
				background: [21],
			}]);
		});

	test('does not suppress persistence when process preparation fails',
		async () => {
			enableProcessRevival(terminalService);
			backend.persistTerminalStateError = new Error('test persist failure');

			await runWithFakedTimers({}, async () => {
				assert.strictEqual(
					await invokeBeforeShutdown(
						terminalService,
						ShutdownReason.QUIT
					),
					false
				);
			});
			await runWithFakedTimers({}, async () => saveState(terminalService));

			assert.deepStrictEqual(backend.layoutUpdates, [{
				tabs: [],
				background: [13],
			}]);
		});

	test('replays suppressed persistence when confirmation rejects',
		async () => {
			enableProcessRevival(terminalService);
			const warnings: unknown[][] = [];
			Reflect.set(terminalService, '_logService', {
				warn: (...args: unknown[]) => warnings.push(args),
			});
			const confirmation = dialogService.deferConfirmation();
			let preparation!: boolean | Promise<boolean>;
			await runWithFakedTimers({}, async () => {
				preparation = invokeBeforeShutdown(
					terminalService,
					ShutdownReason.QUIT
				);
				await dialogService.whenConfirmationRequested;
			});
			assert.strictEqual(backend.persistTerminalStateCalls, 1);

			await runWithFakedTimers({}, async () => saveState(terminalService));
			setBackgroundedTerminal(terminalService, 21);
			await runWithFakedTimers({}, async () => saveState(terminalService));
			assert.deepStrictEqual(backend.layoutUpdates, []);

			await runWithFakedTimers({}, async () => {
				await confirmation.error(new Error('test confirmation failure'));
				assert.strictEqual(await preparation, false);
			});

			assert.strictEqual(warnings.length, 1);
			assert.deepStrictEqual(backend.layoutUpdates, [{
				tabs: [],
				background: [21],
			}]);

			await runWithFakedTimers({}, async () =>
				fireShutdownVeto(lifecycleService)
			);
			assert.deepStrictEqual(backend.layoutUpdates, [{
				tabs: [],
				background: [21],
			}]);
		});

	test('keeps persistence active when shutdown preparation is vetoed',
		async () => {
			disposables.add(lifecycleService.onBeforeShutdown(event => {
				event.veto(true, 'test.dirtyEditor');
			}));

			assert.strictEqual(await prepareShutdown(lifecycleService), true);
			assert.strictEqual(dialogService.confirmCount, 1);
			await Promise.resolve();
			await Promise.resolve();
			await runWithFakedTimers({}, async () => saveState(terminalService));

			assert.deepStrictEqual(backend.layoutUpdates, [{
				tabs: [],
				background: [13],
			}]);
		});

	test('resumes persistence after a later external veto', async () => {
		enableProcessRevival(terminalService);
		const confirmation = dialogService.deferConfirmation();
		const externalVeto = new DeferredPromise<boolean>();
		disposables.add(lifecycleService.onBeforeShutdown(event => {
			event.veto(externalVeto.p, 'test.laterVeto');
		}));

		let preparation!: Promise<boolean>;
		await runWithFakedTimers({}, async () => {
			preparation = prepareShutdown(lifecycleService);
			await dialogService.whenConfirmationRequested;
		});
		assert.strictEqual(backend.persistTerminalStateCalls, 1);
		await runWithFakedTimers({}, async () => saveState(terminalService));
		assert.deepStrictEqual(backend.layoutUpdates, []);

		setBackgroundedTerminal(terminalService, 21);
		await runWithFakedTimers({}, async () => saveState(terminalService));
		assert.deepStrictEqual(backend.layoutUpdates, []);

		confirmation.complete({ confirmed: true });
		await runWithFakedTimers({}, async () => {
			externalVeto.complete(true);
			assert.strictEqual(await preparation, true);
		});

		assert.deepStrictEqual(backend.layoutUpdates, [{
			tabs: [],
			background: [21],
		}]);
	});

	test('resumes persistence when shutdown preparation errors', async () => {
		assert.strictEqual(
			await invokeBeforeShutdown(terminalService, ShutdownReason.QUIT),
			false
		);
		await runWithFakedTimers({}, async () => saveState(terminalService));
		assert.deepStrictEqual(backend.layoutUpdates, []);

		setBackgroundedTerminal(terminalService, 21);
		await runWithFakedTimers({}, async () => saveState(terminalService));
		assert.deepStrictEqual(backend.layoutUpdates, []);

		await runWithFakedTimers({}, async () =>
			fireBeforeShutdownError(lifecycleService)
		);

		assert.deepStrictEqual(backend.layoutUpdates, [{
			tabs: [],
			background: [21],
		}]);

		await runWithFakedTimers({}, async () =>
			fireShutdownVeto(lifecycleService)
		);
		assert.deepStrictEqual(backend.layoutUpdates, [{
			tabs: [],
			background: [21],
		}]);
	});

	test('ignores terminal preparation that completes after an error', async () => {
		const preparation = invokeBeforeShutdown(
			terminalService,
			ShutdownReason.QUIT
		);
		fireBeforeShutdownError(lifecycleService);
		assert.strictEqual(await preparation, false);

		await runWithFakedTimers({}, async () => saveState(terminalService));

		assert.deepStrictEqual(backend.layoutUpdates, [{
			tabs: [],
			background: [13],
		}]);
	});

	test('transitions prepared persistence suppression to committed shutdown',
		async () => {
			enableProcessRevival(terminalService);
			const confirmation = dialogService.deferConfirmation();
			let preparation!: Promise<boolean>;
			await runWithFakedTimers({}, async () => {
				preparation = prepareShutdown(lifecycleService);
				await dialogService.whenConfirmationRequested;
			});
			assert.strictEqual(backend.persistTerminalStateCalls, 1);
			await runWithFakedTimers({}, async () => saveState(terminalService));
			assert.deepStrictEqual(backend.layoutUpdates, []);

			setBackgroundedTerminal(terminalService, 21);
			await runWithFakedTimers({}, async () => saveState(terminalService));
			assert.deepStrictEqual(backend.layoutUpdates, []);

			confirmation.complete({ confirmed: true });
			assert.strictEqual(await preparation, false);
			await runWithFakedTimers({}, async () =>
				lifecycleService.fireShutdown()
			);
			assert.deepStrictEqual(backend.layoutUpdates, []);
		});

	test('keeps replay state isolated across sequential shutdown attempts',
		async () => {
			assert.strictEqual(
				await invokeBeforeShutdown(terminalService, ShutdownReason.QUIT),
				false
			);
			await runWithFakedTimers({}, async () => saveState(terminalService));
			setBackgroundedTerminal(terminalService, 21);
			await runWithFakedTimers({}, async () => saveState(terminalService));

			await runWithFakedTimers({}, async () =>
				fireShutdownVeto(lifecycleService)
			);
			assert.deepStrictEqual(backend.layoutUpdates, [{
				tabs: [],
				background: [21],
			}]);

			assert.strictEqual(
				await invokeBeforeShutdown(terminalService, ShutdownReason.QUIT),
				false
			);
			setBackgroundedTerminal(terminalService, 34);
			await runWithFakedTimers({}, async () => saveState(terminalService));
			assert.deepStrictEqual(backend.layoutUpdates, [{
				tabs: [],
				background: [21],
			}]);

			await runWithFakedTimers({}, async () =>
				lifecycleService.fireShutdown()
			);
			assert.deepStrictEqual(backend.layoutUpdates, [{
				tabs: [],
				background: [21],
			}, undefined]);
		});

	test('preserves reload process revival through prepare and commit', async () => {
		const lifecycleCalls: TerminalLifecycleCalls = {
			detached: [],
			disposed: [],
		};
		const terminalGroupService = Reflect.get(
			terminalService,
			'_terminalGroupService'
		) as ITerminalGroupService;
		Reflect.set(terminalGroupService, 'instances', [
			createPersistentTerminal({
				persistentProcessId: 13,
				shouldPersist: true,
				lifecycleCalls,
			}),
			createPersistentTerminal({
				persistentProcessId: 21,
				shouldPersist: false,
				lifecycleCalls,
			}),
		]);
		setBackgroundedTerminal(terminalService, 34, {
			shouldPersist: true,
			lifecycleCalls,
		});

		assert.strictEqual(
			await invokeBeforeShutdown(terminalService, ShutdownReason.RELOAD),
			false
		);
		await runWithFakedTimers({}, async () => saveState(terminalService));
		assert.deepStrictEqual(backend.layoutUpdates, []);

		lifecycleService.fireShutdown(ShutdownReason.RELOAD);
		await runWithFakedTimers({}, async () => saveState(terminalService));

		assert.deepStrictEqual(backend.layoutUpdates, []);
		assert.deepStrictEqual(lifecycleCalls, {
			detached: [13, 34],
			disposed: [21],
		});
	});
});

class CountingDialogService extends TestDialogService {
	confirmCount = 0;
	private readonly _whenConfirmationRequested = new DeferredPromise<void>();
	private _deferredConfirmation?: DeferredPromise<IConfirmationResult>;

	get whenConfirmationRequested(): Promise<void> {
		return this._whenConfirmationRequested.p;
	}

	deferConfirmation(): DeferredPromise<IConfirmationResult> {
		this._deferredConfirmation = new DeferredPromise<IConfirmationResult>();
		return this._deferredConfirmation;
	}

	override async confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
		this.confirmCount++;
		this._whenConfirmationRequested.complete();
		if (this._deferredConfirmation) {
			return this._deferredConfirmation.p;
		}
		return super.confirm(confirmation);
	}
}

class TestPersistentTerminalBackend implements Partial<ITerminalBackend> {
	readonly layoutUpdates: Parameters<ITerminalBackend['setTerminalLayoutInfo']>[0][] = [];
	persistTerminalStateCalls = 0;
	persistTerminalStateError?: Error;

	async persistTerminalState(): Promise<void> {
		this.persistTerminalStateCalls++;
		if (this.persistTerminalStateError) {
			throw this.persistTerminalStateError;
		}
	}

	async setTerminalLayoutInfo(layout: Parameters<ITerminalBackend['setTerminalLayoutInfo']>[0]): Promise<void> {
		this.layoutUpdates.push(layout);
	}
}

interface TerminalLifecycleCalls {
	detached: number[];
	disposed: number[];
}

function createPersistentTerminal(options?: {
	persistentProcessId?: number;
	shouldPersist?: boolean;
	lifecycleCalls?: TerminalLifecycleCalls;
}): ITerminalInstance {
	const persistentProcessId = options?.persistentProcessId ?? 13;
	return {
		persistentProcessId,
		isDisposed: false,
		shouldPersist: options?.shouldPersist ?? false,
		onIconChanged: Event.None,
		dispose: () => {
			if (options?.lifecycleCalls) {
				options.lifecycleCalls.disposed.push(persistentProcessId);
			}
		},
		detachProcessAndDispose: async () => {
			if (options?.lifecycleCalls) {
				options.lifecycleCalls.detached.push(persistentProcessId);
			}
		},
		shellLaunchConfig: { forcePersist: true },
	} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
}

function setBackgroundedTerminal(
	terminalService: TerminalService,
	persistentProcessId: number,
	options?: {
		shouldPersist?: boolean;
		lifecycleCalls?: TerminalLifecycleCalls;
	}
): void {
	Reflect.set(terminalService, '_backgroundedTerminalInstances', [{
		instance: createPersistentTerminal({
			...options,
			persistentProcessId,
		}),
	}]);
}

function enableProcessRevival(terminalService: TerminalService): void {
	const terminalConfigurationService = Reflect.get(
		terminalService,
		'_terminalConfigurationService'
	) as { config: { persistentSessionReviveProcess: string } };
	terminalConfigurationService.config.persistentSessionReviveProcess = 'onExit';
}

function saveState(terminalService: TerminalService): void {
	const fn = Reflect.get(terminalService, '_saveState') as () => void;
	fn.call(terminalService);
}

function invokeBeforeShutdown(
	terminalService: TerminalService,
	reason: ShutdownReason
): boolean | Promise<boolean> {
	const fn = Reflect.get(terminalService, '_onBeforeShutdown') as (
		reason: ShutdownReason
	) => boolean | Promise<boolean>;
	return fn.call(terminalService, reason);
}

async function prepareShutdown(lifecycleService: TestLifecycleService): Promise<boolean> {
	const vetoes: (boolean | Promise<boolean>)[] = [];
	lifecycleService.fireBeforeShutdown({
		reason: ShutdownReason.QUIT,
		veto: value => vetoes.push(value),
		finalVeto: value => vetoes.push(value()),
	});

	const immediateVeto = vetoes.some(veto => veto === true);
	if (immediateVeto) {
		fireShutdownVeto(lifecycleService);
	}
	const veto = (await Promise.all(vetoes)).some(Boolean);
	if (veto && !immediateVeto) {
		fireShutdownVeto(lifecycleService);
	}
	return veto;
}

function fireShutdownVeto(lifecycleService: TestLifecycleService): void {
	const emitter = Reflect.get(lifecycleService, '_onShutdownVeto') as {
		fire(): void;
	};
	emitter.fire();
}

function fireBeforeShutdownError(lifecycleService: TestLifecycleService): void {
	const emitter = Reflect.get(lifecycleService, '_onBeforeShutdownError') as {
		fire(event: { reason: ShutdownReason; error: Error }): void;
	};
	emitter.fire({
		reason: ShutdownReason.QUIT,
		error: new Error('test shutdown error'),
	});
}
