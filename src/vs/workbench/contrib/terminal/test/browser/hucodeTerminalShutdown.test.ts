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
		Reflect.set(terminalService, '_backgroundedTerminalInstances', [{
			instance: createPersistentTerminal(),
		}]);
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

	test('does not suppress persistence after confirmation refuses shutdown',
		async () => {
			dialogService.setConfirmResult({ confirmed: false });

			assert.strictEqual(
				await invokeBeforeShutdown(terminalService, ShutdownReason.QUIT),
				true
			);
			await runWithFakedTimers({}, async () => saveState(terminalService));

			assert.deepStrictEqual(backend.layoutUpdates, [{
				tabs: [],
				background: [13],
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
		const externalVeto = new DeferredPromise<boolean>();
		disposables.add(lifecycleService.onBeforeShutdown(event => {
			event.veto(externalVeto.p, 'test.laterVeto');
		}));

		const preparation = prepareShutdown(lifecycleService);
		await Promise.resolve();
		await Promise.resolve();
		await runWithFakedTimers({}, async () => saveState(terminalService));
		assert.deepStrictEqual(backend.layoutUpdates, []);

		externalVeto.complete(true);
		assert.strictEqual(await preparation, true);
		await runWithFakedTimers({}, async () => saveState(terminalService));

		assert.deepStrictEqual(backend.layoutUpdates, [{
			tabs: [],
			background: [13],
		}]);
	});

	test('resumes persistence when shutdown preparation errors', async () => {
		const preparation = invokeBeforeShutdown(
			terminalService,
			ShutdownReason.QUIT
		);
		fireBeforeShutdownError(lifecycleService);
		assert.strictEqual(
			await preparation,
			false
		);

		await runWithFakedTimers({}, async () => saveState(terminalService));

		assert.deepStrictEqual(backend.layoutUpdates, [{
			tabs: [],
			background: [13],
		}]);
	});

	test('transitions prepared persistence suppression to committed shutdown',
		async () => {
			assert.strictEqual(await prepareShutdown(lifecycleService), false);
			await runWithFakedTimers({}, async () => saveState(terminalService));
			assert.deepStrictEqual(backend.layoutUpdates, []);

			lifecycleService.fireShutdown();
			assert.deepStrictEqual(backend.layoutUpdates, [undefined]);
			await runWithFakedTimers({}, async () => saveState(terminalService));

			assert.deepStrictEqual(backend.layoutUpdates, [undefined]);
		});

	test('preserves reload process revival through prepare and commit', async () => {
		assert.strictEqual(
			await invokeBeforeShutdown(terminalService, ShutdownReason.RELOAD),
			false
		);
		await runWithFakedTimers({}, async () => saveState(terminalService));
		assert.deepStrictEqual(backend.layoutUpdates, []);

		lifecycleService.fireShutdown(ShutdownReason.RELOAD);
		await runWithFakedTimers({}, async () => saveState(terminalService));

		assert.deepStrictEqual(backend.layoutUpdates, []);
	});
});

class CountingDialogService extends TestDialogService {
	confirmCount = 0;

	override async confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
		this.confirmCount++;
		return super.confirm(confirmation);
	}
}

class TestPersistentTerminalBackend implements Partial<ITerminalBackend> {
	readonly layoutUpdates: Parameters<ITerminalBackend['setTerminalLayoutInfo']>[0][] = [];

	async setTerminalLayoutInfo(layout: Parameters<ITerminalBackend['setTerminalLayoutInfo']>[0]): Promise<void> {
		this.layoutUpdates.push(layout);
	}
}

function createPersistentTerminal(): ITerminalInstance {
	return {
		persistentProcessId: 13,
		isDisposed: false,
		onIconChanged: Event.None,
		dispose: () => { },
		detachProcessAndDispose: async () => { },
		shellLaunchConfig: { forcePersist: true },
	} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
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
