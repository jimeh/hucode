/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { ipcRenderer } from '../../../base/parts/sandbox/electron-browser/globals.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { INativeRunActionInWindowRequest, INativeRunKeybindingInWindowRequest } from '../../../platform/window/common/window.js';
import {
	FOCUS_WORKSPACE_COMMAND_ID,
	HucodeOmniCommandForwardingContext,
	OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
	OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID,
	UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
} from '../../../platform/window/common/hucodeOmniCommandRouting.js';
import {
	HucodeOmniCommandForwarding,
	IHucodeOmniCommandForwardingWindowHandlers,
} from '../../electron-browser/hucodeOmniCommandForwarding.js';
import { INativeWorkbenchEnvironmentService } from '../../services/environment/electron-browser/environmentService.js';

suite('HucodeOmniCommandForwarding', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('runs non-Omni menu actions locally with source metadata', async () => {
		const fixture = createFixture({ isOmniWindow: false });
		const request: INativeRunActionInWindowRequest = {
			id: 'workbench.action.test',
			from: 'menu'
		};

		await fixture.forwarding.handleRunActionInWindow(
			request,
			fixture.handlers
		);

		assert.deepStrictEqual(fixture.commandCalls, [{
			commandId: 'workbench.action.test',
			args: [{ from: 'menu' }]
		}]);
		assert.deepStrictEqual(fixture.actionExecutedCalls, [request]);
		assert.deepStrictEqual(fixture.channel.calls, []);
	});

	test('adds active editor resources to touch bar actions', async () => {
		const resource = URI.file('/workspace/file.txt');
		const fixture = createFixture({
			isOmniWindow: false,
			activeEditorResource: resource
		});
		const request: INativeRunActionInWindowRequest = {
			id: 'workbench.action.touchBar',
			from: 'touchbar'
		};

		await fixture.forwarding.handleRunActionInWindow(
			request,
			fixture.handlers
		);

		assert.deepStrictEqual(fixture.commandCalls, [{
			commandId: 'workbench.action.touchBar',
			args: [resource]
		}]);
	});

	test('forwards Omni workspace actions instead of running locally', async () => {
		const fixture = createFixture({
			isOmniWindow: true,
			channelResponse: true
		});
		const request: INativeRunActionInWindowRequest = {
			id: 'workbench.action.files.save',
			from: 'menu'
		};

		await fixture.forwarding.handleRunActionInWindow(
			request,
			fixture.handlers
		);

		assert.deepStrictEqual(fixture.commandCalls, []);
		assert.deepStrictEqual(fixture.actionExecutedCalls, []);
		assert.deepStrictEqual(fixture.channel.calls, [{
			command: 'runActionInWorkspace',
			arg: [fixture.windowId, request]
		}]);
	});

	test('blocks Omni shell layout actions when workspace forwarding misses', async () => {
		const fixture = createFixture({
			isOmniWindow: true,
			channelResponse: false
		});
		const request: INativeRunActionInWindowRequest = {
			id: 'workbench.action.togglePanel',
			from: 'menu'
		};

		await fixture.forwarding.handleRunActionInWindow(
			request,
			fixture.handlers
		);

		assert.deepStrictEqual(fixture.commandCalls, []);
		assert.deepStrictEqual(fixture.actionExecutedCalls, []);
		assert.deepStrictEqual(fixture.channel.calls, [{
			command: 'runActionInWorkspace',
			arg: [fixture.windowId, request]
		}]);
	});

	test('keeps Omni shell actions local', async () => {
		const fixture = createFixture({ isOmniWindow: true });
		const request: INativeRunActionInWindowRequest = {
			id: FOCUS_WORKSPACE_COMMAND_ID,
			from: 'menu'
		};

		await fixture.forwarding.handleRunActionInWindow(
			request,
			fixture.handlers
		);

		assert.deepStrictEqual(fixture.channel.calls, []);
		assert.deepStrictEqual(fixture.commandCalls, [{
			commandId: FOCUS_WORKSPACE_COMMAND_ID,
			args: [{ from: 'menu' }]
		}]);
	});

	test('keeps Omni unload current worktree action local', async () => {
		const fixture = createFixture({ isOmniWindow: true });
		const request: INativeRunActionInWindowRequest = {
			id: UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
			from: 'menu'
		};

		await fixture.forwarding.handleRunActionInWindow(
			request,
			fixture.handlers
		);

		assert.deepStrictEqual(fixture.channel.calls, []);
		assert.deepStrictEqual(fixture.commandCalls, [{
			commandId: UNLOAD_CURRENT_WORKTREE_COMMAND_ID,
			args: [{ from: 'menu' }]
		}]);
	});

	test('keeps Omni selected worktree open actions local', async () => {
		const fixture = createFixture({ isOmniWindow: true });

		for (const id of [
			OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID,
			OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
		]) {
			await fixture.forwarding.handleRunActionInWindow(
				{ id, from: 'menu' },
				fixture.handlers
			);
		}

		assert.deepStrictEqual(fixture.channel.calls, []);
		assert.deepStrictEqual(fixture.commandCalls, [{
			commandId: OPEN_SELECTED_IN_OMNI_WINDOW_COMMAND_ID,
			args: [{ from: 'menu' }]
		}, {
			commandId: OPEN_SELECTED_IN_NEW_WINDOW_COMMAND_ID,
			args: [{ from: 'menu' }]
		}]);
	});

	test('forwards Omni keybindings to the workspace', async () => {
		const fixture = createFixture({
			isOmniWindow: true,
			channelResponse: true
		});
		const request: INativeRunKeybindingInWindowRequest = {
			userSettingsLabel: 'ctrl+s'
		};

		await fixture.forwarding.handleRunKeybindingInWindow(
			request,
			fixture.handlers
		);

		assert.deepStrictEqual(fixture.keybindingCalls, []);
		assert.deepStrictEqual(fixture.channel.calls, [{
			command: 'runKeybindingInWorkspace',
			arg: [fixture.windowId, request]
		}]);
	});

	test('runs non-Omni keybindings against the active element', async () => {
		const button = mainWindow.document.createElement('button');
		mainWindow.document.body.appendChild(button);
		disposables.add({ dispose: () => button.remove() });
		button.focus();

		const fixture = createFixture({ isOmniWindow: false });
		const request: INativeRunKeybindingInWindowRequest = {
			userSettingsLabel: 'ctrl+s'
		};

		await fixture.forwarding.handleRunKeybindingInWindow(
			request,
			fixture.handlers
		);

		assert.deepStrictEqual(fixture.keybindingCalls, [{
			userSettingsLabel: 'ctrl+s',
			target: button
		}]);
		assert.deepStrictEqual(fixture.channel.calls, []);
	});

	test('suppresses only the forwarding surface handling a shell request', async () => {
		const commandForwardingContext =
			new HucodeOmniCommandForwardingContext();
		const firstFixture = createFixture({
			isOmniWindow: true,
			commandForwardingContext
		});
		const secondFixture = createFixture({
			isOmniWindow: true,
			commandForwardingContext
		});
		const request: INativeRunActionInWindowRequest = {
			id: 'workbench.action.files.save',
			from: 'keybinding',
			hucodeForwardedFromOmniShell: true
		};
		let resolveFirst!: () => void;
		const firstPending = new Promise<void>(resolve => {
			resolveFirst = resolve;
		});

		const firstRun =
			firstFixture.forwarding.runWithForwardingDisabledIfNeeded(
				request,
				() => {
					assert.strictEqual(
						firstFixture.commandForwardingScope.isForwardingDisabled,
						true
					);
					assert.strictEqual(
						secondFixture.commandForwardingScope.isForwardingDisabled,
						false
					);
					return firstPending;
				}
			);

		assert.strictEqual(
			firstFixture.commandForwardingScope.isForwardingDisabled,
			false
		);
		assert.strictEqual(commandForwardingContext.isForwardingDisabled, false);

		await secondFixture.forwarding.runWithForwardingDisabledIfNeeded(
			request,
			() => {
				assert.strictEqual(
					firstFixture.commandForwardingScope.isForwardingDisabled,
					false
				);
				assert.strictEqual(
					secondFixture.commandForwardingScope.isForwardingDisabled,
					true
				);
			}
		);

		resolveFirst();
		await firstRun;
	});

	test('forwards clipboard events from the Omni shell', async () => {
		const fixture = createFixture({
			isOmniWindow: true,
			channelResponse: true
		});
		const event = new mainWindow.Event('copy', {
			cancelable: true,
			bubbles: true
		});
		await fixture.forwarding.handleClipboardEvent(
			event,
			'editor.action.clipboardCopyAction',
			fixture.handlers
		);

		assert.strictEqual(event.defaultPrevented, true);
		assert.deepStrictEqual(fixture.commandCalls, []);
		assert.deepStrictEqual(fixture.channel.calls, [{
			command: 'runActionInWorkspace',
			arg: [
				fixture.windowId,
				{
					id: 'editor.action.clipboardCopyAction',
					from: 'menu'
				}
			]
		}]);
	});

	test('leaves native clipboard handling intact outside forwarding', () => {
		const fixture = createFixture({ isOmniWindow: false });
		const listener = fixture.forwarding.registerClipboardListeners(
			mainWindow.document,
			fixture.handlers
		);
		disposables.add(listener);
		const event = new mainWindow.Event('copy', {
			cancelable: true,
			bubbles: true
		});

		mainWindow.document.dispatchEvent(event);

		assert.strictEqual(event.defaultPrevented, false);
		assert.deepStrictEqual(fixture.channel.calls, []);
		assert.deepStrictEqual(fixture.commandCalls, []);
	});

	test('cancels registered clipboard events before deferred forwarding settles', async () => {
		let resolveChannel!: (forwarded: boolean) => void;
		const channelResponse = new Promise<boolean>(resolve => {
			resolveChannel = resolve;
		});
		const fixture = createFixture({
			isOmniWindow: true,
			channelResponse
		});
		const listener = fixture.forwarding.registerClipboardListeners(
			mainWindow.document,
			fixture.handlers
		);
		disposables.add(listener);
		const event = new mainWindow.Event('copy', {
			cancelable: true,
			bubbles: true
		});

		try {
			mainWindow.document.dispatchEvent(event);

			assert.strictEqual(event.defaultPrevented, true);
			assert.strictEqual(fixture.channel.calls.length, 1);
			assert.deepStrictEqual(fixture.commandCalls, []);

			resolveChannel(false);
			await fixture.commandExecuted;

			assert.strictEqual(fixture.channel.calls.length, 1);
			assert.deepStrictEqual(fixture.commandCalls, [{
				commandId: 'editor.action.clipboardCopyAction',
				args: []
			}]);
		} finally {
			resolveChannel(false);
		}
	});

	test('runs clipboard commands locally when forwarding declines', async () => {
		const fixture = createFixture({
			isOmniWindow: true,
			channelResponse: false
		});
		const event = new mainWindow.Event('copy', {
			cancelable: true,
			bubbles: true
		});

		await fixture.forwarding.handleClipboardEvent(
			event,
			'editor.action.clipboardCopyAction',
			fixture.handlers
		);

		assert.strictEqual(event.defaultPrevented, true);
		assert.deepStrictEqual(fixture.commandCalls, [{
			commandId: 'editor.action.clipboardCopyAction',
			args: []
		}]);
		assert.deepStrictEqual(fixture.commandSuppressionStates, [true]);
		assert.strictEqual(fixture.channel.calls.length, 1);
		assert.deepStrictEqual(fixture.actionErrorCalls, []);
	});

	test('leaves nested local clipboard fallback events unforwarded', async () => {
		const cases = [
			['copy', 'editor.action.clipboardCopyAction'],
			['cut', 'editor.action.clipboardCutAction'],
		] as const;

		for (const [eventType, actionId] of cases) {
			const fixture = createFixture({
				isOmniWindow: true,
				channelResponse: false
			});
			const originalExecuteCommand =
				fixture.handlers.executeCommand.bind(fixture.handlers);
			let nestedEvent:
				{ readonly defaultPrevented: boolean } | undefined;
			const nestedHandlers: IHucodeOmniCommandForwardingWindowHandlers = {
				...fixture.handlers,
				async executeCommand(commandId: string, ...args: unknown[]) {
					const execution = originalExecuteCommand(commandId, ...args);
					if (!nestedEvent) {
						const nextEvent = new mainWindow.Event(eventType, {
							cancelable: true,
							bubbles: true
						});
						nestedEvent = nextEvent;
						mainWindow.document.dispatchEvent(nextEvent);
					}
					await execution;
				}
			};
			const listener = fixture.forwarding.registerClipboardListeners(
				mainWindow.document,
				nestedHandlers
			);

			try {
				const event = new mainWindow.Event(eventType, {
					cancelable: true,
					bubbles: true
				});
				await fixture.forwarding.handleClipboardEvent(
					event,
					actionId,
					nestedHandlers
				);
				await Promise.resolve();

				assert.strictEqual(event.defaultPrevented, true);
				assert.strictEqual(nestedEvent?.defaultPrevented, false);
				assert.strictEqual(fixture.channel.calls.length, 1);
				assert.deepStrictEqual(fixture.commandCalls, [{
					commandId: actionId,
					args: []
				}]);
			} finally {
				listener.dispose();
			}
		}
	});

	test('reports local clipboard fallback failures once', async () => {
		const fallbackError = new Error('local clipboard failed');
		const fixture = createFixture({
			isOmniWindow: true,
			channelResponse: false,
			executeCommandError: fallbackError
		});
		const event = new mainWindow.Event('copy', {
			cancelable: true,
			bubbles: true
		});

		await fixture.forwarding.handleClipboardEvent(
			event,
			'editor.action.clipboardCopyAction',
			fixture.handlers
		);

		assert.strictEqual(event.defaultPrevented, true);
		assert.strictEqual(fixture.commandCalls.length, 1);
		assert.deepStrictEqual(fixture.commandSuppressionStates, [true]);
		assert.deepStrictEqual(fixture.actionErrorCalls, [fallbackError]);
		assert.strictEqual(
			fixture.commandForwardingScope.isForwardingDisabled,
			false
		);
	});

	test('runs clipboard commands locally when forwarding rejects', async () => {
		const fixture = createFixture({
			isOmniWindow: true,
			channelError: new Error('forwarding unavailable')
		});
		const event = new mainWindow.Event('cut', {
			cancelable: true,
			bubbles: true
		});

		await fixture.forwarding.handleClipboardEvent(
			event,
			'editor.action.clipboardCutAction',
			fixture.handlers
		);

		assert.strictEqual(event.defaultPrevented, true);
		assert.deepStrictEqual(fixture.commandCalls, [{
			commandId: 'editor.action.clipboardCutAction',
			args: []
		}]);
		assert.deepStrictEqual(fixture.commandSuppressionStates, [true]);
		assert.strictEqual(fixture.channel.calls.length, 1);
		assert.deepStrictEqual(fixture.actionErrorCalls, []);
	});

	test('disposes registered window IPC listeners', () => {
		const fixture = createFixture({ isOmniWindow: false });
		const originalOn = ipcRenderer.on;
		const originalRemoveListener = ipcRenderer.removeListener;
		const registrations: {
			channel: string;
			listener: IpcRendererListener;
		}[] = [];
		const removals: {
			channel: string;
			listener: IpcRendererListener;
		}[] = [];
		const ipcRendererSpy = ipcRenderer as unknown as {
			on(channel: string, listener: IpcRendererListener): typeof ipcRenderer;
			removeListener(
				channel: string,
				listener: IpcRendererListener
			): typeof ipcRenderer;
		};
		let registeredListener: { dispose(): void } | undefined;

		try {
			ipcRendererSpy.on = (channel, listener) => {
				registrations.push({ channel, listener });
				return originalOn.call(ipcRenderer, channel, listener);
			};
			ipcRendererSpy.removeListener = (channel, listener) => {
				removals.push({ channel, listener });
				return originalRemoveListener.call(ipcRenderer, channel, listener);
			};

			registeredListener = fixture.forwarding.registerWindowListeners(
				fixture.handlers
			);

			assert.deepStrictEqual(
				registrations.map(registration => registration.channel),
				['vscode:runAction', 'vscode:runKeybinding']
			);

			registeredListener.dispose();
			registeredListener = undefined;

			assert.deepStrictEqual(removals, registrations);
		} finally {
			registeredListener?.dispose();
			ipcRendererSpy.on = originalOn;
			ipcRendererSpy.removeListener = originalRemoveListener;
		}
	});
});

