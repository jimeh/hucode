/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { CommandsRegistry } from
	'../../../platform/commands/common/commands.js';
import { InstantiationService } from
	'../../../platform/instantiation/common/instantiationService.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import {
	HucodeOmniCommandForwardingContext,
} from '../../../platform/window/common/hucodeOmniCommandRouting.js';
import type { INativeRunActionInWindowRequest } from
	'../../../platform/window/common/window.js';
import { NullExtensionService } from
	'../../../workbench/services/extensions/common/extensions.js';
import type { INativeWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/electron-browser/environmentService.js';
import type { IHucodeShellService } from '../../common/omniWindow.js';
import { OmniCommandService } from
	'../../electron-browser/omniCommandService.js';

suite('OmniCommandService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps surface recovery local without leaking to later commands',
		async () => {
			const commandId = 'hucode.test.forwarding-context';
			const unrelatedCommandId =
				'hucode.test.unrelated-forwarding-context';
			const shellCalls: {
				windowId: number;
				request: INativeRunActionInWindowRequest;
			}[] = [];
			const shellService = {
				runActionInWorkspace(
					windowId: number,
					request: INativeRunActionInWindowRequest
				): Promise<boolean> {
					shellCalls.push({ windowId, request });
					return Promise.resolve(true);
				},
			} as unknown as IHucodeShellService;
			const environmentService = {
				isOmniWindow: true,
				window: { id: 42 },
			} as Partial<INativeWorkbenchEnvironmentService> as
				INativeWorkbenchEnvironmentService;
			const commandForwardingContext =
				new HucodeOmniCommandForwardingContext();
			const commandForwardingScope =
				commandForwardingContext.createScope();
			const service = disposables.add(new OmniCommandService(
				new InstantiationService(),
				new NullExtensionService(),
				new NullLogService(),
				environmentService,
				shellService,
				commandForwardingContext
			));

			const projectSurface = mainWindow.document.createElement('div');
			projectSurface.className = 'hucode-omni-projects-view';
			const focusTarget = mainWindow.document.createElement('button');
			projectSurface.append(focusTarget);
			mainWindow.document.body.append(projectSurface);
			focusTarget.focus();
			disposables.add(toDisposable(() => projectSurface.remove()));

			let resolveLocalCommand!: () => void;
			const localCommandCompletion = new Promise<void>(resolve => {
				resolveLocalCommand = resolve;
			});
			let resolveLocalCommandStarted!: () => void;
			const localCommandStarted = new Promise<void>(resolve => {
				resolveLocalCommandStarted = resolve;
			});
			let localCommandCalls = 0;
			let unrelatedLocalCommandCalls = 0;
			disposables.add(CommandsRegistry.registerCommand(
				commandId,
				() => {
					localCommandCalls++;
					resolveLocalCommandStarted();
					return localCommandCompletion;
				}
			));
			disposables.add(CommandsRegistry.registerCommand(
				unrelatedCommandId,
				() => {
					unrelatedLocalCommandCalls++;
				}
			));

			await service.executeCommand(commandId);
			assert.strictEqual(shellCalls.length, 1);
			assert.strictEqual(localCommandCalls, 0);

			const localExecution =
				commandForwardingScope.runWithForwardingDisabledFor(
					commandId,
					() => service.executeCommand(commandId)
				);
			assert.strictEqual(shellCalls.length, 1);
			assert.strictEqual(
				commandForwardingContext.isForwardingDisabled,
				true
			);
			await localCommandStarted;
			assert.strictEqual(localCommandCalls, 1);

			await service.executeCommand(unrelatedCommandId);
			assert.strictEqual(shellCalls.length, 2);
			assert.strictEqual(unrelatedLocalCommandCalls, 0);

			resolveLocalCommand();
			await localExecution;
			assert.strictEqual(
				commandForwardingContext.isForwardingDisabled,
				false
			);

			await service.executeCommand(commandId);
			assert.strictEqual(shellCalls.length, 3);
			assert.strictEqual(localCommandCalls, 1);
			assert.deepStrictEqual(shellCalls, [
				{
					windowId: 42,
					request: {
						id: commandId,
						from: 'keybinding',
						args: undefined,
					},
				},
				{
					windowId: 42,
					request: {
						id: unrelatedCommandId,
						from: 'keybinding',
						args: undefined,
					},
				},
				{
					windowId: 42,
					request: {
						id: commandId,
						from: 'keybinding',
						args: undefined,
					},
				},
			]);
		}
	);
});
