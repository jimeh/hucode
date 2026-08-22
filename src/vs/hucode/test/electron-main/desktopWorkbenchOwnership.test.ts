/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	admitHucodeRegularWorkbench,
	HucodeDesktopWorkbenchOwnershipCoordinator,
	HucodeRegularWindowLoadCoordinator,
	HucodeRegularWindowOwnershipLifetimes,
	createHucodeDesktopRestoreCandidates,
	createHucodeDesktopOwnershipState,
	discardHucodeFailedRegularWindowTarget,
	isHucodeRegularWindowAvailableForQueuedLoad,
	retainHucodeNativeOpenPayloadAfterAdmission,
	shouldDiscardHucodeFailedRegularWindowTarget,
	shouldDiscardHucodeRegularWindowAfterOpenFailure,
	shouldSettleHucodeNativeOpenWaitMarkerAfterAdmission,
	shouldAwaitHucodeRegularWindowLoadCommit,
	type HucodeDesktopWorkbenchOwner,
	type IHucodeDesktopRestoreCandidate,
	selectHucodeDesktopRestoreWinners,
	transferHucodeDesktopWorkbenchToRegularWindow,
	validateHucodeDesktopHostedOwnership,
	waitForHucodeRegularWindowLoadCommit,
	waitForHucodeRegularWindowTargetCommit,
} from '../../electron-main/desktopWorkbenchOwnership.js';

