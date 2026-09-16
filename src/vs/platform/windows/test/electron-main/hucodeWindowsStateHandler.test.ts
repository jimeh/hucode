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
	applyHucodeOmniWorkbenchMigration,
	applyHucodeOmniWorkbenchMigrationToWindowState,
	getHucodeOmniMigrationWindowStates,
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
		const workbenchOverlays = [{
			workbenchId: 'global-scratch',
			desiredState: 'loaded' as const,
			lastActiveAt: 456,
		}];
		const pendingWorkbenchAdoptions = [{
			worktreePath: join(tmpdir(), 'orphaned'),
			desiredState: 'loaded' as const,
			lastActiveAt: 789,
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
				omniWorkbenchOverlays: workbenchOverlays,
				omniPendingWorkbenchAdoptions: pendingWorkbenchAdoptions,
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
			omniWorkbenchOverlays: restoredWindow.omniWorkbenchOverlays,
			omniPendingWorkbenchAdoptions:
				restoredWindow.omniPendingWorkbenchAdoptions,
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
			omniWorkbenchOverlays: workbenchOverlays,
			omniPendingWorkbenchAdoptions: pendingWorkbenchAdoptions,
		});
	});

	test('migrates every persisted Omni source and remaps duplicate IDs', () => {
		const firstPath = join(tmpdir(), 'migration', 'first');
		const secondPath = join(tmpdir(), 'migration', 'second');
		const projectPath = join(tmpdir(), 'migration', 'project');
		const state: IWindowsState = {
			lastActiveWindow: {
				windowKind: 'omni',
				uiState: { x: 0, y: 0, width: 100, height: 100, mode: 0 },
				omniRetainedWorkbenches: [{
					id: 'duplicate',
					folderUri: URI.file(firstPath).toJSON(),
					desiredState: 'loaded',
					order: 0,
				}],
			},
			openedWindows: [{
				windowKind: 'omni',
				uiState: { x: 0, y: 0, width: 100, height: 100, mode: 0 },
				omniRetainedWorkbenches: [{
					id: 'duplicate',
					folderUri: URI.file(secondPath).toJSON(),
					desiredState: 'unloaded',
					order: 0,
				}],
				omniResidentWorkspaces: [{ worktreePath: projectPath }],
			}],
		};

		assert.deepStrictEqual(
			getHucodeOmniMigrationWindowStates(state).map(source => source.sourceId),
			['lastActiveWindow', 'openedWindows:0']
		);
		applyHucodeOmniWorkbenchMigration(state, [{
			sourceId: 'lastActiveWindow',
			workbenchIdsByLegacyId: { duplicate: 'global-first' },
			workbenchIdsByPath: { [firstPath]: 'global-first' },
			projectIdsByPath: {},
		}, {
			sourceId: 'openedWindows:0',
			workbenchIdsByLegacyId: { duplicate: 'global-second' },
			workbenchIdsByPath: { [secondPath]: 'global-second' },
			projectIdsByPath: { [projectPath]: 'project' },
		}]);

		assert.deepStrictEqual(state.lastActiveWindow?.omniWorkbenchOverlays, [{
			workbenchId: 'global-first',
			desiredState: 'loaded',
		}]);
		assert.deepStrictEqual(state.openedWindows[0].omniWorkbenchOverlays, [{
			workbenchId: 'global-second',
			desiredState: 'unloaded',
		}]);
		assert.deepStrictEqual(state.openedWindows[0].omniResidentWorkspaces, [{
			worktreePath: projectPath,
			projectId: 'project',
		}]);
		assert.strictEqual(
			state.lastActiveWindow?.omniRetainedWorkbenches,
			undefined
		);
	});

	test('migrates a loaded project outcome into resident restore state', () => {
		const worktreePath = join(tmpdir(), 'migration', 'loaded-project');
		const state: IWindowsState = {
			openedWindows: [{
				windowKind: 'omni',
				uiState: { x: 0, y: 0, width: 100, height: 100, mode: 0 },
				omniActiveWorktreePath: worktreePath,
				omniRetainedWorkbenches: [{
					id: 'legacy-project',
					folderUri: URI.file(worktreePath).toJSON(),
					desiredState: 'loaded',
					order: 0,
					lastActiveAt: 87,
				}],
			}],
		};

		applyHucodeOmniWorkbenchMigration(state, [{
			sourceId: 'openedWindows:0',
			workbenchIdsByLegacyId: {},
			workbenchIdsByPath: {},
			projectIdsByPath: { [worktreePath]: 'project' },
		}]);

		assert.deepStrictEqual(state.openedWindows[0].omniResidentWorkspaces, [{
			projectId: 'project',
			worktreePath,
			state: 'loaded',
			lastActiveAt: 87,
		}]);
		assert.deepStrictEqual(
			state.openedWindows[0].omniWorkbenchOverlays,
			[]
		);
		assert.strictEqual(
			state.openedWindows[0].omniActiveWorktreePath,
			worktreePath
		);

		const liveConfig: Pick<IWindowsState['openedWindows'][number],
			'omniRetainedWorkbenches' | 'omniResidentWorkspaces' |
			'omniWorkbenchOverlays'> = {
			omniRetainedWorkbenches: [{
				id: 'live-legacy-project',
				folderUri: URI.file(worktreePath).toJSON(),
				desiredState: 'loaded' as const,
				order: 0,
				lastActiveAt: 88,
			}],
		};
		applyHucodeOmniWorkbenchMigrationToWindowState(liveConfig, {
			sourceId: 'live:1',
			workbenchIdsByLegacyId: {},
			workbenchIdsByPath: {},
			projectIdsByPath: { [worktreePath]: 'project' },
		});
		assert.deepStrictEqual(liveConfig.omniResidentWorkspaces, [{
			projectId: 'project',
			worktreePath,
			state: 'loaded',
			lastActiveAt: 88,
		}]);
	});

	test('migrates a resident-only arbitrary workbench into a loaded overlay',
		() => {
			const worktreePath = join(tmpdir(), 'migration', 'resident-arbitrary');
			const state: IWindowsState = {
				openedWindows: [{
					windowKind: 'omni',
					uiState: { x: 0, y: 0, width: 100, height: 100, mode: 0 },
					omniResidentWorkspaces: [{
						worktreePath,
						state: 'loaded',
						lastActiveAt: 91,
					}],
				}],
			};

			applyHucodeOmniWorkbenchMigration(state, [{
				sourceId: 'openedWindows:0',
				workbenchIdsByLegacyId: {},
				workbenchIdsByPath: { [worktreePath]: 'global-resident' },
				projectIdsByPath: {},
			}]);

			assert.deepStrictEqual(
				state.openedWindows[0].omniWorkbenchOverlays,
				[{
					workbenchId: 'global-resident',
					desiredState: 'loaded',
					lastActiveAt: 91,
				}]
			);
			assert.deepStrictEqual(
				state.openedWindows[0].omniResidentWorkspaces,
				[]
			);
		}
	);

	ensureNoDisposablesAreLeakedInTestSuite();
});
