/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { Event } from '../../../base/common/event.js';
import { mock } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	ConfigurationTarget,
	IConfigurationValue,
} from '../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from
	'../../../platform/configuration/test/common/testConfigurationService.js';
import {
	IWorkspaceContextService,
	WorkbenchState,
} from '../../../platform/workspace/common/workspace.js';
import {
	HUCODE_OMNI_ITEM_LAYOUT_CONFIGURATION_MIGRATIONS,
} from '../../browser/omniItemLayoutConfigurationMigration.js';
import {
	HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING,
	HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING,
} from '../../common/retainedWorkbench.js';
import { ConfigurationMigrationWorkbenchContribution } from
	'../../../workbench/common/configuration.js';

suite('OmniItemLayoutConfigurationMigration', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('migrates both legacy settings across persistent window targets',
		async () => {
			const layoutSettings = new Set([
				HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING,
				HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING,
			]);
			const updates: Array<{
				readonly key: string;
				readonly value: unknown;
				readonly target: ConfigurationTarget;
			}> = [];
			const completed = new DeferredPromise<void>();
			const configurationService = new class extends TestConfigurationService {
				override inspect<T>(key: string): IConfigurationValue<T> {
					return layoutSettings.has(key) ? {
						application: { value: 'twoLine' as T },
						user: { value: 'twoLine' as T },
						userLocal: { value: 'twoLine' as T },
						userRemote: { value: 'twoLine' as T },
						workspace: { value: 'twoLine' as T },
					} : {};
				}

				override updateValue(
					key: string,
					value: unknown,
					_overrides?: unknown,
					target?: ConfigurationTarget
				): Promise<void> {
					assert.notStrictEqual(target, undefined);
					updates.push({ key, value, target: target! });
					if (updates.length === 8) {
						completed.complete();
					}
					return Promise.resolve();
				}
			}();
			const workspaceService = new class extends
				mock<IWorkspaceContextService>() {
				override readonly onDidChangeWorkspaceFolders = Event.None;
				override getWorkbenchState(): WorkbenchState {
					return WorkbenchState.EMPTY;
				}
				override getWorkspace() {
					return { id: 'test', folders: [] };
				}
			}();

			disposables.add(new ConfigurationMigrationWorkbenchContribution(
				configurationService,
				workspaceService
			));
			await completed.p;

			assert.deepStrictEqual(updates.sort((left, right) =>
				left.key.localeCompare(right.key) || left.target - right.target
			), [
				HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING,
				HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING,
			].flatMap(key => [
				ConfigurationTarget.USER,
				ConfigurationTarget.USER_LOCAL,
				ConfigurationTarget.USER_REMOTE,
				ConfigurationTarget.WORKSPACE,
			].map(target => ({ key, value: 'default', target }))));
		}
	);

	test('rewrites only the legacy exact value for each setting', async () => {
		const [workbenchMigration, worktreeMigration] =
			HUCODE_OMNI_ITEM_LAYOUT_CONFIGURATION_MIGRATIONS;

		assert.deepStrictEqual({
			workbenchLegacy: await workbenchMigration.migrateFn(
				'twoLine'
			),
			workbenchCompact: await workbenchMigration.migrateFn(
				'compact'
			),
			worktreeLegacy: await worktreeMigration.migrateFn(
				'twoLine'
			),
			worktreeDefault: await worktreeMigration.migrateFn(
				'default'
			),
		}, {
			workbenchLegacy: { value: 'default' },
			workbenchCompact: [],
			worktreeLegacy: { value: 'default' },
			worktreeDefault: [],
		});
	});
});
