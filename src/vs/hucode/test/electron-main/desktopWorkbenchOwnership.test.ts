/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HucodeDesktopWorkbenchOwnershipCoordinator,
	createHucodeDesktopRestoreCandidates,
	createHucodeDesktopOwnershipState,
	type HucodeDesktopWorkbenchOwner,
	type IHucodeDesktopRestoreCandidate,
	selectHucodeDesktopRestoreWinners,
	transferHucodeDesktopWorkbenchToRegularWindow,
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

		const owner = coordinator.seed({
			path: '/real/repo',
			owner: regular(1),
		});
		assert.notStrictEqual(owner.kind, 'conflict');
		const aliasLookup = coordinator.lookup('/alias/repo');
		assert.strictEqual(aliasLookup.kind, 'current-owner');
		assert.strictEqual(
			aliasLookup.kind === 'current-owner' &&
			aliasLookup.ownership.displayPath,
			'/real/repo'
		);
		assert.strictEqual(
			coordinator.reserve('/alias/repo', hosted(2, 'alpha')).kind,
			'current-owner'
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

	test('arbitrates persisted restore claims by the documented priority', () => {
		const candidate = (
			path: string,
			windowId: number,
			overrides: Partial<IHucodeDesktopRestoreCandidate> = {}
		) => ({
			path,
			windowId,
			windowLastFocusTime: 10,
			stableInstanceId: `instance-${windowId}`,
			persistedActive: false,
			lastActiveAt: 10,
			...overrides,
		});
		const winners = selectHucodeDesktopRestoreWinners([
			candidate('/active', 1, { lastActiveAt: 100 }),
			candidate('/active', 2, { persistedActive: true, lastActiveAt: 1 }),
			candidate('/activity', 1, { lastActiveAt: 10 }),
			candidate('/activity', 2, { lastActiveAt: 20 }),
			candidate('/focus', 1, { windowLastFocusTime: 10 }),
			candidate('/focus', 2, { windowLastFocusTime: 20 }),
			candidate('/window', 2),
			candidate('/window', 1),
			candidate('/instance', 1, { stableInstanceId: 'bravo' }),
			candidate('/instance', 1, { stableInstanceId: 'alpha' }),
		], { canonicalizePath: path => path, isCaseSensitive: true });

		assert.deepStrictEqual(
			Array.from(winners.values(), winner => [
				winner.path,
				winner.windowId,
				winner.stableInstanceId,
			]),
			[
				['/active', 2, 'instance-2'],
				['/activity', 2, 'instance-2'],
				['/focus', 2, 'instance-2'],
				['/window', 1, 'instance-1'],
				['/instance', 1, 'alpha'],
			]
		);
	});

	test('builds project, retained, and legacy restore candidate identities',
		() => {
			const candidates = createHucodeDesktopRestoreCandidates({
				windowId: 3,
				windowLastFocusTime: 50,
				activeWorktreePath: '/legacy',
				residentWorkspaces: [
					{ path: '/project', projectId: 'project-alpha' },
					{ path: '/legacy', lastActiveAt: 40 },
					{ path: '/migrated', lastActiveAt: 30 },
				],
				retainedWorkbenches: [
					{
						path: '/retained',
						id: 'retained-alpha',
						desiredState: 'loaded',
					},
					{
						path: '/migrated',
						id: 'retained-migrated',
						desiredState: 'unloaded',
					},
					{
						path: '/ignored',
						id: 'retained-ignored',
						desiredState: 'unloaded',
					},
				],
			});

			assert.deepStrictEqual(candidates.map(candidate => ({
				path: candidate.path,
				stableInstanceId: candidate.stableInstanceId,
				persistedActive: candidate.persistedActive,
				lastActiveAt: candidate.lastActiveAt,
			})), [
				{
					path: '/project',
					stableInstanceId: 'project:project-alpha:/project',
					persistedActive: false,
					lastActiveAt: undefined,
				},
				{
					path: '/retained',
					stableInstanceId: 'retained:retained-alpha',
					persistedActive: false,
					lastActiveAt: undefined,
				},
				{
					path: '/legacy',
					stableInstanceId: 'legacy-retained:/legacy',
					persistedActive: true,
					lastActiveAt: 40,
				},
				{
					path: '/migrated',
					stableInstanceId: 'retained:retained-migrated',
					persistedActive: false,
					lastActiveAt: 30,
				},
			]);
		}
	);

	test('transfers hosted ownership to the opened regular window', async () => {
		const coordinator = createCoordinator();
		const seeded = coordinator.seed({
			path: '/repo',
			owner: hosted(1, 'alpha'),
		});
		assert.notStrictEqual(seeded.kind, 'conflict');
		if (seeded.kind === 'conflict') {
			return;
		}
		const calls: string[] = [];
		const result = await transferHucodeDesktopWorkbenchToRegularWindow({
			coordinator,
			ownership: seeded.ownership,
			closeHostedOwner: async () => {
				calls.push('close');
				coordinator.release(seeded.token);
				return true;
			},
			openRegularWindow: async () => {
				calls.push('open');
				return 7;
			},
		});

		assert.strictEqual(result.kind, 'transferred');
		assert.deepStrictEqual(calls, ['close', 'open']);
		const current = coordinator.lookup('/repo');
		assert.deepStrictEqual(
			current.kind === 'current-owner' && current.ownership.owner,
			regular(7)
		);
	});

	test('restores hosted ownership when transfer is vetoed', async () => {
		const coordinator = createCoordinator();
		const seeded = coordinator.seed({
			path: '/repo',
			owner: hosted(1, 'alpha'),
		});
		if (seeded.kind === 'conflict') {
			assert.fail('expected hosted ownership');
		}

		const result = await transferHucodeDesktopWorkbenchToRegularWindow({
			coordinator,
			ownership: seeded.ownership,
			closeHostedOwner: async () => false,
			openRegularWindow: async () => {
				assert.fail('must not open after veto');
			},
		});

		assert.deepStrictEqual(result, { kind: 'vetoed' });
		const current = coordinator.lookup('/repo');
		assert.strictEqual(
			current.kind === 'current-owner' && current.ownership.phase,
			'live'
		);
	});

	test('releases the regular reservation when transfer open fails',
		async () => {
			const coordinator = createCoordinator();
			const seeded = coordinator.seed({
				path: '/repo',
				owner: hosted(1, 'alpha'),
			});
			if (seeded.kind === 'conflict') {
				assert.fail('expected hosted ownership');
			}
			const failure = new Error('regular open failed');

			const result =
				await transferHucodeDesktopWorkbenchToRegularWindow({
					coordinator,
					ownership: seeded.ownership,
					closeHostedOwner: async () => {
						coordinator.release(seeded.token);
						return true;
					},
					openRegularWindow: async () => { throw failure; },
				});

			assert.deepStrictEqual(result, { kind: 'failed', error: failure });
			assert.deepStrictEqual(coordinator.lookup('/repo'), {
				kind: 'absent',
			});
		}
	);

	test('stale transfer completion cannot disturb replacement ownership',
		async () => {
			const coordinator = createCoordinator();
			const seeded = coordinator.seed({
				path: '/repo',
				owner: hosted(1, 'alpha'),
			});
			if (seeded.kind === 'conflict') {
				assert.fail('expected hosted ownership');
			}

			const result = await transferHucodeDesktopWorkbenchToRegularWindow({
				coordinator,
				ownership: seeded.ownership,
				closeHostedOwner: async () => {
					coordinator.release(seeded.token);
					const replacement = coordinator.reserve(
						'/repo',
						hosted(2, 'bravo')
					);
					assert.strictEqual(replacement.kind, 'reserved');
					if (replacement.kind === 'reserved') {
						coordinator.publish(replacement.reservation);
					}
					return true;
				},
				openRegularWindow: async () => 7,
			});

			assert.deepStrictEqual(result, { kind: 'superseded' });
			const current = coordinator.lookup('/repo');
			assert.deepStrictEqual(
				current.kind === 'current-owner' && current.ownership.owner,
				hosted(2, 'bravo')
			);
		}
	);

	test('projects ownership into each Omni session without reservations', () => {
		const coordinator = createCoordinator();
		coordinator.seed({ path: '/here', owner: hosted(1, 'here') });
		coordinator.seed({ path: '/elsewhere', owner: hosted(2, 'elsewhere') });
		coordinator.seed({ path: '/regular', owner: regular(3) });
		coordinator.reserve('/pending', regular(0));

		assert.deepStrictEqual(
			createHucodeDesktopOwnershipState(1, coordinator.snapshot()),
			[{
				worktreePath: '/here',
				location: 'this-omni',
				windowId: 1,
				instanceId: 'here',
				phase: 'live',
			}, {
				worktreePath: '/elsewhere',
				location: 'another-omni',
				windowId: 2,
				instanceId: 'elsewhere',
				phase: 'live',
			}, {
				worktreePath: '/regular',
				location: 'regular',
				windowId: 3,
				instanceId: undefined,
				phase: 'live',
			}]
		);
	});
});
