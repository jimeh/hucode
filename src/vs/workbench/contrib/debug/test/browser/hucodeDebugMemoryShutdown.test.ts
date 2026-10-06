/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from
	'../../../../../platform/storage/common/storage.js';
import { BrowserLifecycleService } from
	'../../../../services/lifecycle/browser/lifecycleService.js';
import { DEBUG_MEMORY_SCHEME } from '../../common/debug.js';
import { registerDebugMemoryEditorShutdown } from
	'../../browser/hucodeDebugMemoryShutdown.js';
import { CustomEditorInput } from
	'../../../customEditor/browser/customEditorInput.js';
import { CustomEditorInputSerializer } from
	'../../../customEditor/browser/customEditorInputFactory.js';
import { IWebviewWorkbenchService } from
	'../../../webviewPanel/browser/webviewWorkbenchService.js';
import { IInstantiationService } from
	'../../../../../platform/instantiation/common/instantiation.js';
import { IWebviewService } from
	'../../../webview/browser/webview.js';

suite('Debug memory hosted shutdown', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createLifecycleService(): BrowserLifecycleService {
		return disposables.add(new BrowserLifecycleService(
			new NullLogService(),
			disposables.add(new InMemoryStorageService())
		));
	}

	test('retains debug-memory editors when shutdown preparation is vetoed',
		async () => {
			const lifecycleService = createLifecycleService();
			const debugEditor = createEditor(DEBUG_MEMORY_SCHEME);
			const regularEditor = createEditor('file');
			disposables.add(registerDebugMemoryEditorShutdown(
				lifecycleService,
				{ editors: [debugEditor, regularEditor] },
				() => { }
			));
			disposables.add(lifecycleService.onBeforeShutdown(event => {
				event.veto(true, 'test.dirtyEditor');
			}));

			assert.strictEqual(await lifecycleService.prepareShutdown(), true);
			assert.deepStrictEqual({
				debugDisposeCount: debugEditor.disposeCount,
				regularDisposeCount: regularEditor.disposeCount,
			}, {
				debugDisposeCount: 0,
				regularDisposeCount: 0,
			});
		});

	test('excludes custom debug-memory editors from persisted layouts', () => {
		let persistChecks = 0;
		const serializer = new CustomEditorInputSerializer(
			{
				shouldPersist: () => {
					persistChecks++;
					return true;
				}
			} as Partial<IWebviewWorkbenchService> as IWebviewWorkbenchService,
			{} as IInstantiationService,
			{} as IWebviewService
		);
		const debugMemoryInput = createCustomEditorInput(DEBUG_MEMORY_SCHEME);
		const regularCustomInput = createCustomEditorInput('file');

		assert.ok(debugMemoryInput instanceof CustomEditorInput);
		assert.strictEqual(debugMemoryInput.editorId, 'hexEditor.hexedit');
		assert.strictEqual(serializer.canSerialize(debugMemoryInput), false);
		assert.strictEqual(serializer.serialize(debugMemoryInput), undefined);
		assert.strictEqual(serializer.canSerialize(regularCustomInput), true);
		assert.strictEqual(persistChecks, 1);
	});

	test('disposes debug-memory editors only when shutdown commits', async () => {
		const lifecycleService = createLifecycleService();
		const debugEditor = createEditor(DEBUG_MEMORY_SCHEME);
		const regularEditor = createEditor('file');
		disposables.add(registerDebugMemoryEditorShutdown(
			lifecycleService,
			{ editors: [debugEditor, regularEditor] },
			() => { }
		));

		assert.strictEqual(await lifecycleService.prepareShutdown(), false);
		assert.strictEqual(debugEditor.disposeCount, 0);

		await lifecycleService.commitShutdown();

		assert.deepStrictEqual({
			debugDisposeCount: debugEditor.disposeCount,
			regularDisposeCount: regularEditor.disposeCount,
		}, {
			debugDisposeCount: 1,
			regularDisposeCount: 0,
		});
	});

	test('runs debug-memory cleanup before debug service disposal', async () => {
		const lifecycleService = createLifecycleService();
		const debugServiceDisposables = disposables.add(new DisposableStore());
		const shutdownOrder: string[] = [];
		const debugEditor = createEditor(DEBUG_MEMORY_SCHEME, () => {
			shutdownOrder.push('debug-memory-editor');
		});
		disposables.add(registerDebugMemoryEditorShutdown(
			lifecycleService,
			{ editors: [debugEditor] },
			() => {
				shutdownOrder.push('debug-service');
				debugServiceDisposables.dispose();
			}
		));
		debugServiceDisposables.add(lifecycleService.onWillShutdown(() => {
			assert.fail('debug service disposal should unregister later listeners');
		}));

		await lifecycleService.commitShutdown();

		assert.strictEqual(debugEditor.disposeCount, 1);
		assert.deepStrictEqual(shutdownOrder, [
			'debug-memory-editor',
			'debug-service',
		]);
	});
});

function createEditor(scheme: string, onDispose?: () => void): {
	readonly resource: URI;
	disposeCount: number;
	dispose(): void;
} {
	return {
		resource: URI.from({ scheme, path: '/memory' }),
		disposeCount: 0,
		dispose() {
			this.disposeCount++;
			onDispose?.();
		},
	};
}

function createCustomEditorInput(scheme: string): CustomEditorInput {
	const input = Object.create(CustomEditorInput.prototype) as CustomEditorInput;
	Reflect.set(input, '_editorResource', URI.from({ scheme, path: '/memory' }));
	Reflect.set(input, 'viewType', 'hexEditor.hexedit');
	return input;
}
