/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { bindEditorMigrationWriterLease, EditorMigrationWriterLeaseAuthority } from '../../electron-main/migration/editorMigrationWriterLease.js';

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

	test('binds reacquire, validation, explicit release, and connection disposal to one connection', async () => {
		const authority = new EditorMigrationWriterLeaseAuthority();
		const connection = new DisposableStore();
		const bound = bindEditorMigrationWriterLease(authority, 1, connection);

		assert.strictEqual(await bound.acquire('first'), true);
		assert.strictEqual(await bound.acquire('replacement'), false);
		assert.strictEqual(await bound.validate('first'), true);
		assert.strictEqual(await bound.validate('replacement'), false);
		await bound.release('replacement');
		assert.strictEqual(await bound.validate('first'), true);
		await bound.release('first');
		assert.strictEqual(await bound.validate('first'), false);
		assert.strictEqual(await bound.acquire('replacement'), true);
		connection.dispose();
		assert.strictEqual(await bound.validate('replacement'), false);
		assert.ok(authority.acquire(2, 'competing'));
	});
});
