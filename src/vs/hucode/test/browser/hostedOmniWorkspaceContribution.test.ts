/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { MockContextKeyService } from
	'../../../platform/keybinding/test/common/mockKeybindingService.js';
import {
	HucodeHostedShellOperationOutcome,
	IHucodeHostedShellService,
	IHucodeHostedShellState,
} from '../../../platform/window/common/hucodeHostedShellService.js';
import { IWorkbenchEnvironmentService } from
	'../../../workbench/services/environment/common/environmentService.js';
import { HostedOmniWorkspaceReadyContribution } from
	'../../browser/hostedOmniWorkspace.contribution.js';
import {
	HasLoadedWorkbenchContext,
	ProjectsSidebarHiddenContext,
} from '../../browser/omniProjectsSidebarActions.js';
import {
	ProjectSwitcherCanGoBackContext,
	ProjectSwitcherCanGoForwardContext,
} from '../../browser/projectSwitcher/projectSwitcherCommon.js';

suite('HostedOmniWorkspaceContribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('does not overwrite a newer state event with the initial snapshot',
		async () => {
			const initialState = new DeferredPromise<IHucodeHostedShellState>();
			const stateChanges = disposables.add(
				new Emitter<IHucodeHostedShellState>()
			);
			const shellService = {
				onDidChangeState: stateChanges.event,
				getState: () => initialState.p,
				async notifyReady() {
					return {
						outcome: HucodeHostedShellOperationOutcome.Accepted,
					};
				},
			} as unknown as IHucodeHostedShellService;
			const contextKeyService = disposables.add(
				new MockContextKeyService()
			);
			disposables.add(new HostedOmniWorkspaceReadyContribution(
				{
					isHostedOmniWorkspace: true,
					hostedInstanceId: 'self',
				} as IWorkbenchEnvironmentService,
				shellService,
				contextKeyService
			));
			stateChanges.fire({
				available: true,
				projectsSidebarVisible: true,
				projectSwitcherCanGoBack: true,
				projectSwitcherCanGoForward: true,
				lifecycleState: 'active',
				active: true,
				visible: true,
			});
			await initialState.complete({
				available: false,
				projectsSidebarVisible: false,
				projectSwitcherCanGoBack: false,
				projectSwitcherCanGoForward: false,
				active: false,
				visible: false,
			});

			assert.strictEqual(
				ProjectsSidebarHiddenContext.getValue(contextKeyService),
				false
			);
			assert.strictEqual(
				HasLoadedWorkbenchContext.getValue(contextKeyService),
				true
			);
			assert.strictEqual(
				ProjectSwitcherCanGoBackContext.getValue(contextKeyService),
				true
			);
			assert.strictEqual(
				ProjectSwitcherCanGoForwardContext.getValue(contextKeyService),
				true
			);
		});
});
