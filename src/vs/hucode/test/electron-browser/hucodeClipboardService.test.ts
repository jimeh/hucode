/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { IClipboardService } from
	'../../../platform/clipboard/common/clipboardService.js';
import { getSingletonServiceDescriptors } from
	'../../../platform/instantiation/common/extensions.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { INativeHostService } from
	'../../../platform/native/common/native.js';
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
} from '../../../platform/window/common/hucodeHostedShellService.js';
import { INativeWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/electron-browser/environmentService.js';
import { HucodeNativeClipboardService } from
	'../../electron-browser/hucodeClipboardService.js';

suite('Hucode Native Clipboard Service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('desktop registration selects the Hucode override', () => {
		const registrations = getSingletonServiceDescriptors().filter(
			([id]) => id === IClipboardService
		);
		assert.strictEqual(
			registrations.at(-1)?.[1].ctor,
			HucodeNativeClipboardService
		);
	});

	test('hosted paste is consumed without owner-window fallback', async () => {
		const calls: string[] = [];
		const service = createService(true, calls, async () => {
			calls.push('hostedPaste');
			return HucodeHostedShellOperationOutcome.Rejected;
		});

		await service.triggerPaste(7);
		assert.deepStrictEqual(calls, ['hostedPaste']);
	});

	test('ambiguous hosted paste failure still does not retry locally',
		async () => {
			const calls: string[] = [];
			const service = createService(true, calls, async () => {
				calls.push('hostedPaste');
				throw new Error('connection timed out');
			});

			await assert.rejects(
				service.triggerPaste(7),
				/connection timed out/
			);
			assert.deepStrictEqual(calls, ['hostedPaste']);
		}
	);

	test('ordinary workbench paste remains native', async () => {
		const calls: string[] = [];
		const service = createService(false, calls, async () => {
			throw new Error('hosted capability must not be called');
		});

		await service.triggerPaste(7);
		assert.deepStrictEqual(calls, ['nativePaste:7']);
	});
});

function createService(
	isHostedOmniWorkspace: boolean,
	calls: string[],
	triggerPasteInSelf: IHucodeHostedShellService['triggerPasteInSelf']
): HucodeNativeClipboardService {
	return new HucodeNativeClipboardService(
		{
			async triggerPaste(options: { readonly targetWindowId: number }) {
				calls.push(`nativePaste:${options.targetWindowId}`);
			},
		} as unknown as INativeHostService,
		new NullLogService(),
		{
			isHostedOmniWorkspace,
		} as INativeWorkbenchEnvironmentService,
		{
			triggerPasteInSelf,
		} as unknown as IHucodeHostedShellService
	);
}
