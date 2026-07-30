/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION,
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
} from '../../../platform/window/common/hucodeOmniWebMessages.js';
import {
	HucodeHostedOmniWebConnectionService,
	IHostedOmniWebConnectionBrowserAdapter,
} from '../../browser/hostedOmniWebConnection.js';

const INSTANCE_ID = 'hosted-instance';

suite('HucodeHostedOmniWebConnectionService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(hasParent = true): {
		readonly service: HucodeHostedOmniWebConnectionService;
		readonly browser: FakeConnectionBrowserAdapter;
	} {
		const browser = new FakeConnectionBrowserAdapter(hasParent);
		const service = disposables.add(new HucodeHostedOmniWebConnectionService(
			browser,
			{
				_serviceBrand: undefined,
				isHostedOmniWorkspace: true,
				hostedInstanceId: INSTANCE_ID,
			}
		));
		return { service, browser };
	}

	function portMessage(overrides?: {
		readonly instanceId?: string;
		readonly windowId?: number;
	}): object {
		return {
			type: HucodeOmniWebParentMessageType.Port,
			instanceId: overrides?.instanceId ?? INSTANCE_ID,
			windowId: overrides?.windowId ?? 7,
		};
	}

	async function settled(): Promise<void> {
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}

	test('connects when the parent transfers the shell port', async () => {
		const { service, browser } = createService();

		browser.emitFromParent(portMessage(), new MessageChannel().port1);
		const connection = await service.whenConnected();

		assert.strictEqual(connection.shellWindowId, 7);
	});

	test('ignores port transfers from non-parent same-origin sources', async () => {
		const { service, browser } = createService();

		browser.emitFromStranger(
			portMessage({ windowId: 99 }),
			new MessageChannel().port1
		);
		await settled();
		browser.emitFromParent(portMessage(), new MessageChannel().port1);

		const connection = await service.whenConnected();
		assert.strictEqual(connection.shellWindowId, 7);
	});

	test('ignores port transfers for other instances or without a port', async () => {
		const { service, browser } = createService();
		let connected = false;
		void service.whenConnected().then(() => { connected = true; });

		browser.emitFromParent(
			portMessage({ instanceId: 'other-instance' }),
			new MessageChannel().port1
		);
		browser.emitFromParent(portMessage());
		await settled();

		assert.strictEqual(connected, false);
	});

	test('is not hosted without a parent window', async () => {
		const { service, browser } = createService(false);

		service.signalReady();
		service.notifyFocus(true);

		assert.deepStrictEqual({
			isHosted: service.isHosted,
			postedMessages: browser.postedMessages,
		}, {
			isHosted: false,
			postedMessages: [],
		});
	});

	test('posts bootstrap signals to the parent shell', () => {
		const { service, browser } = createService();

		service.signalReady();
		service.notifyFocus(false);

		// The shell decides how to unload a workbench from the version it
		// announces here, so a ready signal without one reads as a workbench
		// built before the unload handshake was split.
		assert.deepStrictEqual(browser.postedMessages, [
			{
				type: HucodeOmniWebChildMessageType.Ready,
				instanceId: INSTANCE_ID,
				protocolVersion: HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION,
			},
			{
				type: HucodeOmniWebChildMessageType.Focus,
				instanceId: INSTANCE_ID,
				focused: false,
			},
		]);
	});
});

class FakeConnectionBrowserAdapter
	implements IHostedOmniWebConnectionBrowserAdapter {

	readonly origin = location.origin;
	readonly postedMessages: object[] = [];

	private readonly listeners = new Set<(event: MessageEvent) => void>();

	constructor(private readonly parented: boolean) { }

	hasParent(): boolean {
		return this.parented;
	}

	isParentSource(source: MessageEventSource | null): boolean {
		return source === mainWindow;
	}

	postToParent(message: object): void {
		this.postedMessages.push(message);
	}

	addMessageListener(listener: (event: MessageEvent) => void): IDisposable {
		this.listeners.add(listener);
		return toDisposable(() => this.listeners.delete(listener));
	}

	emitFromParent(data: object, port?: MessagePort): void {
		this.emitMessage(data, mainWindow, port);
	}

	emitFromStranger(data: object, port?: MessagePort): void {
		this.emitMessage(data, null, port);
	}

	private emitMessage(
		data: object,
		source: MessageEventSource | null,
		port?: MessagePort
	): void {
		const event = new MessageEvent('message', {
			origin: this.origin,
			source,
			data,
			ports: port ? [port] : [],
		});
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}