suite('HucodeDesktopWorkbenchOwnershipCoordinator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const regular = (windowId: number): Extract<
		HucodeDesktopWorkbenchOwner,
		{ readonly kind: 'regular' }
	> => ({
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

	test('routes recovering ownership instead of waiting for recovery', async () => {
		const coordinator = createCoordinator();
		const seeded = coordinator.seed({
			path: '/repo',
			owner: hosted(1, 'recovering'),
		});
		if (seeded.kind === 'conflict') {
			assert.fail('expected hosted ownership');
		}
		coordinator.markTransferring(seeded.token);
		const hostedWaitingBeforeRecovery = coordinator.reserve(
			'/repo',
			hosted(2, 'waiting-before-recovery')
		);
		assert.strictEqual(
			hostedWaitingBeforeRecovery.kind,
			'reserved-conflict'
		);
		let resolutions = 0;

		const routing = admitHucodeRegularWorkbench({
			coordinator,
			path: '/repo',
			pendingOwner: regular(-1),
			resolveCurrent: async ownership => {
				resolutions++;
				assert.strictEqual(ownership.phase, 'recovering');
				return {
					kind: 'focused-hosted',
					value: 'recovered',
					filesDelivered: false,
					payloadDisposition: 'preserve',
				};
			},
			openRegularWindow: async () => {
				assert.fail('recovering ownership must route to its owner');
			},
		});
		await Promise.resolve();
		assert.strictEqual(resolutions, 0);
		coordinator.markRecovering(seeded.token);
		const hostedWaiting = coordinator.reserve(
			'/repo',
			hosted(2, 'waiting')
		);
		assert.strictEqual(hostedWaiting.kind, 'reserved-conflict');
		const result = await routing;

		assert.strictEqual(resolutions, 1);
		assert.strictEqual(result.kind, 'focused-hosted');
		if (hostedWaitingBeforeRecovery.kind !== 'reserved-conflict') {
			assert.fail('hosted ownership must wait before recovery');
		}
		if (hostedWaiting.kind !== 'reserved-conflict') {
			assert.fail('hosted ownership must wait for recovery');
		}
		const recoveryTransition =
			await hostedWaitingBeforeRecovery.settled;
		assert.strictEqual(recoveryTransition.kind, 'recovering');
		if (recoveryTransition.kind !== 'recovering') {
			assert.fail('expected a recovery transition');
		}
		coordinator.release(seeded.token);
		assert.deepStrictEqual(await recoveryTransition.settled, {
			kind: 'released',
		});
		assert.deepStrictEqual(await hostedWaiting.settled, {
			kind: 'released',
		});
	});

	test('releases initial and newly opened regular owners on close', () => {
		const coordinator = createCoordinator();
		const lifetimes = new HucodeRegularWindowOwnershipLifetimes(
			coordinator
		);
		const initialClosed = new Emitter<void>();
		const initialDestroyed = new Emitter<void>();
		const openedClosed = new Emitter<void>();
		const openedDestroyed = new Emitter<void>();
		coordinator.seed({ path: '/initial', owner: regular(1) });
		coordinator.seed({ path: '/opened', owner: regular(2) });
		lifetimes.add({
			id: 1,
			onDidClose: initialClosed.event,
			onDidDestroy: initialDestroyed.event,
		});
		lifetimes.add({
			id: 2,
			onDidClose: openedClosed.event,
			onDidDestroy: openedDestroyed.event,
		});
		lifetimes.add({
			id: 2,
			onDidClose: openedClosed.event,
			onDidDestroy: openedDestroyed.event,
		});

		initialClosed.fire();
		assert.deepStrictEqual(coordinator.lookup('/initial'), {
			kind: 'absent',
		});
		assert.strictEqual(coordinator.lookup('/opened').kind, 'current-owner');
		initialDestroyed.fire();
		assert.strictEqual(coordinator.lookup('/opened').kind, 'current-owner');
		openedDestroyed.fire();
		assert.deepStrictEqual(coordinator.lookup('/opened'), {
			kind: 'absent',
		});

		lifetimes.dispose();
		initialClosed.dispose();
		initialDestroyed.dispose();
		openedClosed.dispose();
		openedDestroyed.dispose();
	});

	test('publishes regular ownership only after a reused window commits', async () => {
		const coordinator = createCoordinator();
		let finishOpen!: () => void;
		const openGate = new Promise<void>(resolve => finishOpen = resolve);
		const opening = admitHucodeRegularWorkbench({
			coordinator,
			path: '/repo',
			pendingOwner: regular(-1),
			resolveCurrent: async () => ({ kind: 'stale' }),
			openRegularWindow: async () => {
				await openGate;
				return {
					kind: 'committed',
					windowId: 7,
					value: 'window-7',
					filesDelivered: true,
				};
			},
		});
		const pending = coordinator.lookup('/repo');
		assert.strictEqual(
			pending.kind === 'current-owner' && pending.ownership.phase,
			'reserved'
		);
		finishOpen();
		assert.deepStrictEqual(await opening, {
			kind: 'opened',
			value: 'window-7',
			filesDelivered: true,
			payloadDisposition: 'delivered',
		});
		const owner = coordinator.lookup('/repo');
		assert.deepStrictEqual(
			owner.kind === 'current-owner' && owner.ownership.owner,
			regular(7)
		);
	});

	for (const kind of ['vetoed', 'failed'] as const) {
		test(`releases a regular reservation when window reuse is ${kind}`,
			async () => {
				const coordinator = createCoordinator();
				const failure = new Error('load failed');
				const result = await admitHucodeRegularWorkbench({
					coordinator,
					path: '/repo',
					pendingOwner: regular(-1),
					resolveCurrent: async () => ({ kind: 'stale' }),
					openRegularWindow: async () => kind === 'vetoed'
						? { kind }
						: { kind, error: failure },
				});
				assert.deepStrictEqual(result, kind === 'vetoed'
					? { kind, payloadDisposition: 'consumed' }
					: {
						kind,
						error: failure,
						payloadDisposition: 'preserve',
					});
				assert.deepStrictEqual(coordinator.lookup('/repo'), {
					kind: 'absent',
				});
			}
		);
	}

	test('releases a regular reservation when opening rejects', async () => {
		const coordinator = createCoordinator();
		const failure = new Error('open rejected');

		const result = await admitHucodeRegularWorkbench({
			coordinator,
			path: '/repo',
			pendingOwner: regular(-1),
			resolveCurrent: async () => ({ kind: 'stale' }),
			openRegularWindow: async () => { throw failure; },
		});

		assert.deepStrictEqual(result, {
			kind: 'failed',
			error: failure,
			payloadDisposition: 'preserve',
		});
		assert.deepStrictEqual(coordinator.lookup('/repo'), {
			kind: 'absent',
		});
	});

	test('ownership tokens retain their original canonical key', () => {
		let canonicalization = 0;
		const coordinator = new HucodeDesktopWorkbenchOwnershipCoordinator({
			canonicalizePath: () => canonicalization++ === 0
				? '/canonical/first'
				: '/canonical/replacement',
			isCaseSensitive: true,
		});
		const reservation = coordinator.reserve('/link', regular(-1));
		assert.strictEqual(reservation.kind, 'reserved');
		if (reservation.kind !== 'reserved') {
			return;
		}

		assert.deepStrictEqual(coordinator.release(reservation.reservation), {
			kind: 'released',
		});
		assert.deepStrictEqual(coordinator.snapshot(), []);
	});

	test('does not publish over a replacement created during regular load',
		async () => {
			const coordinator = createCoordinator();
			const result = await admitHucodeRegularWorkbench({
				coordinator,
				path: '/repo',
				pendingOwner: regular(-1),
				resolveCurrent: async () => ({ kind: 'stale' }),
				openRegularWindow: async () => {
					const pending = coordinator.lookup('/repo');
					assert.strictEqual(pending.kind, 'current-owner');
					if (pending.kind === 'current-owner') {
						coordinator.release({
							canonicalPath: pending.ownership.canonicalPath,
							owner: pending.ownership.owner,
							generation: pending.ownership.generation,
						});
					}
					coordinator.seed({ path: '/repo', owner: regular(9) });
					return {
						kind: 'committed',
						windowId: 7,
						value: 'window-7',
						filesDelivered: false,
					};
				},
			});
			assert.deepStrictEqual(result, {
				kind: 'superseded',
				payloadDisposition: 'consumed',
			});
			const owner = coordinator.lookup('/repo');
			assert.deepStrictEqual(
				owner.kind === 'current-owner' && owner.ownership.owner,
				regular(9)
			);
		}
	);

	test('routes an alias to its current owner and preserves delivery status',
		async () => {
			const coordinator = new HucodeDesktopWorkbenchOwnershipCoordinator({
				canonicalizePath: path => path.replace('/alias', '/real'),
				isCaseSensitive: true,
			});
			coordinator.seed({
				path: '/real/repo',
				owner: hosted(2, 'hosted-instance'),
			});
			let opened = false;
			const result = await admitHucodeRegularWorkbench({
				coordinator,
				path: '/alias/repo',
				pendingOwner: regular(-1),
				resolveCurrent: async ownership => {
					assert.strictEqual(ownership.displayPath, '/real/repo');
					return {
						kind: 'focused-hosted',
						value: 'hosted-window',
						filesDelivered: false,
						payloadDisposition: 'preserve',
					};
				},
				openRegularWindow: async () => {
					opened = true;
					return { kind: 'failed' };
				},
			});

			assert.deepStrictEqual(result, {
				kind: 'focused-hosted',
				value: 'hosted-window',
				filesDelivered: false,
				payloadDisposition: 'preserve',
			});
			assert.strictEqual(opened, false);
		}
	);

	for (const missing of ['controller', 'routed Omni window'] as const) {
		test(`retries after a missing hosted ${missing} releases ownership`,
			async () => {
				const coordinator = createCoordinator();
				coordinator.seed({
					path: '/repo',
					owner: hosted(2, 'missing'),
				});
				let resolutions = 0;
				const result = await admitHucodeRegularWorkbench({
					coordinator,
					path: '/repo',
					pendingOwner: regular(-1),
					resolveCurrent: async ownership => {
						resolutions++;
						assert.strictEqual(ownership.owner.kind, 'hosted');
						return { kind: 'stale' };
					},
					openRegularWindow: async () => ({
						kind: 'committed',
						windowId: 7,
						value: 'window-7',
						filesDelivered: false,
					}),
				});

				assert.strictEqual(resolutions, 1);
				assert.strictEqual(result.kind, 'opened');
				const owner = coordinator.lookup('/repo');
				assert.deepStrictEqual(
					owner.kind === 'current-owner' && owner.ownership.owner,
					regular(7)
				);
			}
		);
	}

	test('stale hosted cleanup cannot release a replacement generation',
		async () => {
			const coordinator = createCoordinator();
			const original = coordinator.seed({
				path: '/repo',
				owner: hosted(2, 'original'),
			});
			assert.notStrictEqual(original.kind, 'conflict');
			if (original.kind === 'conflict') {
				return;
			}
			let firstResolution = true;
			let opened = false;
			const result = await admitHucodeRegularWorkbench({
				coordinator,
				path: '/repo',
				pendingOwner: regular(-1),
				resolveCurrent: async ownership => {
					if (firstResolution) {
						firstResolution = false;
						coordinator.release(original.token);
						const replacement = coordinator.seed({
							path: '/repo',
							owner: hosted(3, 'replacement'),
						});
						assert.notStrictEqual(replacement.kind, 'conflict');
						return { kind: 'stale' };
					}
					assert.deepStrictEqual(ownership.owner, hosted(3, 'replacement'));
					return {
						kind: 'focused-hosted',
						value: 'replacement-window',
						filesDelivered: false,
						payloadDisposition: 'preserve',
					};
				},
				openRegularWindow: async () => {
					opened = true;
					return { kind: 'failed' };
				},
			});

			assert.deepStrictEqual(result, {
				kind: 'focused-hosted',
				value: 'replacement-window',
				filesDelivered: false,
				payloadDisposition: 'preserve',
			});
			assert.strictEqual(opened, false);
			const owner = coordinator.lookup('/repo');
			assert.deepStrictEqual(
				owner.kind === 'current-owner' && owner.ownership.owner,
				hosted(3, 'replacement')
			);
		}
	);

	test('superseded transfer retries a same-generation recovering owner',
		async () => {
			const coordinator = createCoordinator();
			const seeded = coordinator.seed({
				path: '/repo',
				owner: hosted(1, 'alpha'),
			});
			if (seeded.kind === 'conflict') {
				assert.fail('expected hosted ownership');
			}
			let resolutions = 0;

			const result = await admitHucodeRegularWorkbench({
				coordinator,
				path: '/repo',
				pendingOwner: regular(-1),
				resolveCurrent: async ownership => {
					resolutions++;
					if (resolutions === 1) {
						const transfer =
							await transferHucodeDesktopWorkbenchToRegularWindow({
								coordinator,
								ownership,
								closeHostedOwner: async () => {
									coordinator.markRecovering(seeded.token);
									return false;
								},
								openRegularWindow: async () => {
									assert.fail('recovery keeps the hosted owner');
								},
								recoverHostedOwner: async () => {
									assert.fail('recovery is already pending');
								},
							});
						assert.strictEqual(transfer.kind, 'superseded');
						return { kind: 'retry' };
					}

					assert.strictEqual(ownership.phase, 'recovering');
					return {
						kind: 'focused-hosted',
						value: 'recovering-window',
						filesDelivered: true,
						payloadDisposition: 'delivered',
					};
				},
				openRegularWindow: async () => {
					assert.fail('recovering ownership must remain hosted');
				},
			});

			assert.strictEqual(resolutions, 2);
			assert.strictEqual(result.kind, 'focused-hosted');
			const current = coordinator.lookup('/repo');
			assert.strictEqual(
				current.kind === 'current-owner' && current.ownership.phase,
				'recovering'
			);
		}
	);

	test('keeps admission reserved until the expected window target is ready',
		async () => {
			const coordinator = createCoordinator();
			const ready = new Emitter<void>();
			const closed = new Emitter<void>();
			const destroyed = new Emitter<void>();
			const load = { target: undefined as string | undefined };
			const waiter = waitForHucodeRegularWindowTargetCommit({
				onDidSignalReady: ready.event,
				onDidClose: closed.event,
				onDidDestroy: destroyed.event,
				getTarget: () => load.target,
				expectedTarget: '/repo',
				targetsEqual: (actual, expected) => actual === expected,
				timeoutMs: 1000,
			});
			let regularOpenCount = 0;
			const opening = admitHucodeRegularWorkbench({
				coordinator,
				path: '/repo',
				pendingOwner: regular(-1),
				resolveCurrent: async () => ({
					kind: 'focused-regular',
					value: 'existing-window',
					filesDelivered: false,
					payloadDisposition: 'preserve',
				}),
				openRegularWindow: async () => {
					regularOpenCount++;
					const committed = await waiter.result;
					return committed.kind === 'committed'
						? {
							kind: 'committed',
							windowId: 7,
							value: 'window-7',
							filesDelivered: false,
						}
						: { kind: 'failed', error: committed };
				},
			});
			const competing = admitHucodeRegularWorkbench({
				coordinator,
				path: '/repo',
				pendingOwner: regular(-2),
				resolveCurrent: async () => ({
					kind: 'focused-regular',
					value: 'window-7',
					filesDelivered: false,
					payloadDisposition: 'preserve',
				}),
				openRegularWindow: async () => {
					regularOpenCount++;
					return { kind: 'failed' };
				},
			});

			coordinator.reconcile(
				owner => owner.kind === 'regular' && owner.windowId === 7,
				[]
			);
			const pending = coordinator.lookup('/repo');
			assert.strictEqual(
				pending.kind === 'current-owner' && pending.ownership.phase,
				'reserved'
			);
			assert.strictEqual(regularOpenCount, 1);
			load.target = '/repo';
			const readyReconciliation = coordinator.reconcile(
				owner => owner.kind === 'regular' && owner.windowId === 7,
				[{ path: '/repo', owner: regular(7) }]
			);
			assert.strictEqual(readyReconciliation[0].kind, 'conflict');
			const stillPending = coordinator.lookup('/repo');
			assert.strictEqual(
				stillPending.kind === 'current-owner' &&
				stillPending.ownership.phase,
				'reserved'
			);
			ready.fire();

			assert.strictEqual((await opening).kind, 'opened');
			assert.strictEqual((await competing).kind, 'focused-regular');
			assert.strictEqual(regularOpenCount, 1);
			waiter.dispose();
			ready.dispose();
			closed.dispose();
			destroyed.dispose();
		}
	);

	test('reserved direct and admitted opens both require target commit', () => {
		assert.strictEqual(
			shouldAwaitHucodeRegularWindowLoadCommit(true, false),
			true
		);
		assert.strictEqual(
			shouldAwaitHucodeRegularWindowLoadCommit(false, true),
			true
		);
		assert.strictEqual(
			shouldAwaitHucodeRegularWindowLoadCommit(false, false),
			false
		);
	});

	test('serializes two admitted target commits sharing a native window',
		async () => {
			const coordinator = createCoordinator();
			const loads = new HucodeRegularWindowLoadCoordinator();
			const ready = new Emitter<void>();
			const closed = new Emitter<void>();
			const destroyed = new Emitter<void>();
			const load = { target: undefined as string | undefined };
			let destroyCalls = 0;
			const starts: string[] = [];
			let startAlpha!: () => void;
			const alphaStarted = new Promise<void>(resolve => startAlpha = resolve);
			let startBravo!: () => void;
			const bravoStarted = new Promise<void>(resolve => startBravo = resolve);
			const open = (path: string, pendingWindowId: number) =>
				admitHucodeRegularWorkbench({
					coordinator,
					path,
					pendingOwner: regular(pendingWindowId),
					resolveCurrent: async () => ({ kind: 'stale' }),
					openRegularWindow: () => loads.run(7, async () => {
						starts.push(path);
						if (path === '/alpha') {
							startAlpha();
						} else {
							startBravo();
						}
						const waiter = waitForHucodeRegularWindowTargetCommit({
							onDidSignalReady: ready.event,
							onDidClose: closed.event,
							onDidDestroy: destroyed.event,
							getTarget: () => load.target,
							expectedTarget: path,
							targetsEqual: (actual, expected) => actual === expected,
							timeoutMs: 1000,
						});
						const outcome = await waiter.result;
						if (outcome.kind === 'failed') {
							discardHucodeFailedRegularWindowTarget({
								isDestroyed: () => false,
								destroy: () => destroyCalls++,
							});
							return { kind: 'failed', error: outcome };
						}
						return {
							kind: 'committed',
							windowId: 7,
							value: path,
							filesDelivered: false,
						};
					}),
				});

			const alpha = open('/alpha', -1);
			const bravo = open('/bravo', -2);
			await alphaStarted;
			assert.deepStrictEqual(starts, ['/alpha']);
			for (const path of ['/alpha', '/bravo']) {
				const ownership = coordinator.lookup(path);
				assert.strictEqual(
					ownership.kind === 'current-owner' && ownership.ownership.phase,
					'reserved'
				);
			}

			load.target = '/alpha';
			ready.fire();
			assert.strictEqual((await alpha).kind, 'opened');
			await bravoStarted;
			assert.deepStrictEqual(starts, ['/alpha', '/bravo']);
			assert.strictEqual(
				coordinator.lookup('/alpha').kind,
				'current-owner'
			);
			const pendingBravo = coordinator.lookup('/bravo');
			assert.strictEqual(
				pendingBravo.kind === 'current-owner' &&
				pendingBravo.ownership.phase,
				'reserved'
			);

			load.target = '/bravo';
			coordinator.reconcile(
				owner => owner.kind === 'regular' && owner.windowId === 7,
				[{ path: '/bravo', owner: regular(7) }]
			);
			ready.fire();
			assert.strictEqual((await bravo).kind, 'opened');
			assert.deepStrictEqual(coordinator.lookup('/alpha'), {
				kind: 'absent',
			});
			const currentBravo = coordinator.lookup('/bravo');
			assert.deepStrictEqual(
				currentBravo.kind === 'current-owner' &&
				currentBravo.ownership.owner,
				regular(7)
			);
			assert.strictEqual(destroyCalls, 0);
			ready.dispose();
			closed.dispose();
			destroyed.dispose();
		}
	);

	test('serializes an ordinary repurpose behind a sensitive target commit',
		async () => {
			const loads = new HucodeRegularWindowLoadCoordinator();
			const ready = new Emitter<void>();
			const closed = new Emitter<void>();
			const destroyed = new Emitter<void>();
			const load = { target: undefined as string | undefined };
			let destroyCalls = 0;
			let sensitiveStarted!: () => void;
			const started = new Promise<void>(resolve => sensitiveStarted = resolve);
			let ordinaryStarted = false;
			const sensitive = loads.run(7, async () => {
				const waiter = waitForHucodeRegularWindowTargetCommit({
					onDidSignalReady: ready.event,
					onDidClose: closed.event,
					onDidDestroy: destroyed.event,
					getTarget: () => load.target,
					expectedTarget: '/sensitive',
					targetsEqual: (actual, expected) => actual === expected,
					timeoutMs: 1000,
				});
				sensitiveStarted();
				const outcome = await waiter.result;
				if (outcome.kind === 'failed') {
					discardHucodeFailedRegularWindowTarget({
						isDestroyed: () => false,
						destroy: () => destroyCalls++,
					});
				}
				return outcome;
			});
			await started;

			const ordinary = loads.run(7, async () => {
				ordinaryStarted = true;
				load.target = '/ordinary';
				ready.fire();
			});
			await Promise.resolve();
			assert.strictEqual(ordinaryStarted, false);

			load.target = '/sensitive';
			ready.fire();
			assert.deepStrictEqual(await sensitive, { kind: 'committed' });
			await ordinary;
			assert.strictEqual(ordinaryStarted, true);
			assert.strictEqual(load.target, '/ordinary');
			assert.strictEqual(destroyCalls, 0);
			ready.dispose();
			closed.dispose();
			destroyed.dispose();
		}
	);

	test('holds an ordinary load through readiness before a sensitive commit',
		async () => {
			const loads = new HucodeRegularWindowLoadCoordinator();
			const ready = new Emitter<void>();
			const closed = new Emitter<void>();
			const destroyed = new Emitter<void>();
			const load = { target: undefined as string | undefined };
			let ordinaryStarted!: () => void;
			const ordinaryDidStart = new Promise<void>(
				resolve => ordinaryStarted = resolve
			);
			let startSensitive!: () => void;
			const sensitiveDidStart = new Promise<void>(
				resolve => startSensitive = resolve
			);
			const ordinary = loads.run(7, async () => {
				const waiter = waitForHucodeRegularWindowLoadCommit({
					onDidSignalReady: ready.event,
					onDidClose: closed.event,
					onDidDestroy: destroyed.event,
				});
				ordinaryStarted();
				return waiter.result;
			});
			await ordinaryDidStart;

			const sensitive = loads.run(7, async () => {
				startSensitive();
				const waiter = waitForHucodeRegularWindowTargetCommit({
					onDidSignalReady: ready.event,
					onDidClose: closed.event,
					onDidDestroy: destroyed.event,
					getTarget: () => load.target,
					expectedTarget: '/sensitive',
					targetsEqual: (actual, expected) => actual === expected,
					timeoutMs: 1000,
				});
				return waiter.result;
			});
			await Promise.resolve();
			let sensitiveStarted = false;
			void sensitiveDidStart.then(() => sensitiveStarted = true);
			await Promise.resolve();
			assert.strictEqual(sensitiveStarted, false);

			load.target = '/ordinary';
			ready.fire();
			assert.deepStrictEqual(await ordinary, { kind: 'committed' });
			await sensitiveDidStart;
			load.target = '/sensitive';
			ready.fire();
			assert.deepStrictEqual(await sensitive, { kind: 'committed' });
			ready.dispose();
			closed.dispose();
			destroyed.dispose();
		}
	);

	for (const reason of ['closed', 'destroyed'] as const) {
		test(`ordinary load has no deadline and settles when ${reason}`,
			async () => {
				const ready = new Emitter<void>();
				const closed = new Emitter<void>();
				const destroyed = new Emitter<void>();
				const waiter = waitForHucodeRegularWindowLoadCommit({
					onDidSignalReady: ready.event,
					onDidClose: closed.event,
					onDidDestroy: destroyed.event,
				});
				const pending = await Promise.race([
					waiter.result,
					new Promise<'pending'>(resolve =>
						setTimeout(() => resolve('pending'), 5)
					),
				]);
				assert.strictEqual(pending, 'pending');

				if (reason === 'closed') {
					closed.fire();
				} else {
					destroyed.fire();
				}
				assert.deepStrictEqual(await waiter.result, {
					kind: 'failed',
					reason,
				});
				waiter.dispose();
				ready.dispose();
				closed.dispose();
				destroyed.dispose();
			}
		);
	}

	for (const scenario of [
		{ reason: 'closed' as const, fire: 'close' as const },
		{ reason: 'destroyed' as const, fire: 'destroy' as const },
		{ reason: 'wrong-target' as const, fire: 'ready' as const },
	] as const) {
		test(`rejects a regular load that is ${scenario.reason}`, async () => {
			const ready = new Emitter<void>();
			const closed = new Emitter<void>();
			const destroyed = new Emitter<void>();
			const waiter = waitForHucodeRegularWindowTargetCommit({
				onDidSignalReady: ready.event,
				onDidClose: closed.event,
				onDidDestroy: destroyed.event,
				getTarget: () => '/wrong',
				expectedTarget: '/repo',
				targetsEqual: (actual, expected) => actual === expected,
				timeoutMs: 1000,
			});
			if (scenario.fire === 'close') {
				closed.fire();
			} else if (scenario.fire === 'destroy') {
				destroyed.fire();
			} else {
				ready.fire();
			}
			assert.deepStrictEqual(await waiter.result, {
				kind: 'failed',
				reason: scenario.reason,
			});
			ready.dispose();
			closed.dispose();
			destroyed.dispose();
		});
	}

	test('times out a regular load without committing ownership', async () => {
		const ready = new Emitter<void>();
		const closed = new Emitter<void>();
		const destroyed = new Emitter<void>();
		const waiter = waitForHucodeRegularWindowTargetCommit({
			onDidSignalReady: ready.event,
			onDidClose: closed.event,
			onDidDestroy: destroyed.event,
			getTarget: () => '/repo',
			expectedTarget: '/repo',
			targetsEqual: (actual, expected) => actual === expected,
			timeoutMs: 0,
		});
		assert.deepStrictEqual(await waiter.result, {
			kind: 'failed',
			reason: 'timeout',
		});
		let targetDestroyed = false;
		discardHucodeFailedRegularWindowTarget({
			isDestroyed: () => targetDestroyed,
			destroy: () => targetDestroyed = true,
		});
		ready.fire();
		assert.strictEqual(targetDestroyed, true);
		ready.dispose();
		closed.dispose();
		destroyed.dispose();
	});

	test('discards only failed regular targets that can load without ownership', () => {
		for (const scenario of [
			{ reason: 'closed', expected: false },
			{ reason: 'destroyed', expected: false },
			{ reason: 'wrong-target', expected: true },
			{ reason: 'timeout', expected: true },
		] as const) {
			assert.strictEqual(shouldDiscardHucodeFailedRegularWindowTarget({
				kind: 'failed',
				reason: scenario.reason,
			}), scenario.expected, scenario.reason);
		}
	});

	test('discards generic open failures but leaves lifecycle cleanup to CodeWindow', () => {
		assert.strictEqual(
			shouldDiscardHucodeRegularWindowAfterOpenFailure(undefined),
			true
		);
		for (const reason of ['closed', 'destroyed'] as const) {
			assert.strictEqual(shouldDiscardHucodeRegularWindowAfterOpenFailure({
				kind: 'failed',
				reason,
			}), false, reason);
		}
	});

	test('queued load rejects a logically removed but physically live window', async () => {
		const loads = new HucodeRegularWindowLoadCoordinator();
		const oldWindow = {};
		let registeredWindow: typeof oldWindow | undefined = oldWindow;
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>(resolve => markFirstStarted = resolve);
		let releaseFirst!: () => void;
		const first = loads.run(1, async () => {
			markFirstStarted();
			await new Promise<void>(resolve => releaseFirst = resolve);
		});
		await firstStarted;
		const second = loads.run(1, () => Promise.resolve(
			isHucodeRegularWindowAvailableForQueuedLoad({
				window: oldWindow,
				registeredWindow,
				nativeWindow: { isDestroyed: () => false },
			})
		));
		registeredWindow = undefined;
		releaseFirst();
		await first;
		assert.strictEqual(await second, false);
	});

	test('admission payload disposition controls the outer file fallback', () => {
		for (const kind of ['folder', 'workspace'] as const) {
			const payload = {
				kind,
				filesToWait: {
					paths: ['/repo/file.txt'],
					waitMarkerFileUri: '/tmp/wait-marker',
				},
			};
			assert.strictEqual(retainHucodeNativeOpenPayloadAfterAdmission(
				payload,
				{ kind: 'vetoed', payloadDisposition: 'consumed' }
			), undefined);
			assert.strictEqual(retainHucodeNativeOpenPayloadAfterAdmission(
				payload,
				{ kind: 'superseded', payloadDisposition: 'delivered' }
			), undefined);
			assert.strictEqual(retainHucodeNativeOpenPayloadAfterAdmission(
				payload,
				{ kind: 'superseded', payloadDisposition: 'consumed' }
			), undefined);
			assert.strictEqual(retainHucodeNativeOpenPayloadAfterAdmission(
				payload,
				{ kind: 'failed', payloadDisposition: 'preserve' }
			), payload);
			assert.strictEqual(
				shouldSettleHucodeNativeOpenWaitMarkerAfterAdmission(
					true,
					{ kind: 'vetoed', payloadDisposition: 'consumed' }
				),
				true
			);
			assert.strictEqual(
				shouldSettleHucodeNativeOpenWaitMarkerAfterAdmission(
					false,
					{ kind: 'vetoed', payloadDisposition: 'consumed' }
				),
				false
			);
			assert.strictEqual(
				shouldSettleHucodeNativeOpenWaitMarkerAfterAdmission(
					true,
					{
						kind: 'focused-hosted',
						value: 'window',
						filesDelivered: true,
						payloadDisposition: 'delivered',
					}
				),
				false
			);
		}
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

	test('missing hosted instance validation preserves a replacement generation',
		() => {
			const coordinator = createCoordinator();
			const original = coordinator.seed({
				path: '/repo',
				owner: hosted(1, 'missing-instance'),
			});
			if (original.kind === 'conflict') {
				assert.fail('expected the original hosted owner');
			}
			coordinator.release(original.token);
			const replacement = coordinator.seed({
				path: '/repo',
				owner: hosted(1, 'replacement-instance'),
			});
			if (replacement.kind === 'conflict') {
				assert.fail('expected the replacement hosted owner');
			}

			assert.strictEqual(validateHucodeDesktopHostedOwnership(
				coordinator,
				original.ownership,
				[]
			), undefined);
			const current = coordinator.lookup('/repo');
			assert.deepStrictEqual(
				current.kind === 'current-owner' && current.ownership.owner,
				hosted(1, 'replacement-instance')
			);
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
			recoverHostedOwner: async () => {
				assert.fail('must not recover a successful transfer');
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
			recoverHostedOwner: async () => {
				assert.fail('must not recover before hosted close');
			},
		});

		assert.deepStrictEqual(result, { kind: 'vetoed' });
		const current = coordinator.lookup('/repo');
		assert.strictEqual(
			current.kind === 'current-owner' && current.ownership.phase,
			'live'
		);
	});

	test('close veto preserves a same-generation recovering owner', async () => {
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
				coordinator.markRecovering(seeded.token);
				return false;
			},
			openRegularWindow: async () => {
				assert.fail('must not open while recovery is pending');
			},
			recoverHostedOwner: async () => {
				assert.fail('existing recovery retains ownership');
			},
		});

		assert.deepStrictEqual(result, { kind: 'superseded' });
		const current = coordinator.lookup('/repo');
		assert.strictEqual(
			current.kind === 'current-owner' && current.ownership.phase,
			'recovering'
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
					recoverHostedOwner: async () => {
						const restored = coordinator.seed({
							path: '/repo',
							owner: hosted(1, 'recovered'),
						});
						assert.notStrictEqual(restored.kind, 'conflict');
						if (restored.kind === 'conflict') {
							return { kind: 'failed' };
						}
						return {
							kind: 'restored',
							ownership: restored.ownership,
						};
					},
				});

			assert.strictEqual(result.kind, 'failed');
			assert.strictEqual(
				result.kind === 'failed' && result.error,
				failure
			);
			assert.strictEqual(
				result.kind === 'failed' && result.recovery?.kind,
				'restored'
			);
			const current = coordinator.lookup('/repo');
			assert.deepStrictEqual(
				current.kind === 'current-owner' && current.ownership.owner,
				hosted(1, 'recovered')
			);
		}
	);

	test('a superseded close veto cannot disturb replacement ownership',
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
					return false;
				},
				openRegularWindow: async () => 7,
				recoverHostedOwner: async () => {
					assert.fail('must not recover after another owner wins');
				},
			});

			assert.deepStrictEqual(result, { kind: 'superseded' });
			const current = coordinator.lookup('/repo');
			assert.deepStrictEqual(
				current.kind === 'current-owner' && current.ownership.owner,
				hosted(2, 'bravo')
			);
		}
	);

	test('a superseded thrown close cannot disturb replacement ownership',
		async () => {
			const coordinator = createCoordinator();
			const seeded = coordinator.seed({
				path: '/repo',
				owner: hosted(1, 'alpha'),
			});
			if (seeded.kind === 'conflict') {
				assert.fail('expected hosted ownership');
			}
			const closeFailure = new Error('close failed after replacement');

			const result = await transferHucodeDesktopWorkbenchToRegularWindow({
				coordinator,
				ownership: seeded.ownership,
				closeHostedOwner: async () => {
					coordinator.release(seeded.token);
					coordinator.seed({
						path: '/repo',
						owner: hosted(2, 'bravo'),
					});
					throw closeFailure;
				},
				openRegularWindow: async () => {
					assert.fail('must not open after superseded close');
				},
				recoverHostedOwner: async () => {
					assert.fail('must not recover after replacement wins');
				},
			});

			assert.deepStrictEqual(result, { kind: 'superseded' });
			const current = coordinator.lookup('/repo');
			assert.deepStrictEqual(
				current.kind === 'current-owner' && current.ownership.owner,
				hosted(2, 'bravo')
			);
		}
	);

	test('superseded transfer retries and delivers payload to replacement',
		async () => {
			const coordinator = createCoordinator();
			const seeded = coordinator.seed({
				path: '/repo',
				owner: hosted(1, 'alpha'),
			});
			if (seeded.kind === 'conflict') {
				assert.fail('expected hosted ownership');
			}
			let resolutions = 0;
			const payload = {
				filesToWait: {
					paths: ['/repo/file.txt'],
					waitMarkerFileUri: '/tmp/wait-marker',
				},
			};
			const result = await admitHucodeRegularWorkbench({
				coordinator,
				path: '/repo',
				pendingOwner: regular(-1),
				resolveCurrent: async ownership => {
					resolutions++;
					if (resolutions === 1) {
						const transfer =
							await transferHucodeDesktopWorkbenchToRegularWindow({
								coordinator,
								ownership,
								closeHostedOwner: async () => {
									coordinator.release(seeded.token);
									coordinator.seed({
										path: '/repo',
										owner: hosted(2, 'replacement'),
									});
									return false;
								},
								openRegularWindow: async () => {
									assert.fail('must not open after superseded close');
								},
								recoverHostedOwner: async () => {
									assert.fail('replacement already owns the path');
								},
							});
						assert.strictEqual(transfer.kind, 'superseded');
						return { kind: 'retry' };
					}
					assert.deepStrictEqual(
						ownership.owner,
						hosted(2, 'replacement')
					);
					return {
						kind: 'focused-hosted',
						value: 'replacement-window',
						filesDelivered: true,
						payloadDisposition: 'delivered',
					};
				},
				openRegularWindow: async () => {
					assert.fail('replacement must receive the request');
				},
			});

			assert.deepStrictEqual(result, {
				kind: 'focused-hosted',
				value: 'replacement-window',
				filesDelivered: true,
				payloadDisposition: 'delivered',
			});
			assert.strictEqual(resolutions, 2);
			assert.strictEqual(retainHucodeNativeOpenPayloadAfterAdmission(
				payload,
				result
			), undefined);
		}
	);

	test('failed transfer recovery cannot displace another owner', async () => {
		const coordinator = createCoordinator();
		const seeded = coordinator.seed({
			path: '/repo',
			owner: hosted(1, 'alpha'),
		});
		if (seeded.kind === 'conflict') {
			assert.fail('expected hosted ownership');
		}
		const failure = new Error('regular open failed');
		const result = await transferHucodeDesktopWorkbenchToRegularWindow({
			coordinator,
			ownership: seeded.ownership,
			closeHostedOwner: async () => {
				coordinator.release(seeded.token);
				return true;
			},
			openRegularWindow: async () => { throw failure; },
			recoverHostedOwner: async () => {
				const replacement = coordinator.seed({
					path: '/repo',
					owner: hosted(2, 'replacement'),
				});
				assert.notStrictEqual(replacement.kind, 'conflict');
				if (replacement.kind === 'conflict') {
					return { kind: 'failed' };
				}
				return {
					kind: 'restored',
					ownership: seeded.ownership,
				};
			},
		});

		assert.strictEqual(
			result.kind === 'failed' && result.recovery?.kind,
			'superseded'
		);
		const current = coordinator.lookup('/repo');
		assert.deepStrictEqual(
			current.kind === 'current-owner' && current.ownership.owner,
			hosted(2, 'replacement')
		);
	});

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
