/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	createHostedWorkbenchRestorePlan,
	deserializeRetainedWorkbenches,
	RetainedWorkbenchCatalog,
} from '../../common/retainedWorkbench.js';

suite('RetainedWorkbench', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('retains folders with stable identity and manual order', () => {
		let nextId = 0;
		const catalog = new RetainedWorkbenchCatalog(
			[],
			uri => uri.fsPath.toLowerCase(),
			() => `workbench-${++nextId}`
		);

		const first = catalog.retain(URI.file('/Repos/One'), 'loaded', 42);
		const duplicate = catalog.retain(
			URI.file('/repos/one'),
			'unloaded'
		);
		const second = catalog.retain(URI.file('/repos/two'));

		assert.strictEqual(duplicate.id, first.id);
		assert.strictEqual(duplicate.desiredState, 'unloaded');
		assert.strictEqual(duplicate.lastActiveAt, 42);
		assert.deepStrictEqual(
			catalog.all.map(record => [record.id, record.order]),
			[['workbench-1', 0], ['workbench-2', 1]]
		);

		assert.strictEqual(catalog.reorder([second.id, first.id]), true);
		assert.deepStrictEqual(
			catalog.all.map(record => record.id),
			[second.id, first.id]
		);
		assert.strictEqual(catalog.reorder([first.id]), false);
	});

	test('dismisses records and reconciles project promotions', () => {
		let nextId = 0;
		const catalog = new RetainedWorkbenchCatalog(
			[],
			uri => uri.fsPath,
			() => `workbench-${++nextId}`
		);
		const first = catalog.retain(URI.file('/repos/one'));
		const second = catalog.retain(URI.file('/repos/two'));

		assert.strictEqual(
			catalog.reconcileProjectPaths([URI.file('/repos/one')]),
			true
		);
		assert.deepStrictEqual(catalog.all.map(record => record.id), [second.id]);
		assert.strictEqual(catalog.dismiss(first.id), false);
		assert.strictEqual(catalog.dismiss(second.id), true);
		assert.deepStrictEqual(catalog.all, []);
	});

	test('validates and deduplicates persisted records', () => {
		const records = deserializeRetainedWorkbenches([
			{
				id: 'valid',
				folderUri: URI.file('/repos/one').toJSON(),
				desiredState: 'loaded',
				order: 7,
			},
			{
				id: 'duplicate-path',
				folderUri: URI.file('/repos/one').toJSON(),
				desiredState: 'unloaded',
				order: 0,
			},
			{
				id: '',
				folderUri: URI.file('/repos/two').toJSON(),
				desiredState: 'loaded',
				order: 1,
			},
		]);

		assert.deepStrictEqual(
			records.map(record => ({ id: record.id, order: record.order })),
			[{ id: 'valid', order: 0 }]
		);
	});

	test('schedules active, all, and none restore policies', () => {
		const candidates = [
			{ worktreePath: '/repos/old', lastActiveAt: 10 },
			{ worktreePath: '/repos/active', lastActiveAt: 20 },
			{ worktreePath: '/repos/new', lastActiveAt: 30 },
		];

		assert.deepStrictEqual(
			createHostedWorkbenchRestorePlan(
				candidates,
				'/repos/active',
				'active'
			),
			{
				eager: [candidates[1]],
				dormant: [candidates[0], candidates[2]],
			}
		);
		assert.deepStrictEqual(
			createHostedWorkbenchRestorePlan(candidates, undefined, 'none'),
			{ eager: [], dormant: candidates }
		);
		assert.deepStrictEqual(
			createHostedWorkbenchRestorePlan(
				candidates,
				'/repos/active',
				'all'
			).eager.map(candidate => candidate.worktreePath),
			['/repos/active', '/repos/old', '/repos/new']
		);
	});
});
