/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ipcRenderer } from
	'../../../../../base/parts/sandbox/electron-browser/globals.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ShutdownReason } from '../../common/lifecycle.js';
import { NativeLifecycleService } from '../../electron-browser/lifecycleService.js';
import { workbenchInstantiationService } from '../../../../test/electron-browser/workbenchTestServices.js';

suite('Hucode lifecycle preparation rollback', () => {
	let lifecycleService: TestLifecycleService;
	let willUnloadListener: IpcRendererListener | undefined;
	const disposables = new DisposableStore();

	class TestLifecycleService extends NativeLifecycleService {
		beginPreparation(preparationId: string): void {
			super.beginShutdownPreparation(preparationId);
		}

		abandonPreparation(preparationId: string): boolean {
			return super.handleShutdownPreparationAbandoned(preparationId);
		}
	}

	setup(() => {
		const originalOn = ipcRenderer.on;
		const ipcRendererSpy = ipcRenderer as unknown as {
			on(
				channel: string,
				listener: IpcRendererListener
			): typeof ipcRenderer;
		};
		ipcRendererSpy.on = (channel, listener) => {
			if (channel === 'vscode:onWillUnload') {
				willUnloadListener = listener;
			}
			return originalOn.call(ipcRenderer, channel, listener);
		};
		try {
			const instantiationService =
				workbenchInstantiationService(undefined, disposables);
			lifecycleService = disposables.add(
				instantiationService.createInstance(TestLifecycleService)
			);
		} finally {
			ipcRendererSpy.on = originalOn;
		}
	});

	teardown(() => {
		willUnloadListener = undefined;
		disposables.clear();
	});

	test('fires the shutdown rollback observable for current preparation', () => {
		let vetoEvents = 0;
		disposables.add(lifecycleService.onShutdownVeto(() => vetoEvents++));
		lifecycleService.beginPreparation('preparation-1');

		const applied =
			lifecycleService.abandonPreparation('preparation-1');

		assert.strictEqual(applied, true);
		assert.strictEqual(vetoEvents, 1);
	});

	test('ignores abandonment from an older preparation', () => {
		let vetoEvents = 0;
		disposables.add(lifecycleService.onShutdownVeto(() => vetoEvents++));
		lifecycleService.beginPreparation('preparation-1');
		lifecycleService.beginPreparation('preparation-2');

		const stale =
			lifecycleService.abandonPreparation('preparation-1');
		assert.strictEqual(stale, false);
		assert.strictEqual(vetoEvents, 0);

		const applied =
			lifecycleService.abandonPreparation('preparation-2');
		assert.strictEqual(applied, true);
		assert.strictEqual(vetoEvents, 1);
	});

	test('legacy will-unload commits the current preparation', async () => {
		let vetoEvents = 0;
		disposables.add(lifecycleService.onShutdownVeto(() => vetoEvents++));
		lifecycleService.beginPreparation('preparation-1');

		assert.ok(willUnloadListener);
		await willUnloadListener(
			{} as Parameters<IpcRendererListener>[0],
			{
				replyChannel: 'test:onWillUnloadReply',
				reason: ShutdownReason.CLOSE,
			}
		);
		const stale =
			lifecycleService.abandonPreparation('preparation-1');

		assert.strictEqual(stale, false);
		assert.strictEqual(vetoEvents, 0);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});

type IpcRendererListener = (
	event: Parameters<Parameters<typeof ipcRenderer.on>[1]>[0],
	...args: unknown[]
) => void | Promise<void>;
