/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../platform/registry/common/platform.js';
import {
	ConfigurationMigration,
	Extensions as ConfigurationMigrationExtensions,
	IConfigurationMigrationRegistry,
} from '../../workbench/common/configuration.js';
import {
	HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING,
	HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING,
} from '../common/retainedWorkbench.js';

function migrateLegacyItemLayout(value: unknown) {
	return value === 'twoLine' ? { value: 'default' } : [];
}

/** Exact-value migrations for the renamed Omni item layout setting values. */
export const HUCODE_OMNI_ITEM_LAYOUT_CONFIGURATION_MIGRATIONS = [{
	key: HUCODE_OMNI_WORKBENCH_ITEM_LAYOUT_SETTING,
	migrateFn: migrateLegacyItemLayout,
}, {
	key: HUCODE_OMNI_WORKTREE_ITEM_LAYOUT_SETTING,
	migrateFn: migrateLegacyItemLayout,
}] satisfies ConfigurationMigration[];

Registry.as<IConfigurationMigrationRegistry>(
	ConfigurationMigrationExtensions.ConfigurationMigration
).registerConfigurationMigrations(
	HUCODE_OMNI_ITEM_LAYOUT_CONFIGURATION_MIGRATIONS
);
