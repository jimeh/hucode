/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	getWindowsStateStoreData,
	IWindowsState,
	restoreWindowsState,
} from '../../electron-main/windowsStateHandler.js';

suite('HucodeWindowsStateHandler', () => {

	test('stores and restores omni window state', () => {
		const worktreePath = join(tmpdir(), 'windowStateTest', 'testFolder');
		const retainedWorkbenches = [{
			id: 'scratch',
			folderUri: URI.file(join(tmpdir(), 'scratch')).toJSON(),
			desiredState: 'unloaded' as const,
			order: 0,
		}];
		const windowState: IWindowsState = {
			openedWindows: [{
				backupPath: join(tmpdir(), 'windowStateTest', 'backupFolder1'),
				uiState: {
					x: 0,
					y: 10,
					width: 100,
					height: 200,
					mode: 0
				},
				windowKind: 'omni',
				omniActiveWorktreePath: worktreePath,
				omniResidentWorkspaces: [{
					projectId: 'project-1',
					worktreePath,
					state: 'active',
					lastActiveAt: 123,
				}],
				omniRetainedWorkbenches: retainedWorkbenches,
			}]
		};

		const stored = getWindowsStateStoreData(windowState);
		const restored = restoreWindowsState(stored);
		const restoredWindow = restored.openedWindows[0];

		assert.deepStrictEqual({
			windowKind: restoredWindow.windowKind,
			omniActiveWorktreePath: restoredWindow.omniActiveWorktreePath,
			omniResidentWorkspaces: restoredWindow.omniResidentWorkspaces,
			omniRetainedWorkbenches: restoredWindow.omniRetainedWorkbenches,
		}, {
			windowKind: 'omni',
			omniActiveWorktreePath: worktreePath,
			omniResidentWorkspaces: [{
				projectId: 'project-1',
				worktreePath,
				state: 'active',
				lastActiveAt: 123,
			}],
			omniRetainedWorkbenches: retainedWorkbenches,
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
