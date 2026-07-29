/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { runWithFakedTimers } from
	'../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../../base/test/common/utils.js';
import { TestConfigurationService } from
	'../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
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
import { prepareTerminalShutdown } from
	'../../browser/hucodeTerminalShutdown.js';

suite('Terminal hosted shutdown', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let terminalService: TerminalService;
	let lifecycleService: TestLifecycleService;
	let backend: TestPersistentTerminalBackend;

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
		instantiationService.stub(IDialogService, new TestDialogService({
			confirmed: true,
		}));
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

	test('returns synchronously without desktop preparation on web', () => {
		let desktopPrepareCount = 0;

		assert.strictEqual(prepareTerminalShutdown(true, () => {
			desktopPrepareCount++;
			return false;
		}), false);
		assert.strictEqual(desktopPrepareCount, 0);
	});

	test('keeps persistence active when shutdown preparation is vetoed',
		async () => {
			disposables.add(lifecycleService.onBeforeShutdown(event => {
				event.veto(true, 'test.dirtyEditor');
			}));

			assert.strictEqual(await prepareShutdown(lifecycleService), true);
			await Promise.resolve();
			await Promise.resolve();
			await runWithFakedTimers({}, async () => saveState(terminalService));

			assert.deepStrictEqual(backend.layoutUpdates, [{
				tabs: [],
				background: [13],
			}]);
		});

	test('stops persistence only when shutdown commits', async () => {
		lifecycleService.fireShutdown();
		assert.deepStrictEqual(backend.layoutUpdates, [undefined]);
		await runWithFakedTimers({}, async () => saveState(terminalService));

		assert.deepStrictEqual(backend.layoutUpdates, [undefined]);
	});
});

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

async function prepareShutdown(lifecycleService: TestLifecycleService): Promise<boolean> {
	const vetoes: (boolean | Promise<boolean>)[] = [];
	lifecycleService.fireBeforeShutdown({
		reason: ShutdownReason.QUIT,
		veto: value => vetoes.push(value),
		finalVeto: value => vetoes.push(value()),
	});

	return (await Promise.all(vetoes)).some(Boolean);
}
