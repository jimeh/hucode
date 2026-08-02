/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { SECRET_STORAGE_PREFIX } from '../../../platform/secrets/common/secrets.js';
import { IS_NEW_KEY } from '../../../platform/storage/common/storage.js';
import { shouldMigrateWebUserDataFile, shouldMigrateWebUserDataState } from '../../../platform/environment/common/hucodeWebUserDataMigration.js';

suite('HucodeWebUserDataMigration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('excludes the browser machine identifier', () => {
		assert.strictEqual(shouldMigrateWebUserDataFile('/User/settings.json'), true);
		assert.strictEqual(shouldMigrateWebUserDataFile('/User/profiles/work/settings.json'), true);
		assert.strictEqual(shouldMigrateWebUserDataFile('/User/machineid'), false);
		assert.strictEqual(shouldMigrateWebUserDataFile('/workspace/settings.json'), false);
	});

	test('excludes secret and storage bookkeeping state', () => {
		assert.strictEqual(shouldMigrateWebUserDataState('workbench.colorTheme', 'Default Dark Modern'), true);
		assert.strictEqual(shouldMigrateWebUserDataState(`${SECRET_STORAGE_PREFIX}github.token`, 'secret'), false);
		assert.strictEqual(shouldMigrateWebUserDataState(IS_NEW_KEY, 'true'), false);
		assert.strictEqual(shouldMigrateWebUserDataState('workbench.colorTheme', { value: 'not persisted state' }), false);
	});
});
