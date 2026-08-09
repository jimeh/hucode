/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { Emitter } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
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

	test('rejects non-file standalone opens before changing shell state',
		async () => {
			const changes = disposables.add(
				new Emitter<IHucodeShellWindowStateChange>()
			);
			const calls: string[] = [];
			const shell = {
				supportsWorkspaceScreenshotOverlay: false,
				onDidChangeWindowState: changes.event,
				async findHostedWorkspaceByPath(path: string) {
					calls.push(`find:${path}`);
					return undefined;
				},
			} as unknown as IHucodeShellService;
			const adapter = new WebShellControllerServiceAdapter(shell);

			assert.strictEqual(
				await adapter.prepareWorkspaceForStandaloneOpen({
					folderUri: URI.parse('https://example.test/repo').toJSON(),
				}),
				false
			);
			assert.deepStrictEqual(calls, []);
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
