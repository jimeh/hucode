/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { Emitter } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	IHucodeHostedWorkspaceState,
	IHucodeShellService,
	IHucodeShellWindowStateChange,
} from '../../common/omniWindow.js';
import { WebShellControllerServiceAdapter } from
	'../../browser/webShellControllerServiceAdapter.js';

suite('WebShellControllerServiceAdapter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('binds legacy web shell calls and events to the current window',
		async () => {
			const changes = disposables.add(
				new Emitter<IHucodeShellWindowStateChange>()
			);
			const calls: string[] = [];
			const initial = state('initial');
			const shell = {
				supportsWorkspaceScreenshotOverlay: false,
				onDidChangeWindowState: changes.event,
				async getWindowState(windowId: number) {
					calls.push(`get:${windowId}`);
					return initial;
				},
				async openWorkspace(
					windowId: number,
					path: string,
					projectId?: string
				) {
					calls.push(`open:${windowId}:${path}:${projectId}`);
					return initial;
				},
			} as unknown as IHucodeShellService;
			const adapter = new WebShellControllerServiceAdapter(shell);
			const observed: IHucodeHostedWorkspaceState[] = [];
			disposables.add(adapter.onDidChangeState(value => observed.push(value)));

			assert.deepStrictEqual(await adapter.getState(), initial);
			await adapter.openWorkspace('/repo', 'project');
			changes.fire({
				windowId: mainWindow.vscodeWindowId + 1,
				state: state('other'),
			});
			changes.fire({
				windowId: mainWindow.vscodeWindowId,
				state: state('same'),
			});

			assert.deepStrictEqual(calls, [
				`get:${mainWindow.vscodeWindowId}`,
				`open:${mainWindow.vscodeWindowId}:/repo:project`,
			]);
			assert.deepStrictEqual(
				observed.map(value => value.activeInstanceId),
				['same']
			);
		}
	);
});

function state(activeInstanceId: string): IHucodeHostedWorkspaceState {
	return {
		activeInstanceId,
		projectsSidebarVisible: true,
		projectSwitcherCanGoBack: false,
		projectSwitcherCanGoForward: false,
		instances: [],
	};
}
