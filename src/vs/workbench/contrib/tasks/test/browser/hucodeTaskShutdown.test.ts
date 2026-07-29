/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserLifecycleService } from '../../../../services/lifecycle/browser/lifecycleService.js';
import { ShutdownReason } from '../../../../services/lifecycle/common/lifecycle.js';
import { TaskEventKind } from '../../common/tasks.js';
import { TerminalExitReason } from '../../../../../platform/terminal/common/terminal.js';
import { PersistentTaskAction, TaskShutdownState } from '../../browser/hucodeTaskShutdown.js';
import { TestLifecycleService } from '../../../../test/browser/workbenchTestServices.js';

suite('Task shutdown persistence', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createLifecycleService(): BrowserLifecycleService {
		return disposables.add(new BrowserLifecycleService(
			new NullLogService(),
			disposables.add(new InMemoryStorageService())
		));
	}

	test('keeps task reconnection metadata after a vetoed preparation', async () => {
		const lifecycleService = createLifecycleService();
		const shutdownState = disposables.add(new TaskShutdownState(lifecycleService));
		const persistentTasks = new Set<string>();
		disposables.add(lifecycleService.onBeforeShutdown(event => {
			event.veto(true, 'test.dirtyEditor');
		}));

		assert.strictEqual(await lifecycleService.prepareShutdown(), true);
		applyAction(persistentTasks, 'task', shutdownState.getPersistentTaskAction(
			TaskEventKind.Start,
			undefined,
			true
		));
		applyAction(persistentTasks, 'task', shutdownState.getPersistentTaskAction(
			TaskEventKind.Terminated,
			undefined,
			true
		));

		assert.deepStrictEqual([...persistentTasks], ['task']);
	});

	test('removes task metadata on committed close but preserves it on reload', async () => {
		const closeLifecycle = createLifecycleService();
		const closeState = disposables.add(new TaskShutdownState(closeLifecycle));
		const closeTasks = new Set(['task']);

		await closeLifecycle.commitShutdown();
		applyAction(closeTasks, 'task', closeState.getPersistentTaskAction(
			TaskEventKind.Terminated,
			undefined,
			true
		));
		assert.deepStrictEqual([...closeTasks], []);

		const reloadLifecycle = disposables.add(new TestLifecycleService());
		const reloadState = disposables.add(new TaskShutdownState(reloadLifecycle));
		const reloadTasks = new Set(['task']);

		reloadLifecycle.fireShutdown(ShutdownReason.RELOAD);
		applyAction(reloadTasks, 'task', reloadState.getPersistentTaskAction(
			TaskEventKind.Terminated,
			undefined,
			true
		));
		assert.deepStrictEqual([...reloadTasks], ['task']);
	});

	test('removes metadata for a user-terminated task outside shutdown', () => {
		const shutdownState = disposables.add(new TaskShutdownState(createLifecycleService()));

		assert.strictEqual(shutdownState.getPersistentTaskAction(
			TaskEventKind.Terminated,
			TerminalExitReason.User,
			true
		), PersistentTaskAction.Remove);
	});
});

function applyAction(
	persistentTasks: Set<string>,
	key: string,
	action: PersistentTaskAction
): void {
	switch (action) {
		case PersistentTaskAction.Save:
			persistentTasks.add(key);
			break;
		case PersistentTaskAction.Remove:
			persistentTasks.delete(key);
			break;
	}
}
