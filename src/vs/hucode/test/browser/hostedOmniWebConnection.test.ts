/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { Event } from '../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HUCODE_HOSTED_SHELL_CAPABILITIES,
	HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
	isHucodeHostedShellServiceAvailable,
} from '../../../platform/window/common/hucodeHostedShellService.js';
import {
	HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION,
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
} from '../../../platform/window/common/hucodeOmniWebMessages.js';
import {
	HucodeHostedOmniWebConnectionService,
	IHucodeHostedOmniWebConnectionService,
	IHostedOmniWebConnectionOptions,
	IHostedOmniWebConnectionBrowserAdapter,
} from '../../browser/hostedOmniWebConnection.js';
import {
	HostedOmniWebShellService,
} from
	'../../browser/hostedOmniWebShellService.js';

const INSTANCE_ID = 'hosted-instance';

suite('HucodeHostedOmniWebConnectionService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(
		hasParent = true,
		browser: FakeConnectionBrowserAdapter =
			new FakeConnectionBrowserAdapter(hasParent),
		options?: IHostedOmniWebConnectionOptions
	): {
		readonly service: HucodeHostedOmniWebConnectionService;
		readonly browser: FakeConnectionBrowserAdapter;
	} {
		const service = disposables.add(new HucodeHostedOmniWebConnectionService(
			browser,
			{
				_serviceBrand: undefined,
				isHostedOmniWorkspace: true,
				hostedInstanceId: INSTANCE_ID,
			},
			options
		));
		return { service, browser };
	}

	function portMessage(
		connectionBootstrap: { readonly id: string; readonly attempt: number },
		overrides?: {
			readonly instanceId?: string;
			readonly hostedShellProtocolVersion?: number;
			readonly hostedShellCapabilities?: readonly string[];
		}): object {
		return {
			type: HucodeOmniWebParentMessageType.Port,
			instanceId: overrides?.instanceId ?? INSTANCE_ID,
			connectionBootstrap,
			hostedShellProtocolVersion: overrides?.hostedShellProtocolVersion ??
				HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			hostedShellCapabilities: overrides?.hostedShellCapabilities ??
				HUCODE_HOSTED_SHELL_CAPABILITIES,
		};
	}

	function postedBootstrap(browser: FakeConnectionBrowserAdapter): {
		readonly id: string;
		readonly attempt: number;
	} {
		const ready = browser.postedMessages.at(-1) as {
			readonly connectionBootstrap?: {
				readonly id: string;
				readonly attempt: number;
			};
		};
		assert.ok(ready.connectionBootstrap);
		return ready.connectionBootstrap;
	}

	function trackedPort(): {
		readonly port: MessagePort;
		readonly wasClosed: () => boolean;
	} {
		const port = new MessageChannel().port1;
		const close = port.close.bind(port);
		let closed = false;
		port.close = () => {
			closed = true;
			close();
		};
		return { port, wasClosed: () => closed };
	}

	async function settled(): Promise<void> {
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}

	test('connects when the parent transfers the shell port', async () => {
		const { service, browser } = createService();
		service.signalReady();

		browser.emitFromParent(
			portMessage(postedBootstrap(browser)),
			new MessageChannel().port1
		);
		const connection = await service.whenConnected();
		assert.ok(connection);

		assert.strictEqual(
			connection.hostedShellProtocolVersion,
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION
		);
		assert.deepStrictEqual(
			connection.hostedShellCapabilities,
			HUCODE_HOSTED_SHELL_CAPABILITIES
		);
	});

	test('ignores port transfers from non-parent same-origin sources', async () => {
		const { service, browser } = createService();
		service.signalReady();
		const bootstrap = postedBootstrap(browser);

		browser.emitFromStranger(
			portMessage(bootstrap),
			new MessageChannel().port1
		);
		await settled();
		browser.emitFromParent(portMessage(bootstrap), new MessageChannel().port1);

		const connection = await service.whenConnected();
		assert.ok(connection);
	});

	test('ignores port transfers for other instances or without a port', async () => {
		const { service, browser } = createService();
		service.signalReady();
		const bootstrap = postedBootstrap(browser);
		let connected = false;
		void service.whenConnected().then(() => { connected = true; });

		browser.emitFromParent(
			portMessage(bootstrap, { instanceId: 'other-instance' }),
			new MessageChannel().port1
		);
		browser.emitFromParent(portMessage(bootstrap));
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
		const bootstrap = (browser.postedMessages[0] as {
			readonly connectionBootstrap: {
				readonly id: string;
				readonly attempt: number;
			};
		}).connectionBootstrap;
		assert.ok(bootstrap.id);

		// The shell decides how to unload a workbench from the version it
		// announces here, so a ready signal without one reads as a workbench
		// built before the unload handshake was split.
		assert.deepStrictEqual(browser.postedMessages, [
			{
				type: HucodeOmniWebChildMessageType.Ready,
				instanceId: INSTANCE_ID,
				connectionBootstrap: bootstrap,
				protocolVersion: HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION,
				hostedShellProtocolVersion:
					HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
				hostedShellCapabilities: HUCODE_HOSTED_SHELL_CAPABILITIES,
			},
			{
				type: HucodeOmniWebChildMessageType.Focus,
				instanceId: INSTANCE_ID,
				focused: false,
			},
		]);

		const other = createService();
		other.service.signalReady();
		assert.notStrictEqual(postedBootstrap(other.browser).id, bootstrap.id);
	});

	test('bounds the initial wait while keeping retryable readiness alive',
		async () => {
			const browser = new ManualConnectionBrowserAdapter(true);
			const { service } = createService(true, browser, {
				initialConnectionTimeoutMs: 50,
				readyRetryDelaysMs: [10],
			});
			service.signalReady();
			browser.fireNext(50);
			assert.strictEqual(await service.whenConnected(), undefined);
			browser.fireNext(10);
			assert.deepStrictEqual(
				browser.postedMessages.map(message =>
					(message as {
						connectionBootstrap?: { readonly attempt: number };
					}).connectionBootstrap?.attempt),
				[1, 2]
			);
		});

	test('sends readiness once when retries are disabled', async () => {
		const browser = new ManualConnectionBrowserAdapter(true);
		const { service } = createService(true, browser, {
			initialConnectionTimeoutMs: 50,
			readyRetryDelaysMs: [],
		});
		service.signalReady();

		assert.strictEqual(browser.postedMessages.length, 1);
		assert.deepStrictEqual(browser.pendingDelays, [50]);
		browser.fireNext(50);
		assert.strictEqual(await service.whenConnected(), undefined);
		assert.strictEqual(browser.postedMessages.length, 1);
	});

	test('keeps readiness retries capped at the final delay', () => {
		const browser = new ManualConnectionBrowserAdapter(true);
		const { service } = createService(true, browser, {
			initialConnectionTimeoutMs: 50,
			readyRetryDelaysMs: [10, 20],
		});
		service.signalReady();

		assert.deepStrictEqual(browser.pendingDelays, [50, 10]);
		browser.fireNext(10);
		assert.deepStrictEqual(browser.pendingDelays, [50, 20]);
		browser.fireNext(20);
		assert.deepStrictEqual(browser.pendingDelays, [50, 20]);
		assert.strictEqual(browser.postedMessages.length, 3);
	});

	test('skips invalid readiness delays without disabling later retries', () => {
		const browser = new ManualConnectionBrowserAdapter(true);
		const { service } = createService(true, browser, {
			initialConnectionTimeoutMs: 50,
			readyRetryDelaysMs: [10, 0, Number.NaN, 20],
		});
		service.signalReady();

		assert.deepStrictEqual(browser.pendingDelays, [50, 10]);
		browser.fireNext(10);
		assert.deepStrictEqual(browser.pendingDelays, [50, 20]);
		browser.fireNext(20);
		assert.deepStrictEqual(browser.pendingDelays, [50, 20]);
		assert.strictEqual(browser.postedMessages.length, 3);
	});

	test('rejects a stale retry port and adopts only the latest attempt',
		async () => {
			const browser = new ManualConnectionBrowserAdapter(true);
			const { service } = createService(true, browser, {
				initialConnectionTimeoutMs: 50,
				readyRetryDelaysMs: [10],
			});
			service.signalReady();
			const first = postedBootstrap(browser);
			browser.fireNext(10);
			const latestBootstrap = postedBootstrap(browser);
			assert.strictEqual(first.id, latestBootstrap.id);
			const stale = trackedPort();
			browser.emitFromParent(portMessage(first), stale.port);
			assert.strictEqual(stale.wasClosed(), true);
			const latest = new MessageChannel();
			browser.emitFromParent(portMessage(latestBootstrap), latest.port1);
			const connection = await service.whenConnected();
			assert.ok(connection);
		});

	test('closes wrong-document and partial current bootstrap ports', async () => {
		const browser = new ManualConnectionBrowserAdapter(true);
		const { service } = createService(true, browser, {
			initialConnectionTimeoutMs: 50,
			readyRetryDelaysMs: [10],
		});
		service.signalReady();
		const bootstrap = postedBootstrap(browser);

		const wrongDocument = trackedPort();
		browser.emitFromParent(portMessage({
			id: 'different-document',
			attempt: bootstrap.attempt,
		}), wrongDocument.port);
		const partial = trackedPort();
		browser.emitFromParent({
			type: HucodeOmniWebParentMessageType.Port,
			instanceId: INSTANCE_ID,
			connectionBootstrap: { id: bootstrap.id },
			hostedShellProtocolVersion: HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			hostedShellCapabilities: HUCODE_HOSTED_SHELL_CAPABILITIES,
		}, partial.port);
		const nullBootstrap = trackedPort();
		browser.emitFromParent({
			type: HucodeOmniWebParentMessageType.Port,
			instanceId: INSTANCE_ID,
			connectionBootstrap: null,
			hostedShellProtocolVersion: HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			hostedShellCapabilities: HUCODE_HOSTED_SHELL_CAPABILITIES,
		}, nullBootstrap.port);
		assert.strictEqual(wrongDocument.wasClosed(), true);
		assert.strictEqual(partial.wasClosed(), true);
		assert.strictEqual(nullBootstrap.wasClosed(), true);

		browser.emitFromParent(
			portMessage(bootstrap),
			new MessageChannel().port1
		);
		assert.ok(await service.whenConnected());
	});

	test('closes ports with mismatched or missing capability metadata',
		async () => {
			const { service, browser } = createService();
			service.signalReady();
			const bootstrap = postedBootstrap(browser);
			const mismatch = trackedPort();
			browser.emitFromParent(portMessage(bootstrap, {
				hostedShellProtocolVersion:
					HUCODE_HOSTED_SHELL_PROTOCOL_VERSION + 1,
			}), mismatch.port);
			const missing = trackedPort();
			browser.emitFromParent(portMessage(bootstrap, {
				hostedShellCapabilities: [],
			}), missing.port);
			assert.strictEqual(mismatch.wasClosed(), true);
			assert.strictEqual(missing.wasClosed(), true);

			browser.emitFromParent(
				portMessage(bootstrap),
				new MessageChannel().port1
			);
			assert.ok(await service.whenConnected());
		});


	test('keeps cached availability false after disposal during connection',
		async () => {
			const connectionService = {
				_serviceBrand: undefined,
				isHosted: true,
				onDidConnect: Event.None,
				async whenConnected() {
					return {
						ipcClient: {
							getChannel: () => ({
								call: async () => undefined,
								listen: () => Event.None,
							}),
						} as never,
						hostedShellProtocolVersion:
							HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
						hostedShellCapabilities:
							HUCODE_HOSTED_SHELL_CAPABILITIES,
					};
				},
			} as Partial<IHucodeHostedOmniWebConnectionService> as
				IHucodeHostedOmniWebConnectionService;
			const service = new HostedOmniWebShellService(
				connectionService,
				{
					isHostedOmniWorkspace: true,
					hostedInstanceId: INSTANCE_ID,
				} as never
			);

			assert.strictEqual(
				isHucodeHostedShellServiceAvailable(service),
				false
			);
			service.dispose();
			await settled();
			assert.strictEqual(
				isHucodeHostedShellServiceAvailable(service),
				false
			);
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

	setTimeout(
		callback: () => void,
		delay: number
	): ReturnType<typeof setTimeout> {
		return setTimeout(callback, delay);
	}

	clearTimeout(handle: ReturnType<typeof setTimeout>): void {
		clearTimeout(handle);
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

class ManualConnectionBrowserAdapter extends FakeConnectionBrowserAdapter {
	private nextHandle = 1;
	private readonly timers = new Map<number, {
		readonly callback: () => void;
		readonly delay: number;
	}>();

	get pendingDelays(): readonly number[] {
		return [...this.timers.values()].map(timer => timer.delay);
	}

	override setTimeout(
		callback: () => void,
		delay: number
	): ReturnType<typeof setTimeout> {
		const handle = this.nextHandle++;
		this.timers.set(handle, { callback, delay });
		return handle as unknown as ReturnType<typeof setTimeout>;
	}

	override clearTimeout(handle: ReturnType<typeof setTimeout>): void {
		this.timers.delete(handle as unknown as number);
	}

	fireNext(delay: number): void {
		const entry = [...this.timers.entries()].find(
			([, timer]) => timer.delay === delay
		);
		assert.ok(entry, `Expected a pending ${delay}ms timer`);
		this.timers.delete(entry[0]);
		entry[1].callback();
	}
}
