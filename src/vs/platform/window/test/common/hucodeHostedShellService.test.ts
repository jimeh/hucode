/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	createBoundHucodeHostedShellFacade,
	createHucodeHostedShellClient,
	createHucodeHostedShellServerChannel,
	HUCODE_HOSTED_SHELL_CAPABILITIES,
	HUCODE_HOSTED_SHELL_CORE_CAPABILITIES,
	HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
	HUCODE_HOSTED_SHELL_REMOTE_MEMBERS,
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellAuthorityState,
	IHucodeHostedShellBinding,
	IHucodeHostedShellDelegate,
	negotiateHucodeHostedShellCapabilities,
} from '../../common/hucodeHostedShellService.js';
import {
	HUCODE_HOSTED_SHELL_ACTIONS,
	HucodeHostedShellAction,
} from '../../common/hucodeHostedShellActions.js';

suite('HucodeHostedShellService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('exposes an exact, versioned hosted capability surface', () => {
		assert.strictEqual(HUCODE_HOSTED_SHELL_PROTOCOL_VERSION, 1);
		assert.deepStrictEqual(HUCODE_HOSTED_SHELL_CAPABILITIES, [
			'state',
			'ready',
			'selfLifecycle',
			'focus',
			'shellActions',
			'navigation',
			'paste',
			'screenshot',
			'navigationSnapshot',
		]);
		assert.deepStrictEqual(HUCODE_HOSTED_SHELL_REMOTE_MEMBERS, [
			'onDidChangeState',
			'getState',
			'getNavigationSnapshot',
			'notifyReady',
			'closeSelf',
			'reopenSelfInNormalWindow',
			'reloadSelf',
			'focusSelf',
			'focusShell',
			'requestShellAction',
			'navigateToFolder',
			'triggerPasteInSelf',
			'captureSelfScreenshot',
		]);
		assert.deepStrictEqual(
			negotiateHucodeHostedShellCapabilities(
				HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
				HUCODE_HOSTED_SHELL_CAPABILITIES
			),
			HUCODE_HOSTED_SHELL_CAPABILITIES
		);
		assert.strictEqual(negotiateHucodeHostedShellCapabilities(
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION + 1,
			HUCODE_HOSTED_SHELL_CAPABILITIES
		), undefined);
		assert.deepStrictEqual(negotiateHucodeHostedShellCapabilities(
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			HUCODE_HOSTED_SHELL_CORE_CAPABILITIES
		), HUCODE_HOSTED_SHELL_CORE_CAPABILITIES);
		assert.strictEqual(negotiateHucodeHostedShellCapabilities(
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			HUCODE_HOSTED_SHELL_CORE_CAPABILITIES.slice(0, -1)
		), undefined);
		assert.deepStrictEqual(negotiateHucodeHostedShellCapabilities(
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			[...HUCODE_HOSTED_SHELL_CAPABILITIES, 'futureGroup']
		), HUCODE_HOSTED_SHELL_CAPABILITIES);
	});

	test('core-only clients do not call the optional snapshot method',
		async () => {
			const calls: string[] = [];
			const channel: IChannel = {
				call: async <T>(command: string) => {
					calls.push(command);
					return undefined as T;
				},
				listen: () => Event.None,
			};
			const client = createHucodeHostedShellClient(
				channel,
				HUCODE_HOSTED_SHELL_CORE_CAPABILITIES
			);

			assert.strictEqual(await client.getNavigationSnapshot!(), undefined);
			assert.deepStrictEqual(calls, []);
		});

	test('projects only bound self state and rejects inactive actions', async () => {
		const binding: IHucodeHostedShellBinding = {
			windowId: 7,
			instanceId: 'self',
			connectionGeneration: 3,
		};
		let state: IHucodeHostedShellAuthorityState = {
			connectionGeneration: 3,
			disposed: false,
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: true,
			projectSwitcherCanGoForward: false,
			activeInstanceId: 'other',
			instances: [
				{
					instanceId: 'self',
					state: 'loaded',
					visible: false,
				},
				{
					instanceId: 'other',
					state: 'active',
					visible: true,
				},
			],
			navigationSnapshot: {
				sectionOrder: ['workbenches', 'projects'],
				targets: [{
					folderUri: URI.file('/sibling').toJSON(),
					lifecycleState: 'loaded',
					lastActiveAt: 42,
					section: 'projects',
					order: 0,
				}],
			},
		};
		const actions: HucodeHostedShellAction[] = [];
		const operations: Array<{
			readonly operation: string;
			readonly binding: IHucodeHostedShellBinding;
		}> = [];
		const accept = async (
			operation: string,
			current: IHucodeHostedShellBinding
		) => {
			operations.push({ operation, binding: current });
			return true;
		};
		const delegate: IHucodeHostedShellDelegate = {
			onDidChangeState: Event.None,
			getState: async () => state,
			notifyReady: async () => undefined,
			closeSelf: current => accept('close', current),
			reopenSelfInNormalWindow: current => accept('reopen', current),
			reloadSelf: current => accept('reload', current),
			focusSelf: current => accept('focusSelf', current),
			focusShell: current => accept('focusShell', current),
			requestShellAction: async (current, action) => {
				operations.push({ operation: 'action', binding: current });
				actions.push(action);
				return true;
			},
			navigateToFolder: async () => HucodeHostedShellOperationOutcome.Accepted,
			triggerPasteInSelf: current => accept('paste', current),
			captureSelfScreenshot: async current => {
				operations.push({ operation: 'screenshot', binding: current });
				return undefined;
			},
		};
		const facade = createBoundHucodeHostedShellFacade(binding, delegate);
		assert.deepStrictEqual(
			Object.keys(facade).filter(key => key !== '_serviceBrand'),
			HUCODE_HOSTED_SHELL_REMOTE_MEMBERS
		);
		const channelDisposables = new DisposableStore();
		const channel = createHucodeHostedShellServerChannel(
			facade,
			channelDisposables
		);
		await assert.rejects(
			channel.call('test', 'constructor'),
			/Method not found: constructor/
		);
		assert.throws(
			() => channel.listen('test', 'toString'),
			/Event not found: toString/
		);
		channelDisposables.dispose();

		assert.deepStrictEqual(await facade.getState(), {
			available: true,
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: true,
			projectSwitcherCanGoForward: false,
			lifecycleState: 'loaded',
			active: false,
			visible: false,
		});
		assert.deepStrictEqual(await facade.getNavigationSnapshot!(),
			state.navigationSnapshot);
		assert.strictEqual(JSON.stringify(
			await facade.getNavigationSnapshot!()
		).includes('instanceId'), false);

		const coreOnlyDisposables = new DisposableStore();
		const coreOnlyChannel = createHucodeHostedShellServerChannel(
			facade,
			coreOnlyDisposables,
			HUCODE_HOSTED_SHELL_CORE_CAPABILITIES
		);
		await assert.rejects(
			coreOnlyChannel.call('test', 'getNavigationSnapshot'),
			/Method not found: getNavigationSnapshot/
		);
		coreOnlyDisposables.dispose();
		for (const run of [
			() => facade.closeSelf(),
			() => facade.reopenSelfInNormalWindow(),
			() => facade.reloadSelf(),
			() => facade.focusSelf(),
		]) {
			assert.strictEqual(
				await run(),
				HucodeHostedShellOperationOutcome.Accepted
			);
		}
		assert.strictEqual(
			await facade.focusShell(),
			HucodeHostedShellOperationOutcome.Rejected
		);
		assert.strictEqual(
			await facade.triggerPasteInSelf(),
			HucodeHostedShellOperationOutcome.Rejected
		);
		assert.strictEqual(await facade.captureSelfScreenshot(), undefined);
		assert.deepStrictEqual(operations, [
			{ operation: 'close', binding },
			{ operation: 'reopen', binding },
			{ operation: 'reload', binding },
			{ operation: 'focusSelf', binding },
		]);
		for (const action of HUCODE_HOSTED_SHELL_ACTIONS) {
			assert.strictEqual(
				await facade.requestShellAction(action),
				HucodeHostedShellOperationOutcome.Rejected
			);
		}
		assert.deepStrictEqual(actions, []);

		state = {
			...state,
			activeInstanceId: 'self',
			instances: [{
				instanceId: 'self',
				state: 'active',
				visible: true,
			}],
		};
		assert.strictEqual(
			await facade.requestShellAction(HucodeHostedShellAction.AddProject),
			HucodeHostedShellOperationOutcome.Accepted
		);
		assert.strictEqual(
			await facade.focusShell(),
			HucodeHostedShellOperationOutcome.Accepted
		);
		assert.strictEqual(
			await facade.triggerPasteInSelf(),
			HucodeHostedShellOperationOutcome.Accepted
		);
		assert.strictEqual(await facade.captureSelfScreenshot(), undefined);
		assert.deepStrictEqual(actions, [HucodeHostedShellAction.AddProject]);
		assert.deepStrictEqual(operations.slice(-4), [
			{ operation: 'action', binding },
			{ operation: 'focusShell', binding },
			{ operation: 'paste', binding },
			{ operation: 'screenshot', binding },
		]);
	});

	test('filters sibling-only state events from the bound projection', () => {
		const emitter = new Emitter<IHucodeHostedShellAuthorityState>();
		const binding: IHucodeHostedShellBinding = {
			windowId: 1,
			instanceId: 'self',
			connectionGeneration: 1,
		};
		const base: IHucodeHostedShellAuthorityState = {
			connectionGeneration: 1,
			disposed: false,
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			activeInstanceId: 'self',
			instances: [{
				instanceId: 'self',
				state: 'active',
				visible: true,
			}],
		};
		const facade = createBoundHucodeHostedShellFacade(binding, {
			onDidChangeState: emitter.event,
			getState: async () => base,
			notifyReady: async () => undefined,
			closeSelf: async () => true,
			reopenSelfInNormalWindow: async () => true,
			reloadSelf: async () => true,
			focusSelf: async () => true,
			focusShell: async () => true,
			requestShellAction: async () => true,
			navigateToFolder: async () =>
				HucodeHostedShellOperationOutcome.Accepted,
			triggerPasteInSelf: async () => true,
			captureSelfScreenshot: async () => undefined,
		});
		const events: unknown[] = [];
		const listener = facade.onDidChangeState(state => events.push(state));
		emitter.fire(base);
		events.length = 0;
		emitter.fire({
			...base,
			instances: [
				...base.instances,
				{ instanceId: 'sibling', state: 'loaded', visible: false },
			],
		});
		assert.deepStrictEqual(events, []);
		emitter.fire({
			...base,
			activeInstanceId: undefined,
			instances: [],
		});
		assert.deepStrictEqual(events, [{
			available: false,
			projectsSidebarVisible: false,
			projectSwitcherCanGoBack: false,
			projectSwitcherCanGoForward: false,
			active: false,
			visible: false,
		}]);
		listener.dispose();
		emitter.dispose();
	});

	test('navigation continuation fails after the caller becomes hidden',
		async () => {
			const binding: IHucodeHostedShellBinding = {
				windowId: 1,
				instanceId: 'self',
				connectionGeneration: 1,
			};
			let active = true;
			const authority = (): IHucodeHostedShellAuthorityState => ({
				connectionGeneration: 1,
				disposed: false,
				projectsSidebarVisible: true,
				projectSwitcherCanGoBack: false,
				projectSwitcherCanGoForward: false,
				activeInstanceId: active ? 'self' : 'sibling',
				instances: [{
					instanceId: 'self',
					state: active ? 'active' : 'loaded',
					visible: active,
				}],
			});
			const facade = createBoundHucodeHostedShellFacade(binding, {
				onDidChangeState: Event.None,
				getState: async () => authority(),
				notifyReady: async () => undefined,
				closeSelf: async () => true,
				reopenSelfInNormalWindow: async () => true,
				reloadSelf: async () => true,
				focusSelf: async () => true,
				focusShell: async () => true,
				requestShellAction: async () => true,
				async navigateToFolder(_binding, _request, authorization) {
					active = false;
					return await authorization.isCurrentAndActiveVisible()
						? HucodeHostedShellOperationOutcome.Accepted
						: HucodeHostedShellOperationOutcome.Superseded;
				},
				triggerPasteInSelf: async () => true,
				captureSelfScreenshot: async () => undefined,
			});

			assert.strictEqual(await facade.navigateToFolder({
				folderUri: URI.file('/target').toJSON(),
			}), HucodeHostedShellOperationOutcome.Superseded);
		});

	test('rejects stale connections and malformed navigation', async () => {
		const binding: IHucodeHostedShellBinding = {
			windowId: 7,
			instanceId: 'self',
			connectionGeneration: 2,
		};
		let delegateCalls = 0;
		const accept = async () => {
			delegateCalls++;
			return true;
		};
		const delegate: IHucodeHostedShellDelegate = {
			onDidChangeState: Event.None,
			getState: async () => ({
				connectionGeneration: 3,
				disposed: false,
				projectsSidebarVisible: true,
				projectSwitcherCanGoBack: false,
				projectSwitcherCanGoForward: false,
				activeInstanceId: 'self',
				instances: [{
					instanceId: 'self',
					state: 'active',
					visible: true,
				}],
			}),
			notifyReady: async () => { delegateCalls++; },
			closeSelf: accept,
			reopenSelfInNormalWindow: accept,
			reloadSelf: accept,
			focusSelf: accept,
			focusShell: accept,
			requestShellAction: accept,
			navigateToFolder: async () => {
				delegateCalls++;
				return HucodeHostedShellOperationOutcome.Accepted;
			},
			triggerPasteInSelf: accept,
			captureSelfScreenshot: async () => {
				delegateCalls++;
				return undefined;
			},
		};
		const facade = createBoundHucodeHostedShellFacade(binding, delegate);
		const assertFacadeStale = async (staleFacade: typeof facade) => {
			assert.strictEqual(
				(await staleFacade.notifyReady()).outcome,
				HucodeHostedShellOperationOutcome.Stale
			);
			assert.strictEqual(
				await staleFacade.navigateToFolder({ folderUri: URI.file('/folder').toJSON() }),
				HucodeHostedShellOperationOutcome.Stale
			);
			for (const run of [
				() => staleFacade.closeSelf(),
				() => staleFacade.reopenSelfInNormalWindow(),
				() => staleFacade.reloadSelf(),
				() => staleFacade.focusSelf(),
				() => staleFacade.focusShell(),
				() => staleFacade.requestShellAction(HucodeHostedShellAction.AddProject),
				() => staleFacade.triggerPasteInSelf(),
			]) {
				assert.strictEqual(
					await run(),
					HucodeHostedShellOperationOutcome.Stale
				);
			}
			assert.strictEqual(await staleFacade.captureSelfScreenshot(), undefined);
		};

		await assertFacadeStale(facade);
		const disposedFacade = createBoundHucodeHostedShellFacade(
			{ ...binding, connectionGeneration: 3 },
			{
				...delegate,
				getState: async () => ({
					...(await delegate.getState(binding)),
					connectionGeneration: 3,
					disposed: true,
				}),
			}
		);
		await assertFacadeStale(disposedFacade);
		assert.strictEqual(delegateCalls, 0);

		const currentFacade = createBoundHucodeHostedShellFacade(
			{ ...binding, connectionGeneration: 3 },
			delegate
		);
		assert.strictEqual(
			await currentFacade.navigateToFolder({
				folderUri: URI.parse('https://example.test').toJSON(),
			}),
			HucodeHostedShellOperationOutcome.Unsupported
		);
	});
});
