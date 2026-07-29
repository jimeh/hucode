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
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from
	'../../../../../platform/storage/common/storage.js';
import { ITerminalBackend } from
	'../../../../../platform/terminal/common/terminal.js';
import { BrowserLifecycleService } from
	'../../../../services/lifecycle/browser/lifecycleService.js';
import { ILifecycleService } from
	'../../../../services/lifecycle/common/lifecycle.js';
import { workbenchInstantiationService } from
	'../../../../test/browser/workbenchTestServices.js';
import {
	ITerminalInstanceService,
	ITerminalInstance,
	ITerminalService,
} from '../../browser/terminal.js';
import { TerminalService } from '../../browser/terminalService.js';
import { IRemoteAgentService } from
	'../../../../services/remote/common/remoteAgentService.js';

suite('Terminal hosted shutdown', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let terminalService: TerminalService;
	let lifecycleService: BrowserLifecycleService;
	let backend: TestPersistentTerminalBackend;

	setup(async () => {
		const instantiationService = workbenchInstantiationService({
			configurationService: () => new TestConfigurationService({
				files: {},
				terminal: {
					integrated: {
						confirmOnKill: 'never',
						confirmOnExit: 'never',
						enablePersistentSessions: true,
					},
				},
			}),
		}, disposables);
		instantiationService.stub(IDialogService, new TestDialogService());
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
		lifecycleService = disposables.add(new BrowserLifecycleService(
			new NullLogService(),
			disposables.add(new InMemoryStorageService())
		));
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
	});

	test('keeps persistence active when shutdown preparation is vetoed',
		async () => {
			disposables.add(lifecycleService.onBeforeShutdown(event => {
				event.veto(true, 'test.dirtyEditor');
			}));

			assert.strictEqual(await lifecycleService.prepareShutdown(), true);
			await Promise.resolve();
			await Promise.resolve();
			await runWithFakedTimers({}, async () => saveState(terminalService));

			assert.strictEqual(backend.layoutUpdateCount, 1);
		});

	test('stops persistence only when shutdown commits', async () => {
		await lifecycleService.commitShutdown();
		assert.strictEqual(backend.layoutUpdateCount, 1);
		await runWithFakedTimers({}, async () => saveState(terminalService));

		assert.strictEqual(backend.layoutUpdateCount, 1);
	});
});

class TestPersistentTerminalBackend implements Partial<ITerminalBackend> {
	layoutUpdateCount = 0;

	async setTerminalLayoutInfo(): Promise<void> {
		this.layoutUpdateCount++;
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
