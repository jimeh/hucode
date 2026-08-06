/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HUCODE_HOSTED_SHELL_CAPABILITIES,
	HUCODE_HOSTED_SHELL_CORE_CAPABILITIES,
	HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
	HucodeHostedShellOperationOutcome,
	isHucodeHostedShellServiceAvailable,
} from '../../../platform/window/common/hucodeHostedShellService.js';
import { HucodeHostedShellAction } from
	'../../../platform/window/common/hucodeHostedShellActions.js';
import {
	HUCODE_OMNI_WEB_UNLOAD_PROTOCOL_VERSION,
	HucodeOmniWebChildMessageType,
	HucodeOmniWebParentMessageType,
} from '../../../platform/window/common/hucodeOmniWebMessages.js';
import {
	HucodeHostedOmniWebConnectionService,
	IHucodeHostedOmniWebConnectionService,
	IHostedOmniWebConnectionBrowserAdapter,
} from '../../browser/hostedOmniWebConnection.js';
import {
	createLegacyHostedShellClient,
	getHostedOmniWebShellClientMode,
	HostedOmniWebShellService,
} from
	'../../browser/hostedOmniWebShellService.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
} from '../../common/omniWindow.js';

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
		readonly hostedShellProtocolVersion?: number;
	}): object {
		return {
			type: HucodeOmniWebParentMessageType.Port,
			instanceId: overrides?.instanceId ?? INSTANCE_ID,
			windowId: overrides?.windowId ?? 7,
			...(overrides?.hostedShellProtocolVersion === undefined ? {} : {
				hostedShellProtocolVersion:
					overrides.hostedShellProtocolVersion,
				hostedShellCapabilities: HUCODE_HOSTED_SHELL_CAPABILITIES,
			}),
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
		assert.strictEqual(connection.hostedShellProtocolVersion, undefined);

		const current = createService();
		current.browser.emitFromParent(portMessage({
			hostedShellProtocolVersion: HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
		}), new MessageChannel().port1);
		const negotiated = await current.service.whenConnected();
		assert.strictEqual(
			negotiated.hostedShellProtocolVersion,
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION
		);
		assert.deepStrictEqual(
			negotiated.hostedShellCapabilities,
			HUCODE_HOSTED_SHELL_CAPABILITIES
		);
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
	});

	test('selects legacy only for a parent without capability versioning', () => {
		assert.strictEqual(
			getHostedOmniWebShellClientMode(undefined, undefined),
			'legacy'
		);
		assert.strictEqual(getHostedOmniWebShellClientMode(
			undefined,
			HUCODE_HOSTED_SHELL_CAPABILITIES
		), 'unavailable');
		assert.strictEqual(getHostedOmniWebShellClientMode(
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			HUCODE_HOSTED_SHELL_CAPABILITIES
		), 'current');
		assert.strictEqual(getHostedOmniWebShellClientMode(
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION + 1,
			HUCODE_HOSTED_SHELL_CAPABILITIES
		), 'unavailable');
		assert.strictEqual(getHostedOmniWebShellClientMode(
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			HUCODE_HOSTED_SHELL_CORE_CAPABILITIES
		), 'current');
		assert.strictEqual(getHostedOmniWebShellClientMode(
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			HUCODE_HOSTED_SHELL_CORE_CAPABILITIES.slice(0, -1)
		), 'unavailable');
	});

	test('keeps the new-child old-parent adapter bound to self', async () => {
		const stateChanges = disposables.add(new Emitter<{
			readonly windowId: number;
			readonly state: IHucodeHostedWorkspaceState;
		}>());
		let state = legacyState('other');
		let closeCalls = 0;
		const calls: string[] = [];
		const legacy = {
			onDidChangeWindowState: stateChanges.event,
			getWindowState: async () => state,
			notifyHostedWorkspaceReady: async () => { calls.push('ready'); },
			closeWorkspace: async () => { closeCalls++; return state; },
			reloadWorkspace: async () => { calls.push('reload'); },
			focusShell: async () => { calls.push('focusShell'); },
			runActionInShell: async () => { calls.push('action'); return true; },
			openAndFocusWorkspace: async () => { calls.push('navigate'); return state; },
			focusHostedWorkspaceByPath: async path => {
				calls.push(`focusPath:${path}`);
				state = legacyState('self');
				return true;
			},
			focusWorkspace: async () => { calls.push('focusWorkspace'); },
		} as Partial<IHucodeShellService> as IHucodeShellService;
		const client = createLegacyHostedShellClient(legacy, 7, 'self');
		const projectedChanges: unknown[] = [];
		disposables.add(client.onDidChangeState(change =>
			projectedChanges.push(change)));
		stateChanges.fire({ windowId: 7, state });
		projectedChanges.length = 0;
		state = {
			...state,
			instances: state.instances.map(instance =>
				instance.instanceId === 'other'
					? { ...instance, focused: true }
					: instance),
		};
		stateChanges.fire({ windowId: 7, state });
		assert.deepStrictEqual(projectedChanges, []);

		assert.strictEqual((await client.getState()).active, false);
		assert.deepStrictEqual(
			(await client.getNavigationSnapshot!())?.targets.map(target => ({
				path: URI.revive(target.folderUri).fsPath,
				lifecycleState: target.lifecycleState,
			})),
			[
				{ path: '/self', lifecycleState: 'loaded' },
				{ path: '/other', lifecycleState: 'active' },
			]
		);
		assert.strictEqual(await client.reloadSelf(),
			HucodeHostedShellOperationOutcome.Rejected);
		assert.strictEqual(await client.focusShell(),
			HucodeHostedShellOperationOutcome.Rejected);
		assert.strictEqual(await client.requestShellAction(
			HucodeHostedShellAction.AddProject
		), HucodeHostedShellOperationOutcome.Rejected);
		assert.strictEqual(await client.requestShellAction(
			'not-a-hosted-action' as HucodeHostedShellAction
		), HucodeHostedShellOperationOutcome.Unsupported);
		assert.strictEqual(await client.navigateToFolder({
			folderUri: undefined as never,
		}), HucodeHostedShellOperationOutcome.Unsupported);
		assert.strictEqual(await client.navigateToFolder({
			folderUri: URI.file('/target').toJSON(),
		}), HucodeHostedShellOperationOutcome.Rejected);
		assert.strictEqual(await client.triggerPasteInSelf(),
			HucodeHostedShellOperationOutcome.Unavailable);
		assert.strictEqual(await client.captureSelfScreenshot(), undefined);
		assert.deepStrictEqual(calls, []);

		assert.strictEqual(await client.focusSelf(),
			HucodeHostedShellOperationOutcome.Accepted);
		assert.deepStrictEqual(calls, [
			'focusPath:/self',
			'focusWorkspace',
		]);
		assert.strictEqual(await client.triggerPasteInSelf(),
			HucodeHostedShellOperationOutcome.Unavailable);
		assert.strictEqual(await client.captureSelfScreenshot(), undefined);
		assert.deepStrictEqual(calls, [
			'focusPath:/self',
			'focusWorkspace',
		]);

		state = legacyState(undefined);
		assert.strictEqual(await client.closeSelf(),
			HucodeHostedShellOperationOutcome.Unavailable);
		assert.strictEqual(closeCalls, 0);
		assert.strictEqual((await client.notifyReady()).outcome,
			HucodeHostedShellOperationOutcome.Unavailable);
	});

	test('keeps cached availability false after disposal during connection',
		async () => {
			const connectionService = {
				_serviceBrand: undefined,
				isHosted: true,
				async whenConnected() {
					return {
						ipcClient: {
							getChannel: () => ({
								call: async () => undefined,
								listen: () => Event.None,
							}),
						} as never,
						shellWindowId: 7,
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

function legacyState(
	activeInstanceId: string | undefined
): IHucodeHostedWorkspaceState {
	return {
		activeInstanceId,
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: activeInstanceId === undefined ? [] : [{
			instanceId: 'self',
			worktreePath: '/self',
			state: activeInstanceId === 'self' ? 'active' : 'loaded',
			visible: activeInstanceId === 'self',
			focused: false,
		}, {
			instanceId: 'other',
			worktreePath: '/other',
			state: activeInstanceId === 'other' ? 'active' : 'loaded',
			visible: activeInstanceId === 'other',
			focused: false,
		}],
	};
}

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
