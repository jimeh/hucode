/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { Handler } from '../../../editor/common/editorCommon.js';
import { CommandsRegistry, ICommandService } from
	'../../../platform/commands/common/commands.js';
import { InstantiationService } from
	'../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from
	'../../../platform/instantiation/common/serviceCollection.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import {
	HucodeOmniCommandForwardingContext,
} from '../../../platform/window/common/hucodeOmniCommandRouting.js';
import type { INativeRunActionInWindowRequest } from
	'../../../platform/window/common/window.js';
import { NullExtensionService } from
	'../../../workbench/services/extensions/common/extensions.js';
import type { IWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/common/environmentService.js';
import {
	HucodeShellControllerUnavailableError,
	IHucodeShellControllerService,
} from
	'../../../platform/window/common/hucodeShellControllerService.js';
import { OmniCommandService } from
	'../../browser/omniCommandService.js';
import { OmniWebClipboardForwardingContribution } from
	'../../browser/omniWebClipboardForwarding.contribution.js';
import { runHostedOmniWebCommand } from
	'../../browser/hostedOmniWorkspace.web.contribution.js';

class RecordingLogService extends NullLogService {
	readonly warnings: string[] = [];

	override warn(message: string, ..._args: unknown[]): void {
		this.warnings.push(message);
	}
}

suite('OmniCommandService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps surface recovery local without leaking to later commands',
		async () => {
			const commandId = 'hucode.test.forwarding-context';
			const unrelatedCommandId =
				'hucode.test.unrelated-forwarding-context';
			const shellCalls: INativeRunActionInWindowRequest[] = [];
			const shellService = {
				runActionInWorkspace(
					request: INativeRunActionInWindowRequest
				): Promise<boolean> {
					shellCalls.push(request);
					return Promise.resolve(true);
				},
			} as unknown as IHucodeShellControllerService;
			const environmentService = {
				isOmniWindow: true,
				window: { id: 42 },
			} as Partial<IWorkbenchEnvironmentService> as
				IWorkbenchEnvironmentService;
			const commandForwardingContext =
				new HucodeOmniCommandForwardingContext();
			const commandForwardingScope =
				commandForwardingContext.createScope();
			const instantiationService = new InstantiationService(
				new ServiceCollection([
					IHucodeShellControllerService,
					shellService,
				])
			);
			const service = disposables.add(new OmniCommandService(
				instantiationService,
				new NullExtensionService(),
				new NullLogService(),
				environmentService,
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
					id: commandId,
					from: 'keybinding',
					args: undefined,
				},
				{
					id: unrelatedCommandId,
					from: 'keybinding',
					args: undefined,
				},
				{
					id: commandId,
					from: 'keybinding',
					args: undefined,
				},
			]);
		}
	);

	test('forwards Projects clipboard events to the hosted workbench',
		async () => {
			const shellCalls: INativeRunActionInWindowRequest[] = [];
			const shellService = {
				runActionInWorkspace(
					request: INativeRunActionInWindowRequest
				): Promise<boolean> {
					shellCalls.push(request);
					return Promise.resolve(true);
				},
			} as unknown as IHucodeShellControllerService;
			const localCalls: string[] = [];
			const commandService = {
				executeCommand(commandId: string): Promise<void> {
					localCalls.push(commandId);
					return Promise.resolve();
				},
			} as unknown as ICommandService;
			const contribution = new OmniWebClipboardForwardingContribution(
				{
					isOmniShellWindow: true,
				} as IWorkbenchEnvironmentService,
				shellService,
				commandService,
				new NullLogService(),
				new HucodeOmniCommandForwardingContext()
			);
			const projectSurface = mainWindow.document.createElement('div');
			projectSurface.className = 'hucode-omni-projects-view';
			const focusTarget = mainWindow.document.createElement('button');
			projectSurface.append(focusTarget);
			mainWindow.document.body.append(projectSurface);
			focusTarget.focus();

			try {
				for (const [eventType, actionId] of [
					['copy', 'editor.action.clipboardCopyAction'],
					['cut', 'editor.action.clipboardCutAction'],
					['paste', 'editor.action.clipboardPasteAction'],
				] as const) {
					const event = new mainWindow.Event(eventType, {
						cancelable: true,
						bubbles: true,
					});
					await contribution.handleClipboardEvent(event, actionId);
					assert.strictEqual(event.defaultPrevented, true);
				}

				assert.deepStrictEqual(shellCalls, [
					{
						id: 'editor.action.clipboardCopyAction',
						from: 'menu',
					},
					{
						id: 'editor.action.clipboardCutAction',
						from: 'menu',
					},
					{
						id: 'editor.action.clipboardPasteAction',
						from: 'menu',
					},
				]);
				assert.deepStrictEqual(localCalls, []);
			} finally {
				projectSurface.remove();
				contribution.dispose();
			}
		});

	test('leaves Projects-input and non-shell clipboard events untouched',
		async () => {
			let shellCalls = 0;
			const contribution = new OmniWebClipboardForwardingContribution(
				{
					isOmniShellWindow: true,
				} as IWorkbenchEnvironmentService,
				{
					runActionInWorkspace(): Promise<boolean> {
						shellCalls++;
						return Promise.resolve(true);
					},
				} as unknown as IHucodeShellControllerService,
				{
					executeCommand(): Promise<void> {
						return Promise.resolve();
					},
				} as unknown as ICommandService,
				new NullLogService(),
				new HucodeOmniCommandForwardingContext()
			);
			const projectSurface = mainWindow.document.createElement('div');
			projectSurface.className = 'hucode-omni-projects-view';
			const input = mainWindow.document.createElement('input');
			projectSurface.append(input);
			mainWindow.document.body.append(projectSurface);
			input.focus();
			const event = new mainWindow.Event('paste', {
				cancelable: true,
				bubbles: true,
			});

			try {
				await contribution.handleClipboardEvent(
					event,
					'editor.action.clipboardPasteAction'
				);
				assert.strictEqual(event.defaultPrevented, false);
				assert.strictEqual(shellCalls, 0);
			} finally {
				projectSurface.remove();
				contribution.dispose();
			}

			const nonShellContribution =
				new OmniWebClipboardForwardingContribution(
					{
						isOmniShellWindow: false,
					} as IWorkbenchEnvironmentService,
					{
						runActionInWorkspace(): Promise<boolean> {
							shellCalls++;
							return Promise.resolve(true);
						},
					} as unknown as IHucodeShellControllerService,
					{
						executeCommand(): Promise<void> {
							return Promise.resolve();
						},
					} as unknown as ICommandService,
					new NullLogService(),
					new HucodeOmniCommandForwardingContext()
				);
			const nonShellSurface = mainWindow.document.createElement('div');
			nonShellSurface.className = 'hucode-omni-projects-view';
			const nonShellTarget = mainWindow.document.createElement('button');
			nonShellSurface.append(nonShellTarget);
			mainWindow.document.body.append(nonShellSurface);
			nonShellTarget.focus();
			const nonShellEvent = new mainWindow.Event('copy', {
				cancelable: true,
				bubbles: true,
			});

			try {
				await nonShellContribution.handleClipboardEvent(
					nonShellEvent,
					'editor.action.clipboardCopyAction'
				);
				assert.strictEqual(nonShellEvent.defaultPrevented, false);
				assert.strictEqual(shellCalls, 0);
			} finally {
				nonShellSurface.remove();
				nonShellContribution.dispose();
			}
		});

	test('consumes ambiguous clipboard forwarding failures', async () => {
		let localCalls = 0;
		const logService = new RecordingLogService();
		const contribution = new OmniWebClipboardForwardingContribution(
			{
				isOmniShellWindow: true,
			} as IWorkbenchEnvironmentService,
			{
				runActionInWorkspace(): Promise<boolean> {
					return Promise.reject(new Error('connection closed'));
				},
			} as unknown as IHucodeShellControllerService,
			{
				executeCommand(): Promise<void> {
					localCalls++;
					return Promise.resolve();
				},
			} as unknown as ICommandService,
			logService,
			new HucodeOmniCommandForwardingContext()
		);
		const projectSurface = mainWindow.document.createElement('div');
		projectSurface.className = 'hucode-omni-projects-view';
		const focusTarget = mainWindow.document.createElement('button');
		projectSurface.append(focusTarget);
		mainWindow.document.body.append(projectSurface);
		focusTarget.focus();
		const event = new mainWindow.Event('paste', {
			cancelable: true,
			bubbles: true,
		});

		try {
			await contribution.handleClipboardEvent(
				event,
				'editor.action.clipboardPasteAction'
			);
			assert.strictEqual(event.defaultPrevented, true);
			assert.strictEqual(localCalls, 0);
			assert.ok(logService.warnings.some(message =>
				message.includes('connection closed')
			));
		} finally {
			projectSurface.remove();
			contribution.dispose();
		}
	});

	test('falls back locally only before clipboard dispatch is available',
		async () => {
			const commandForwardingContext =
				new HucodeOmniCommandForwardingContext();
			let localSuppressed = false;
			let localCalls = 0;
			const logService = new RecordingLogService();
			const contribution = new OmniWebClipboardForwardingContribution(
				{
					isOmniShellWindow: true,
				} as IWorkbenchEnvironmentService,
				{
					runActionInWorkspace(): Promise<boolean> {
						return Promise.reject(
							new HucodeShellControllerUnavailableError()
						);
					},
				} as unknown as IHucodeShellControllerService,
				{
					executeCommand(commandId: string): Promise<void> {
						localCalls++;
						localSuppressed = commandForwardingContext
							.isForwardingDisabledFor(commandId);
						return Promise.reject(new Error('local fallback failed'));
					},
				} as unknown as ICommandService,
				logService,
				commandForwardingContext
			);
			const projectSurface = mainWindow.document.createElement('div');
			projectSurface.className = 'hucode-omni-projects-view';
			const focusTarget = mainWindow.document.createElement('button');
			projectSurface.append(focusTarget);
			mainWindow.document.body.append(projectSurface);
			focusTarget.focus();
			const event = new mainWindow.Event('cut', {
				cancelable: true,
				bubbles: true,
			});

			try {
				await contribution.handleClipboardEvent(
					event,
					'editor.action.clipboardCutAction'
				);
				assert.strictEqual(event.defaultPrevented, true);
				assert.strictEqual(localCalls, 1);
				assert.strictEqual(localSuppressed, true);
				assert.ok(logService.warnings.some(message =>
					message.includes('local fallback failed')
				));
			} finally {
				projectSurface.remove();
				contribution.dispose();
			}
		});

	test('runs remote cut through copy and the direct editor handler',
		async () => {
			let focusCalls = 0;
			const triggers: unknown[][] = [];
			const commandCalls: { id: string; args: unknown[] }[] = [];
			const codeEditorService = {
				getActiveCodeEditor() {
					return {
						focus(): void {
							focusCalls++;
						},
						trigger(...args: unknown[]): void {
							triggers.push(args);
						},
					};
				},
			};
			const commandService = {
				executeCommand(id: string, ...args: unknown[]): Promise<void> {
					commandCalls.push({ id, args });
					return Promise.resolve();
				},
			};

			await runHostedOmniWebCommand(
				'editor.action.clipboardCutAction',
				['ignored-cut-argument'],
				commandService,
				codeEditorService
			);
			await runHostedOmniWebCommand(
				'hucode.test.command',
				['payload'],
				commandService,
				codeEditorService
			);

			assert.strictEqual(focusCalls, 1);
			assert.deepStrictEqual(triggers, [
				[undefined, Handler.Cut, undefined],
			]);
			assert.deepStrictEqual(commandCalls, [
				{
					id: 'editor.action.clipboardCopyAction',
					args: [],
				},
				{
					id: 'hucode.test.command',
					args: ['payload'],
				},
			]);
		});
});
