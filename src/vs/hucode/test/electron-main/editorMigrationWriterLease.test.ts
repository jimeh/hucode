/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EditorMigrationWriterLeaseAuthority } from '../../electron-main/migration/editorMigrationWriterLease.js';

suite('EditorMigrationWriterLeaseAuthority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('allows one installation writer and ignores stale generation release', () => {
		const authority = new EditorMigrationWriterLeaseAuthority();
		const first = authority.acquire(1, 'first');
		assert.ok(first);
		assert.strictEqual(authority.acquire(2, 'competing'), undefined);
		assert.strictEqual(authority.holds(1, 'first'), true);

		authority.release(first);
		const replacement = authority.acquire(2, 'replacement');
		assert.ok(replacement);
		authority.release(first);
		assert.strictEqual(authority.holds(2, 'replacement'), true);
		authority.release(replacement);
		assert.strictEqual(authority.holds(2, 'replacement'), false);
	});

	test('rejects empty operation identities', () => {
		assert.strictEqual(new EditorMigrationWriterLeaseAuthority().acquire(1, ''), undefined);
	});
});
