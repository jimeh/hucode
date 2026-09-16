/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	createHostedWorkbenchRestorePlan,
	deserializeRetainedWorkbenches,
	HUCODE_OMNI_ITEM_LAYOUT_DEFAULT,
	normalizeHucodeOmniItemLayout,
	RetainedWorkbenchCatalog,
} from '../../common/retainedWorkbench.js';

suite('RetainedWorkbench', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes public, legacy, absent, and invalid item layouts', () => {
		assert.deepStrictEqual({
			publicDefault: HUCODE_OMNI_ITEM_LAYOUT_DEFAULT,
			compact: normalizeHucodeOmniItemLayout('compact'),
			legacy: normalizeHucodeOmniItemLayout('twoLine'),
			absent: normalizeHucodeOmniItemLayout(undefined),
			invalid: normalizeHucodeOmniItemLayout('invalid'),
		}, {
			publicDefault: 'default',
			compact: 'compact',
			legacy: 'default',
			absent: 'default',
			invalid: 'default',
		});
	});

	test('retains folders with stable identity and manual order', () => {
		let nextId = 0;
		const catalog = new RetainedWorkbenchCatalog(
			[],
			uri => uri.fsPath.toLowerCase(),
			() => `workbench-${++nextId}`
		);

		const first = catalog.retain(URI.file('/Repos/One'), 'loaded', 42);
		catalog.update(first.id, { folderStatus: 'missing' });
		const duplicate = catalog.retain(
			URI.file('/repos/one'),
			'unloaded'
		);
		const second = catalog.retain(URI.file('/repos/two'));

		assert.strictEqual(duplicate.id, first.id);
		assert.strictEqual(duplicate.desiredState, 'unloaded');
		assert.strictEqual(duplicate.folderStatus, undefined);
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
		assert.strictEqual(catalog.move(first.id, second.id), true);
		const moved = catalog.all.map(record => record.id);
		assert.strictEqual(catalog.move(first.id, 'unknown'), false);
		assert.strictEqual(catalog.move('unknown', second.id), false);
		assert.deepStrictEqual(catalog.all.map(record => record.id), moved);
	});

	test('joins global metadata with independent session lifecycle', () => {
		const catalog = new RetainedWorkbenchCatalog(
			[],
			uri => uri.fsPath.toLowerCase(),
			() => 'legacy'
		);
		const local = catalog.retain(URI.file('/scratch'), 'loaded', 42);
		catalog.synchronizeGlobalRecords([{
			id: 'global',
			folderUri: URI.file('/SCRATCH'),
			label: 'Global Label',
			order: 0,
		}], () => true);

		assert.deepStrictEqual(catalog.all.map(record => ({
			...record,
			folderUri: URI.revive(record.folderUri).fsPath,
		})), [{
			id: 'global',
			folderUri: '/SCRATCH',
			desiredState: 'loaded',
			order: 0,
			label: 'Global Label',
			lastActiveAt: 42,
		}]);
		assert.notStrictEqual(catalog.all[0].id, local.id);

		catalog.synchronizeGlobalRecords([], () => true);
		assert.deepStrictEqual(catalog.all.map(record => record.id), ['global']);
		assert.strictEqual(catalog.all[0].sessionOnly, true);
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

	test('restores a dismissed record at its prior order', () => {
		let nextId = 0;
		const catalog = new RetainedWorkbenchCatalog(
			[],
			uri => uri.fsPath,
			() => `workbench-${++nextId}`
		);
		const first = catalog.retain(URI.file('/repos/one'));
		const restored = {
			...catalog.retain(URI.file('/repos/two'), 'unloaded', 42),
			label: 'Scratch',
		};
		const third = catalog.retain(URI.file('/repos/three'));

		assert.strictEqual(catalog.dismiss(restored.id), true);
		assert.strictEqual(catalog.restore(restored).id, restored.id);
		assert.deepStrictEqual(catalog.all, [first, restored, third]);

		assert.strictEqual(catalog.dismiss(restored.id), true);
		const replacement = catalog.retain(URI.file('/repos/two'), 'loaded');
		assert.strictEqual(catalog.restore(restored).id, replacement.id);
		assert.strictEqual(catalog.restore(restored).desiredState, 'loaded');
		assert.deepStrictEqual(
			catalog.all.map(record => record.id),
			[first.id, third.id, replacement.id]
		);
	});

	test('sets, trims, resets, and validates custom labels', () => {
		const catalog = new RetainedWorkbenchCatalog(
			[],
			uri => uri.fsPath,
			() => 'workbench'
		);
		const record = catalog.retain(URI.file('/repos/one'));

		assert.deepStrictEqual({
			renamed: catalog.setLabel(record.id, '  Scratch Pad  ')?.label,
			invalid: catalog.setLabel(record.id, '   '),
			preserved: catalog.getById(record.id)?.label,
			reset: catalog.setLabel(record.id, undefined)?.label,
		}, {
			renamed: 'Scratch Pad',
			invalid: undefined,
			preserved: 'Scratch Pad',
			reset: undefined,
		});
	});

	test('validates and deduplicates persisted records', () => {
		const records = deserializeRetainedWorkbenches([
			{
				id: 'valid',
				folderUri: URI.file('/repos/one').toJSON(),
				label: '  Custom One  ',
				desiredState: 'loaded',
				folderStatus: 'missing',
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
			{
				id: 'invalid-status',
				folderUri: URI.file('/repos/three').toJSON(),
				desiredState: 'unloaded',
				folderStatus: 'unknown' as 'missing',
				order: 2,
			},
			{
				id: 'missing-order',
				folderUri: URI.file('/repos/four').toJSON(),
				desiredState: 'loaded',
				order: undefined as unknown as number,
			},
			{
				id: 'non-finite-order',
				folderUri: URI.file('/repos/five').toJSON(),
				desiredState: 'unloaded',
				order: Number.NaN,
			},
			{
				id: 'blank-label',
				folderUri: URI.file('/repos/six').toJSON(),
				label: '   ',
				desiredState: 'unloaded',
				order: 9,
			},
		]);

		assert.deepStrictEqual(
			records.map(record => ({
				id: record.id,
				label: record.label,
				folderStatus: record.folderStatus,
				order: record.order,
			})),
			[{
				id: 'missing-order',
				label: undefined,
				folderStatus: undefined,
				order: 0,
			}, {
				id: 'non-finite-order',
				label: undefined,
				folderStatus: undefined,
				order: 1,
			}, {
				id: 'valid',
				label: 'Custom One',
				folderStatus: 'missing',
				order: 2,
			}, {
				id: 'blank-label',
				label: undefined,
				folderStatus: undefined,
				order: 3,
			}]
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