type IpcRendererListener = Parameters<typeof ipcRenderer.on>[1];

function createFixture(options: {
	readonly isOmniWindow: boolean;
	readonly channelResponse?: boolean | Promise<boolean>;
	readonly channelError?: Error;
	readonly activeEditorResource?: URI;
	readonly executeCommandError?: Error;
	readonly commandForwardingContext?:
	HucodeOmniCommandForwardingContext;
}) {
	const windowId = 42;
	const channel = new TestChannel(
		options.channelResponse ?? false,
		options.channelError
	);
	const commandForwardingContext = options.commandForwardingContext ??
		new HucodeOmniCommandForwardingContext();
	const commandForwardingScope =
		commandForwardingContext.createScope();
	const mainProcessService = {
		getChannel(channelName: string): IChannel {
			assert.strictEqual(channelName, 'hucodeShell');
			return channel;
		}
	} as Partial<IMainProcessService> as IMainProcessService;
	const environmentService = {
		isOmniWindow: options.isOmniWindow,
		window: { id: windowId }
	} as Partial<INativeWorkbenchEnvironmentService> as INativeWorkbenchEnvironmentService;

	const commandCalls: { commandId: string; args: unknown[] }[] = [];
	let resolveCommandExecuted!: () => void;
	const commandExecuted = new Promise<void>(resolve => {
		resolveCommandExecuted = resolve;
	});
	const commandSuppressionStates: boolean[] = [];
	const keybindingCalls: {
		userSettingsLabel: string;
		target: Element;
	}[] = [];
	const actionExecutedCalls: INativeRunActionInWindowRequest[] = [];
	const actionErrorCalls: unknown[] = [];

	const handlers: IHucodeOmniCommandForwardingWindowHandlers = {
		document: mainWindow.document,
		getActiveEditorResource: () => options.activeEditorResource,
		async executeCommand(commandId: string, ...args: unknown[]) {
			commandCalls.push({ commandId, args });
			resolveCommandExecuted();
			commandSuppressionStates.push(
				commandForwardingScope.isForwardingDisabled
			);
			if (options.executeCommandError) {
				throw options.executeCommandError;
			}
		},
		dispatchKeybinding(userSettingsLabel: string, target: Element) {
			keybindingCalls.push({ userSettingsLabel, target });
		},
		onActionExecuted(request: INativeRunActionInWindowRequest) {
			actionExecutedCalls.push(request);
		},
		onActionError(error: unknown) {
			actionErrorCalls.push(error);
		}
	};

	return {
		actionErrorCalls,
		actionExecutedCalls,
		channel,
		commandCalls,
		commandExecuted,
		commandSuppressionStates,
		commandForwardingContext,
		commandForwardingScope,
		forwarding: new HucodeOmniCommandForwarding(
			environmentService,
			mainProcessService,
			new NullLogService(),
			commandForwardingScope
		),
		handlers,
		keybindingCalls,
		windowId
	};
}

class TestChannel implements IChannel {

	readonly calls: { command: string; arg?: unknown }[] = [];

	constructor(
		private readonly response: boolean | Promise<boolean>,
		private readonly error?: Error
	) { }

	async call<T>(command: string, arg?: unknown): Promise<T> {
		this.calls.push({ command, arg });
		if (this.error) {
			throw this.error;
		}
		return await this.response as T;
	}

	listen<T>(): Event<T> {
		return Event.None;
	}
}
