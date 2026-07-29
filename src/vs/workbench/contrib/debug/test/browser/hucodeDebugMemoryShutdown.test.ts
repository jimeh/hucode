/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
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
				{ editors: [debugEditor, regularEditor] }
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

	test('disposes debug-memory editors only when shutdown commits', async () => {
		const lifecycleService = createLifecycleService();
		const debugEditor = createEditor(DEBUG_MEMORY_SCHEME);
		const regularEditor = createEditor('file');
		disposables.add(registerDebugMemoryEditorShutdown(
			lifecycleService,
			{ editors: [debugEditor, regularEditor] }
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
});

function createEditor(scheme: string): {
	readonly resource: URI;
	disposeCount: number;
	dispose(): void;
} {
	return {
		resource: URI.from({ scheme, path: '/memory' }),
		disposeCount: 0,
		dispose() {
			this.disposeCount++;
		},
	};
}
