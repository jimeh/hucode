/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HucodeDesktopWorkbenchOwnershipCoordinator,
	type HucodeDesktopWorkbenchOwner,
	validateHucodeDesktopHostedOwnership,
} from '../../electron-main/desktopWorkbenchOwnership.js';

suite('HucodeDesktopWorkbenchOwnershipCoordinator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const regular = (windowId: number): HucodeDesktopWorkbenchOwner => ({
		kind: 'regular',
		windowId,
	});
	const hosted = (
		windowId: number,
		instanceId: string
	): HucodeDesktopWorkbenchOwner => ({
		kind: 'hosted',
		windowId,
		instanceId,
	});
	const createCoordinator = (isCaseSensitive = true) =>
		new HucodeDesktopWorkbenchOwnershipCoordinator({
			canonicalizePath: path => path,
			isCaseSensitive,
			now: () => 100,
		});

	test('reserves, publishes, and reports a current owner', () => {
		const coordinator = createCoordinator();
		assert.deepStrictEqual(coordinator.lookup('/repo'), { kind: 'absent' });

		const reservation = coordinator.reserve('/repo', hosted(1, 'alpha'));
		assert.strictEqual(reservation.kind, 'reserved');
		if (reservation.kind !== 'reserved') {
			return;
		}
		assert.strictEqual(
			coordinator.publish(reservation.reservation).kind,
			'published'
		);
		const current = coordinator.reserve('/repo', hosted(2, 'bravo'));
		assert.strictEqual(current.kind, 'current-owner');
		assert.deepStrictEqual(current.ownership.owner, hosted(1, 'alpha'));
	});

	test('joins a concurrent reservation until it publishes', async () => {
		const coordinator = createCoordinator();
		const first = coordinator.reserve('/repo', hosted(1, 'alpha'));
		const second = coordinator.reserve('/repo', hosted(2, 'bravo'));
		assert.strictEqual(first.kind, 'reserved');
		assert.strictEqual(second.kind, 'reserved-conflict');
		if (first.kind !== 'reserved' ||
			second.kind !== 'reserved-conflict') {
			return;
		}

		coordinator.publish(first.reservation);

		const settled = await second.settled;
		assert.strictEqual(settled.kind, 'published');
		assert.deepStrictEqual(
			settled.kind === 'published' && settled.ownership.owner,
			hosted(1, 'alpha')
		);
	});

	test('lets a waiter retry after failed creation releases', async () => {
		const coordinator = createCoordinator();
		const first = coordinator.reserve('/repo', hosted(1, 'alpha'));
		const second = coordinator.reserve('/repo', hosted(2, 'bravo'));
		if (first.kind !== 'reserved' ||
			second.kind !== 'reserved-conflict') {
			assert.fail('expected a reservation conflict');
		}

		coordinator.release(first.reservation);

		assert.deepStrictEqual(await second.settled, { kind: 'released' });
		assert.strictEqual(
			coordinator.reserve('/repo', hosted(2, 'bravo')).kind,
			'reserved'
		);
	});

	test('stale generations cannot release or publish replacements', () => {
		const coordinator = createCoordinator();
		const first = coordinator.reserve('/repo', hosted(1, 'alpha'));
		if (first.kind !== 'reserved') {
			assert.fail('expected the initial reservation');
		}
		coordinator.release(first.reservation);
		const replacement = coordinator.reserve('/repo', hosted(1, 'bravo'));
		if (replacement.kind !== 'reserved') {
			assert.fail('expected the replacement reservation');
		}
		coordinator.publish(replacement.reservation);

		assert.strictEqual(
			coordinator.release(first.reservation).kind,
			'stale'
		);
		assert.strictEqual(
			coordinator.publish(first.reservation).kind,
			'stale'
		);
		const current = coordinator.lookup('/repo');
		assert.deepStrictEqual(
			current.kind === 'current-owner' && current.ownership.owner,
			hosted(1, 'bravo')
		);
	});

	test('uses configured platform path case semantics', () => {
		const sensitive = createCoordinator(true);
		const insensitive = createCoordinator(false);
		const sensitiveReservation = sensitive.reserve('/Repo', regular(1));
		const insensitiveReservation = insensitive.reserve('/Repo', regular(1));
		assert.strictEqual(sensitiveReservation.kind, 'reserved');
		assert.strictEqual(insensitiveReservation.kind, 'reserved');

		assert.strictEqual(
			sensitive.reserve('/repo', regular(2)).kind,
			'reserved'
		);
		assert.strictEqual(
			insensitive.reserve('/repo', regular(2)).kind,
			'reserved-conflict'
		);
	});

	test('uses canonical paths as the ownership key', () => {
		const coordinator = new HucodeDesktopWorkbenchOwnershipCoordinator({
			canonicalizePath: path => path.replace('/alias', '/real'),
			isCaseSensitive: true,
		});

		assert.strictEqual(
			coordinator.reserve('/alias/repo', regular(1)).kind,
			'reserved'
		);
		assert.strictEqual(
			coordinator.reserve('/real/repo', hosted(2, 'alpha')).kind,
			'reserved-conflict'
		);
	});

	test('admits unrelated paths without waiting', () => {
		const coordinator = createCoordinator();
		assert.strictEqual(
			coordinator.reserve('/alpha', hosted(1, 'alpha')).kind,
			'reserved'
		);
		assert.strictEqual(
			coordinator.reserve('/bravo', hosted(2, 'bravo')).kind,
			'reserved'
		);
	});

	test('seeds and reconciles regular and hosted owners', () => {
		const coordinator = createCoordinator();
		coordinator.seed({ path: '/regular', owner: regular(1) });
		coordinator.seed({ path: '/hosted', owner: hosted(2, 'alpha') });

		const results = coordinator.reconcile(
			owner => owner.kind === 'regular' && owner.windowId === 1,
			[{ path: '/replacement', owner: regular(1) }]
		);

		assert.strictEqual(results[0].kind, 'published');
		assert.deepStrictEqual(coordinator.lookup('/regular'), {
			kind: 'absent',
		});
		assert.strictEqual(coordinator.lookup('/replacement').kind, 'current-owner');
		assert.strictEqual(coordinator.lookup('/hosted').kind, 'current-owner');

		coordinator.releaseOwners(owner =>
			owner.kind === 'hosted' && owner.windowId === 2
		);
		assert.deepStrictEqual(coordinator.lookup('/hosted'), { kind: 'absent' });
	});

	test('keeps a crashed hosted owner discoverable for recovery', () => {
		const coordinator = createCoordinator();
		coordinator.seed({
			path: '/repo',
			owner: hosted(1, 'crashed-instance'),
			phase: 'recovering',
		});
		const crashedInstance = {
			instanceId: 'crashed-instance',
			projectId: 'project',
			worktreePath: '/repo',
			state: 'crashed' as const,
			visible: false,
			focused: false,
		};
		const lookup = coordinator.lookup('/repo');
		assert.strictEqual(lookup.kind, 'current-owner');
		if (lookup.kind !== 'current-owner') {
			return;
		}

		assert.strictEqual(validateHucodeDesktopHostedOwnership(
			coordinator,
			lookup.ownership,
			[crashedInstance]
		), crashedInstance);
		assert.strictEqual(coordinator.lookup('/repo').kind, 'current-owner');
	});

	test('releases a hosted owner whose instance is absent', () => {
		const coordinator = createCoordinator();
		coordinator.seed({
			path: '/repo',
			owner: hosted(1, 'missing-instance'),
		});
		const lookup = coordinator.lookup('/repo');
		assert.strictEqual(lookup.kind, 'current-owner');
		if (lookup.kind !== 'current-owner') {
			return;
		}

		assert.strictEqual(validateHucodeDesktopHostedOwnership(
			coordinator,
			lookup.ownership,
			[]
		), undefined);
		assert.deepStrictEqual(coordinator.lookup('/repo'), { kind: 'absent' });
	});
});
