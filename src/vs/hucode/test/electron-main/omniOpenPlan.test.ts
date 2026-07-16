/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import {
	createHucodeOmniWindowPath,
	distinctHucodeOmniWindowPaths,
	filterHucodePreserveRestorePaths,
	getHucodeDefaultStartupWindowPath,
	getHucodeOmniBrowserWindowOptions,
	getHucodeOmniFileOpenPlan,
	getHucodeOmniPathFromWindowState,
	getHucodeRegularFileOpenWindows,
	isHucodeOmniPathToOpen,
	openNewHucodeOmniWindow
} from '../../electron-main/omniOpenPlan.js';

suite('HucodeOmniOpenPlan', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses an Omni window for the default app startup window', () => {
		assert.deepStrictEqual(
			getHucodeDefaultStartupWindowPath({ initialStartup: true }),
			{ isOmniWindow: true }
		);
	});

	test('does not replace explicit or restorable empty windows', () => {
		const results = [
			getHucodeDefaultStartupWindowPath({ initialStartup: false }),
			getHucodeDefaultStartupWindowPath({}),
			getHucodeDefaultStartupWindowPath({
				initialStartup: true,
				hasRestorableWindows: true
			})
		];

		assert.deepStrictEqual(results, [undefined, undefined, undefined]);
	});

	test('identifies and restores Omni window paths', () => {
		const omniPath = createHucodeOmniWindowPath({
			omniActiveWorktreePath: '/repo',
			omniResidentWorkspaces: [{
				projectId: 'project',
				worktreePath: '/repo',
				lastActiveAt: 1,
				state: 'active'
			}]
		});

		assert.strictEqual(isHucodeOmniPathToOpen(omniPath), true);
		assert.strictEqual(isHucodeOmniPathToOpen({}), false);
		assert.deepStrictEqual(
			getHucodeOmniPathFromWindowState({
				windowKind: 'omni',
				omniActiveWorktreePath: '/repo',
				omniResidentWorkspaces: omniPath.omniResidentWorkspaces
			}),
			omniPath
		);
		assert.strictEqual(
			getHucodeOmniPathFromWindowState({ windowKind: 'workbench' }),
			undefined
		);
	});

	test('keeps Omni paths in preserve restore filtering', () => {
		const workspace = { kind: 'workspace' };
		const folder = { kind: 'folder' };
		const empty = { backupPath: 'empty-backup' };
		const omni = createHucodeOmniWindowPath();
		const ignored = { kind: 'file' };
		const paths: Array<{
			readonly kind?: string;
			readonly backupPath?: string;
			readonly isOmniWindow?: boolean;
		}> = [workspace, folder, empty, omni, ignored];

		assert.deepStrictEqual(
			filterHucodePreserveRestorePaths(
				paths,
				path => path.kind === 'workspace',
				path => path.kind === 'folder'
			),
			[workspace, folder, empty, omni]
		);
	});

	test('dedupes Omni restore paths by active and resident workspaces', () => {
		const first = createHucodeOmniWindowPath({
			omniActiveWorktreePath: '/repo'
		});
		const duplicate = createHucodeOmniWindowPath({
			omniActiveWorktreePath: '/repo'
		});
		const second = createHucodeOmniWindowPath({
			omniActiveWorktreePath: '/other'
		});

		assert.deepStrictEqual(
			distinctHucodeOmniWindowPaths([first, duplicate, second]),
			[first, second]
		);
	});

	test('builds Omni browser window options from open config', () => {
		assert.deepStrictEqual(
			getHucodeOmniBrowserWindowOptions(
				{
					initialStartup: true,
					forceNewTabbedWindow: true,
					forceProfile: 'Profile',
					forceTempProfile: true
				},
				createHucodeOmniWindowPath({
					omniActiveWorktreePath: '/repo'
				}),
				true
			),
			{
				userEnv: undefined,
				cli: undefined,
				initialStartup: true,
				forceNewWindow: true,
				forceNewTabbedWindow: true,
				forceProfile: 'Profile',
				forceTempProfile: true,
				isOmniWindow: true,
				omniActiveWorktreePath: '/repo',
				omniResidentWorkspaces: undefined
			}
		);
	});

	test('opens and focuses a distinct Omni window for every request', async () => {
		const input = {
			context: 'api',
			forceNewWindow: false,
			forceOmniWindow: false,
			forceEmpty: true,
			noRecentEntry: false
		};
		const requests: object[] = [];
		const restoredWindows: Array<{
			readonly id: number;
			focusCount: number;
			focus(): void;
		}> = [];
		const openedWindows: Array<{
			readonly id: number;
			focusCount: number;
			focus(): void;
		}> = [];
		const open = async (configuration: object) => {
			requests.push(configuration);
			const restoredWindow = {
				id: -(restoredWindows.length + 1),
				focusCount: 0,
				focus() {
					this.focusCount++;
				}
			};
			const window = {
				id: openedWindows.length + 1,
				focusCount: 0,
				focus() {
					this.focusCount++;
				}
			};
			restoredWindows.push(restoredWindow);
			openedWindows.push(window);
			return [restoredWindow, window];
		};

		const first = await openNewHucodeOmniWindow(input, open);
		const second = await openNewHucodeOmniWindow(input, open);

		assert.deepStrictEqual(
			{
				distinctRequests: requests[0] !== requests[1],
				distinctWindows: first[1] !== second[1],
				returnedWindowIds: [first[1].id, second[1].id],
				restoredFocusCounts: restoredWindows.map(
					window => window.focusCount
				),
				focusCounts: openedWindows.map(window => window.focusCount),
				requests
			},
			{
				distinctRequests: true,
				distinctWindows: true,
				returnedWindowIds: [1, 2],
				restoredFocusCounts: [0, 0],
				focusCounts: [1, 1],
				requests: [
					{
						context: 'api',
						forceNewWindow: true,
						forceOmniWindow: true,
						forceEmpty: false,
						noRecentEntry: true
					},
					{
						context: 'api',
						forceNewWindow: true,
						forceOmniWindow: true,
						forceEmpty: false,
						noRecentEntry: true
					}
				]
			}
		);
	});

	test('plans Omni file routing before regular window fallback', async () => {
		const regular = { id: 1, isOmniWindow: false };
		const omni = { id: 2, isOmniWindow: true };
		let routedThroughOmni = false;

		assert.deepStrictEqual(
			await getHucodeOmniFileOpenPlan({
				windows: [regular, omni],
				async openInOmniWindow() {
					routedThroughOmni = true;
					return omni;
				}
			}),
			{ omniWindow: omni }
		);
		assert.strictEqual(routedThroughOmni, true);

		routedThroughOmni = false;
		assert.deepStrictEqual(
			await getHucodeOmniFileOpenPlan({
				forceNewWindow: true,
				windows: [regular, omni],
				async openInOmniWindow() {
					routedThroughOmni = true;
					return omni;
				}
			}),
			{ fallbackWindows: [regular] }
		);
		assert.strictEqual(routedThroughOmni, false);
	});

	test('excludes Omni shell windows from regular file fallback', () => {
		const regular = { id: 1, isOmniWindow: false };
		const legacy = { id: 2 };
		const omni = { id: 3, isOmniWindow: true };

		assert.deepStrictEqual(
			getHucodeRegularFileOpenWindows([regular, legacy, omni]),
			[regular, legacy]
		);
	});
});
