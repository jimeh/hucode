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

	test('forwards clipboard events from the Omni shell', async () => {
		const fixture = createFixture({
			isOmniWindow: true,
			channelResponse: true
		});
		const listener = fixture.forwarding.registerClipboardListeners(
			mainWindow.document
		);
		disposables.add(listener);

		const event = new mainWindow.Event('copy', {
			cancelable: true,
			bubbles: true
		});
		mainWindow.document.dispatchEvent(event);

		assert.strictEqual(event.defaultPrevented, true);
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
	readonly channelResponse?: boolean;
	readonly activeEditorResource?: URI;
}) {
	const windowId = 42;
	const channel = new TestChannel(options.channelResponse ?? false);
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
		forwarding: new HucodeOmniCommandForwarding(
			environmentService,
			mainProcessService,
			new NullLogService()
		),
		handlers,
		keybindingCalls,
		windowId
	};
}

class TestChannel implements IChannel {

	readonly calls: { command: string; arg?: unknown }[] = [];

	constructor(private readonly response: boolean) { }

	async call<T>(command: string, arg?: unknown): Promise<T> {
		this.calls.push({ command, arg });
		return this.response as T;
	}

	listen<T>(): Event<T> {
		return Event.None;
	}
}
