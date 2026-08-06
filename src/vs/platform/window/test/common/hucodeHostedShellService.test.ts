/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	createBoundHucodeHostedShellFacade,
	HUCODE_HOSTED_SHELL_CAPABILITIES,
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
		]);
		assert.deepStrictEqual(HUCODE_HOSTED_SHELL_REMOTE_MEMBERS, [
			'onDidChangeState',
			'getState',
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
		assert.strictEqual(negotiateHucodeHostedShellCapabilities(
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			HUCODE_HOSTED_SHELL_CAPABILITIES.slice(0, -1)
		), undefined);
		assert.deepStrictEqual(negotiateHucodeHostedShellCapabilities(
			HUCODE_HOSTED_SHELL_PROTOCOL_VERSION,
			[...HUCODE_HOSTED_SHELL_CAPABILITIES, 'futureGroup']
		), HUCODE_HOSTED_SHELL_CAPABILITIES);
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

		assert.deepStrictEqual(await facade.getState(), {
			available: true,
			projectsSidebarVisible: true,
			projectSwitcherCanGoBack: true,
			projectSwitcherCanGoForward: false,
			lifecycleState: 'loaded',
			active: false,
			visible: false,
		});
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
			notifyReady: async () => undefined,
			closeSelf: async () => true,
			reopenSelfInNormalWindow: async () => true,
			reloadSelf: async () => true,
			focusSelf: async () => true,
			focusShell: async () => true,
			requestShellAction: async () => true,
			navigateToFolder: async () => HucodeHostedShellOperationOutcome.Accepted,
			triggerPasteInSelf: async () => true,
			captureSelfScreenshot: async () => undefined,
		};
		const facade = createBoundHucodeHostedShellFacade(binding, delegate);

		assert.strictEqual(
			(await facade.notifyReady()).outcome,
			HucodeHostedShellOperationOutcome.Stale
		);
		assert.strictEqual(
			await facade.navigateToFolder({ folderUri: URI.file('/folder').toJSON() }),
			HucodeHostedShellOperationOutcome.Stale
		);

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
