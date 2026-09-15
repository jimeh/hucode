/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync } from 'fs';
import { Event } from '../../base/common/event.js';
import {
	DisposableMap,
	DisposableStore,
	type IDisposable,
} from '../../base/common/lifecycle.js';
import { normalize, resolve } from '../../base/common/path.js';
import { isLinux } from '../../base/common/platform.js';
import { getProjectManagerPathComparisonKey } from
	'../../platform/projectManager/common/projectManagerState.js';
import {
	isHostedWorkspaceOwnershipRetained,
	type IHostedWorkspaceStateEntry,
} from '../common/hostedWorkspaceState.js';
import { IHucodeDesktopWorkbenchOwnershipState } from
	'../common/omniWindow.js';

export type HucodeDesktopWorkbenchOwner =
	| {
		readonly kind: 'regular';
		readonly windowId: number;
	}
	| {
		readonly kind: 'hosted';
		readonly windowId: number;
		readonly instanceId: string;
	};

export type HucodeDesktopWorkbenchOwnershipPhase =
	'reserved' | 'live' | 'recovering' | 'transferring';

export interface IHucodeDesktopWorkbenchOwnership {
	readonly canonicalPath: string;
	readonly displayPath: string;
	readonly owner: HucodeDesktopWorkbenchOwner;
	readonly generation: number;
	readonly phase: HucodeDesktopWorkbenchOwnershipPhase;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface IHucodeDesktopWorkbenchOwnershipToken {
	readonly canonicalPath: string;
	readonly owner: HucodeDesktopWorkbenchOwner;
	readonly generation: number;
}

export type HucodeDesktopWorkbenchOwnershipLookup =
	| { readonly kind: 'absent' }
	| {
		readonly kind: 'current-owner';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	};

export type HucodeDesktopWorkbenchOwnershipSettlement =
	| {
		readonly kind: 'published';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	}
	| {
		readonly kind: 'recovering';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
		readonly settled: Promise<HucodeDesktopWorkbenchOwnershipSettlement>;
	}
	| { readonly kind: 'released' };

export type HucodeDesktopWorkbenchReservationOutcome =
	| {
		readonly kind: 'reserved';
		readonly reservation: IHucodeDesktopWorkbenchOwnershipToken;
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	}
	| {
		readonly kind: 'current-owner';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	}
	| {
		readonly kind: 'reserved-conflict';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
		readonly settled: Promise<HucodeDesktopWorkbenchOwnershipSettlement>;
	};

export type HucodeDesktopWorkbenchPublishOutcome =
	| {
		readonly kind: 'published';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	}
	| {
		readonly kind: 'stale';
		readonly ownership?: IHucodeDesktopWorkbenchOwnership;
	};

export type HucodeDesktopWorkbenchReassignOutcome =
	| {
		readonly kind: 'reassigned';
		readonly reservation: IHucodeDesktopWorkbenchOwnershipToken;
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	}
	| {
		readonly kind: 'stale';
		readonly ownership?: IHucodeDesktopWorkbenchOwnership;
	};

export type HucodeDesktopWorkbenchReleaseOutcome =
	| { readonly kind: 'released' }
	| {
		readonly kind: 'stale';
		readonly ownership?: IHucodeDesktopWorkbenchOwnership;
	};

export type HucodeDesktopWorkbenchSeedOutcome =
	| {
		readonly kind: 'published';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
		readonly token: IHucodeDesktopWorkbenchOwnershipToken;
	}
	| {
		readonly kind: 'current-owner';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
		readonly token: IHucodeDesktopWorkbenchOwnershipToken;
	}
	| {
		readonly kind: 'conflict';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	};

export interface IHucodeDesktopWorkbenchOwnershipClaim {
	readonly path: string;
	readonly owner: HucodeDesktopWorkbenchOwner;
	readonly phase?: Exclude<
		HucodeDesktopWorkbenchOwnershipPhase,
		'reserved' | 'transferring'
	>;
}

interface ISettlement {
	readonly promise: Promise<HucodeDesktopWorkbenchOwnershipSettlement>;
	readonly resolve: (
		outcome: HucodeDesktopWorkbenchOwnershipSettlement
	) => void;
}

interface IInternalOwnershipRecord {
	ownership: IHucodeDesktopWorkbenchOwnership;
	settlement?: ISettlement;
}

export interface IHucodeDesktopWorkbenchOwnershipCoordinatorOptions {
	readonly canonicalizePath?: (path: string) => string;
	readonly isCaseSensitive?: boolean;
	readonly now?: () => number;
	readonly onDidChange?: () => void;
}

export interface IHucodeDesktopWorkbenchReservationOptions {
	/** Route a recovering owner instead of waiting for recovery to settle. */
	readonly routeRecoveringOwner?: boolean;
}

/** Persisted restore claim used for cross-window startup arbitration. */
export interface IHucodeDesktopRestoreCandidate {
	readonly path: string;
	readonly windowId: number;
	readonly windowLastFocusTime: number;
	readonly stableInstanceId: string;
	readonly persistedActive: boolean;
	readonly lastActiveAt?: number;
}

/** Persisted state from one Omni window used to build restore claims. */
export interface IHucodeDesktopRestoreWindowSource {
	readonly windowId: number;
	readonly windowLastFocusTime: number;
	readonly activeWorktreePath?: string;
	readonly residentWorkspaces: readonly {
		readonly path: string;
		readonly projectId?: string;
		readonly lastActiveAt?: number;
	}[];
	readonly retainedWorkbenches: readonly {
		readonly path: string;
		readonly id: string;
		readonly desiredState: 'loaded' | 'unloaded';
		readonly lastActiveAt?: number;
	}[];
}

/** Result of an explicit hosted-to-regular ownership transfer. */
export type HucodeDesktopWorkbenchTransferOutcome =
	| {
		readonly kind: 'transferred';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	}
	| { readonly kind: 'vetoed' }
	| { readonly kind: 'superseded' }
	| {
		readonly kind: 'failed';
		readonly error?: unknown;
		readonly recovery?: HucodeDesktopWorkbenchTransferRecoveryOutcome;
	};

export type HucodeDesktopWorkbenchTransferRecoveryOutcome =
	| {
		readonly kind: 'restored';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	}
	| {
		readonly kind: 'superseded';
		readonly ownership?: IHucodeDesktopWorkbenchOwnership;
	}
	| { readonly kind: 'failed'; readonly error?: unknown };

/** Typed result from the main-process desktop focus-or-open router. */
export type HucodeDesktopWorkbenchRouteOutcome =
	| {
		readonly kind: 'focused-hosted' | 'opened-hosted';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	}
	| {
		readonly kind: 'focused-regular';
		readonly ownership: IHucodeDesktopWorkbenchOwnership;
	}
	| { readonly kind: 'superseded' }
	| { readonly kind: 'failed'; readonly error?: unknown };

export interface IHucodeDesktopWorkbenchTransferDelegate {
	readonly coordinator: HucodeDesktopWorkbenchOwnershipCoordinator;
	readonly ownership: IHucodeDesktopWorkbenchOwnership;
	closeHostedOwner(): Promise<boolean>;
	openRegularWindow(): Promise<number>;
	recoverHostedOwner(): Promise<
		HucodeDesktopWorkbenchTransferRecoveryOutcome
	>;
}

export type HucodeNativeOpenPayloadDisposition =
	'delivered' | 'consumed' | 'preserve';

export function shouldAwaitHucodeRegularWindowLoadCommit(
	ownershipAlreadyReserved?: boolean,
	explicitlyRequested?: boolean
): boolean {
	return ownershipAlreadyReserved === true || explicitlyRequested === true;
}

/** Serializes ownership-sensitive loads that selected the same native window. */
export class HucodeRegularWindowLoadCoordinator {
	private readonly tails = new Map<number, Promise<void>>();

	async run<T>(windowId: number, operation: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(windowId) ?? Promise.resolve();
		let release!: () => void;
		const turn = new Promise<void>(resolve => release = resolve);
		const tail = previous.catch(() => undefined).then(() => turn);
		this.tails.set(windowId, tail);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
			if (this.tails.get(windowId) === tail) {
				this.tails.delete(windowId);
			}
		}
	}
}

export interface IHucodeRegularOwnershipWindow {
	readonly id: number;
	readonly isOmniWindow?: boolean;
	readonly onDidClose: Event<void>;
	readonly onDidDestroy: Event<void>;
}

/** Releases regular ownership when its native window closes or is destroyed. */
export class HucodeRegularWindowOwnershipLifetimes implements IDisposable {
	private readonly windows = new DisposableMap<number>();

	constructor(
		private readonly coordinator:
			HucodeDesktopWorkbenchOwnershipCoordinator
	) { }

	add(window: IHucodeRegularOwnershipWindow): void {
		if (window.isOmniWindow || this.windows.has(window.id)) {
			return;
		}

		const lifecycle = new DisposableStore();
		lifecycle.add(Event.any(
			window.onDidClose,
			window.onDidDestroy
		)(() => {
			this.coordinator.releaseOwners(owner =>
				owner.kind === 'regular' && owner.windowId === window.id
			);
			this.windows.deleteAndLeak(window.id)?.dispose();
		}));
		this.windows.set(window.id, lifecycle);
	}

	dispose(): void {
		this.windows.dispose();
	}
}

export type HucodeRegularWorkbenchOpenAttempt<T> =
	| {
		readonly kind: 'committed';
		readonly windowId: number;
		readonly value: T;
		readonly filesDelivered: boolean;
	}
	| { readonly kind: 'vetoed' }
	| { readonly kind: 'failed'; readonly error?: unknown };

export type HucodeRegularWorkbenchAdmissionOutcome<T> =
	| {
		readonly kind: 'opened' | 'focused-regular' | 'focused-hosted';
		readonly value: T;
		readonly filesDelivered: boolean;
		readonly payloadDisposition: HucodeNativeOpenPayloadDisposition;
	}
	| {
		readonly kind: 'vetoed' | 'superseded';
		readonly payloadDisposition: HucodeNativeOpenPayloadDisposition;
	}
	| {
		readonly kind: 'failed';
		readonly error?: unknown;
		readonly payloadDisposition: HucodeNativeOpenPayloadDisposition;
	};

export function retainHucodeNativeOpenPayloadAfterAdmission<T>(
	payload: T | undefined,
	outcome: HucodeRegularWorkbenchAdmissionOutcome<unknown>
): T | undefined {
	return outcome.payloadDisposition === 'preserve' ? payload : undefined;
}

export function shouldSettleHucodeNativeOpenWaitMarkerAfterAdmission(
	hasNativeOpenPayload: boolean,
	outcome: HucodeRegularWorkbenchAdmissionOutcome<unknown>
): boolean {
	return hasNativeOpenPayload &&
		outcome.payloadDisposition === 'consumed' &&
		(outcome.kind === 'vetoed' || outcome.kind === 'superseded');
}

export type HucodeRegularWindowTargetCommitOutcome =
	| { readonly kind: 'committed' }
	| {
		readonly kind: 'failed';
		readonly reason: 'closed' | 'destroyed' | 'wrong-target' | 'timeout';
	};

export interface IHucodeRegularWindowTargetCommitWaiter {
	readonly result: Promise<HucodeRegularWindowTargetCommitOutcome>;
	dispose(): void;
}

/** Waits for one native window load to signal renderer readiness. */
export function waitForHucodeRegularWindowLoadCommit(options: {
	readonly onDidSignalReady: Event<void>;
	readonly onDidClose: Event<void>;
	readonly onDidDestroy: Event<void>;
}): IHucodeRegularWindowTargetCommitWaiter {
	const disposables = new DisposableStore();
	let settled = false;
	let complete!: (outcome: HucodeRegularWindowTargetCommitOutcome) => void;
	const result = new Promise<HucodeRegularWindowTargetCommitOutcome>(resolve => {
		complete = resolve;
	});
	const finish = (outcome: HucodeRegularWindowTargetCommitOutcome) => {
		if (settled) {
			return;
		}
		settled = true;
		disposables.dispose();
		complete(outcome);
	};
	disposables.add(Event.once(options.onDidSignalReady)(() =>
		finish({ kind: 'committed' })));
	disposables.add(Event.once(options.onDidClose)(() =>
		finish({ kind: 'failed', reason: 'closed' })));
	disposables.add(Event.once(options.onDidDestroy)(() =>
		finish({ kind: 'failed', reason: 'destroyed' })));
	return {
		result,
		dispose: () => disposables.dispose(),
	};
}

export function discardHucodeFailedRegularWindowTarget(
	target: {
		isDestroyed(): boolean;
		destroy(): void;
	} | null | undefined
): void {
	if (target && !target.isDestroyed()) {
		target.destroy();
	}
}

export function shouldDiscardHucodeFailedRegularWindowTarget(
	outcome: Extract<
		HucodeRegularWindowTargetCommitOutcome,
		{ readonly kind: 'failed' }
	>
): boolean {
	return outcome.reason === 'timeout' || outcome.reason === 'wrong-target';
}

export function shouldDiscardHucodeRegularWindowAfterOpenFailure(
	outcome: Extract<
		HucodeRegularWindowTargetCommitOutcome,
		{ readonly kind: 'failed' }
	> | undefined
): boolean {
	return !outcome || shouldDiscardHucodeFailedRegularWindowTarget(outcome);
}

export function isHucodeRegularWindowAvailableForQueuedLoad<T>(options: {
	readonly window: T;
	readonly registeredWindow: T | undefined;
	readonly nativeWindow: { isDestroyed(): boolean } | null | undefined;
}): boolean {
	return options.registeredWindow === options.window &&
		!!options.nativeWindow &&
		!options.nativeWindow.isDestroyed();
}

/** Waits for renderer readiness, then verifies the window committed its target. */
export function waitForHucodeRegularWindowTargetCommit<T>(options: {
	readonly onDidSignalReady: Event<void>;
	readonly onDidClose: Event<void>;
	readonly onDidDestroy: Event<void>;
	readonly getTarget: () => T | undefined;
	readonly expectedTarget: T;
	readonly targetsEqual: (actual: T, expected: T) => boolean;
	readonly timeoutMs: number;
}): IHucodeRegularWindowTargetCommitWaiter {
	const disposables = new DisposableStore();
	let settled = false;
	let complete!: (outcome: HucodeRegularWindowTargetCommitOutcome) => void;
	const result = new Promise<HucodeRegularWindowTargetCommitOutcome>(resolve => {
		complete = resolve;
	});
	const finish = (outcome: HucodeRegularWindowTargetCommitOutcome) => {
		if (settled) {
			return;
		}
		settled = true;
		disposables.dispose();
		complete(outcome);
	};
	disposables.add(Event.once(options.onDidSignalReady)(() => {
		const actual = options.getTarget();
		finish(actual && options.targetsEqual(actual, options.expectedTarget)
			? { kind: 'committed' }
			: { kind: 'failed', reason: 'wrong-target' });
	}));
	disposables.add(Event.once(options.onDidClose)(() =>
		finish({ kind: 'failed', reason: 'closed' })));
	disposables.add(Event.once(options.onDidDestroy)(() =>
		finish({ kind: 'failed', reason: 'destroyed' })));
	const timeoutHandle = setTimeout(() =>
		finish({ kind: 'failed', reason: 'timeout' }), options.timeoutMs);
	disposables.add({ dispose: () => clearTimeout(timeoutHandle) });
	return {
		result,
		dispose: () => disposables.dispose(),
	};
}

export interface IHucodeRegularWorkbenchAdmissionDelegate<T> {
	readonly coordinator: HucodeDesktopWorkbenchOwnershipCoordinator;
	readonly path: string;
	readonly pendingOwner: Extract<
		HucodeDesktopWorkbenchOwner,
		{ readonly kind: 'regular' }
	>;
	resolveCurrent(
		ownership: IHucodeDesktopWorkbenchOwnership
	): Promise<
		| HucodeRegularWorkbenchAdmissionOutcome<T>
		| { readonly kind: 'stale' }
		| { readonly kind: 'retry' }
	>;
	openRegularWindow(): Promise<HucodeRegularWorkbenchOpenAttempt<T>>;
}

/** Keeps a regular admission reserved until the target has actually loaded. */
export async function admitHucodeRegularWorkbench<T>(
	delegate: IHucodeRegularWorkbenchAdmissionDelegate<T>
): Promise<HucodeRegularWorkbenchAdmissionOutcome<T>> {
	while (true) {
		const admission = delegate.coordinator.reserve(
			delegate.path,
			delegate.pendingOwner,
			{ routeRecoveringOwner: true }
		);
		if (admission.kind === 'reserved-conflict') {
			await admission.settled;
			continue;
		}
		if (admission.kind === 'current-owner') {
			const resolved = await delegate.resolveCurrent(admission.ownership);
			if (resolved.kind === 'retry') {
				continue;
			}
			if (resolved.kind === 'stale') {
				delegate.coordinator.release({
					canonicalPath: admission.ownership.canonicalPath,
					owner: admission.ownership.owner,
					generation: admission.ownership.generation,
				});
				continue;
			}
			return resolved;
		}

		let opened: HucodeRegularWorkbenchOpenAttempt<T>;
		try {
			opened = await delegate.openRegularWindow();
		} catch (error) {
			delegate.coordinator.release(admission.reservation);
			return {
				kind: 'failed',
				error,
				payloadDisposition: 'preserve',
			};
		}
		if (opened.kind !== 'committed') {
			delegate.coordinator.release(admission.reservation);
			return opened.kind === 'vetoed'
				? { kind: 'vetoed', payloadDisposition: 'consumed' }
				: {
					kind: 'failed',
					error: opened.error,
					payloadDisposition: 'preserve',
				};
		}
		const reassigned = delegate.coordinator.reassign(
			admission.reservation,
			{ kind: 'regular', windowId: opened.windowId }
		);
		if (reassigned.kind !== 'reassigned') {
			return {
				kind: 'superseded',
				payloadDisposition: opened.filesDelivered
					? 'delivered'
					: 'consumed',
			};
		}
		const published = delegate.coordinator.publish(reassigned.reservation);
		return published.kind === 'published'
			? {
				kind: 'opened',
				value: opened.value,
				filesDelivered: opened.filesDelivered,
				payloadDisposition: opened.filesDelivered
					? 'delivered'
					: 'preserve',
			}
			: {
				kind: 'superseded',
				payloadDisposition: opened.filesDelivered
					? 'delivered'
					: 'consumed',
			};
	}
}

/**
 * Main-process authority for one live desktop workbench per canonical path.
 * Mutations are synchronous so one JavaScript turn is one atomic admission.
 */
export class HucodeDesktopWorkbenchOwnershipCoordinator {
	private readonly records = new Map<string, IInternalOwnershipRecord>();
	private readonly canonicalizePath: (path: string) => string;
	private readonly isCaseSensitive: boolean;
	private readonly now: () => number;
	private readonly onDidChange: () => void;
	private generation = 0;

	constructor(
		options: IHucodeDesktopWorkbenchOwnershipCoordinatorOptions = {}
	) {
		this.canonicalizePath = options.canonicalizePath ??
			canonicalizeDesktopWorkbenchPath;
		this.isCaseSensitive = options.isCaseSensitive ?? isLinux;
		this.now = options.now ?? Date.now;
		this.onDidChange = options.onDidChange ?? (() => { });
	}

	snapshot(): readonly IHucodeDesktopWorkbenchOwnership[] {
		return Array.from(this.records.values(), record => record.ownership);
	}

	lookup(path: string): HucodeDesktopWorkbenchOwnershipLookup {
		const record = this.records.get(this.toKey(path));
		return record
			? { kind: 'current-owner', ownership: record.ownership }
			: { kind: 'absent' };
	}

	reserve(
		path: string,
		owner: HucodeDesktopWorkbenchOwner,
		options: IHucodeDesktopWorkbenchReservationOptions = {}
	): HucodeDesktopWorkbenchReservationOutcome {
		const canonicalPath = this.canonicalizePath(path);
		const key = this.toCanonicalKey(canonicalPath);
		const existing = this.records.get(key);
		if (existing) {
			if (ownersEqual(existing.ownership.owner, owner)) {
				return {
					kind: 'current-owner',
					ownership: existing.ownership,
				};
			}
			if (existing.settlement &&
				(existing.ownership.phase === 'reserved' ||
					existing.ownership.phase === 'transferring' ||
					(existing.ownership.phase === 'recovering' &&
						!options.routeRecoveringOwner))) {
				return {
					kind: 'reserved-conflict',
					ownership: existing.ownership,
					settled: existing.settlement.promise,
				};
			}
			return {
				kind: 'current-owner',
				ownership: existing.ownership,
			};
		}

		const createdAt = this.now();
		const ownership: IHucodeDesktopWorkbenchOwnership = {
			canonicalPath,
			displayPath: path,
			owner,
			generation: ++this.generation,
			phase: 'reserved',
			createdAt,
			updatedAt: createdAt,
		};
		const settlement = createSettlement();
		this.records.set(key, { ownership, settlement });
		this.onDidChange();
		return {
			kind: 'reserved',
			reservation: toToken(ownership),
			ownership,
		};
	}

	publish(
		token: IHucodeDesktopWorkbenchOwnershipToken,
		phase: 'live' | 'recovering' = 'live'
	): HucodeDesktopWorkbenchPublishOutcome {
		const record = this.getCurrentRecord(token);
		if (!record) {
			return this.staleOutcome(token);
		}

		const previousPhase = record.ownership.phase;
		record.ownership = {
			...record.ownership,
			phase,
			updatedAt: this.now(),
		};
		if (phase === 'live') {
			record.settlement?.resolve({
				kind: 'published',
				ownership: record.ownership,
			});
			record.settlement = undefined;
		} else if (previousPhase !== 'recovering') {
			const recoverySettlement = createSettlement();
			record.settlement?.resolve({
				kind: 'recovering',
				ownership: record.ownership,
				settled: recoverySettlement.promise,
			});
			record.settlement = recoverySettlement;
		} else {
			record.settlement ??= createSettlement();
		}
		this.onDidChange();
		return { kind: 'published', ownership: record.ownership };
	}

	markRecovering(
		token: IHucodeDesktopWorkbenchOwnershipToken
	): HucodeDesktopWorkbenchPublishOutcome {
		return this.publish(token, 'recovering');
	}

	markTransferring(
		token: IHucodeDesktopWorkbenchOwnershipToken
	): HucodeDesktopWorkbenchPublishOutcome {
		const record = this.getCurrentRecord(token);
		if (!record) {
			return this.staleOutcome(token);
		}
		record.ownership = {
			...record.ownership,
			phase: 'transferring',
			updatedAt: this.now(),
		};
		record.settlement ??= createSettlement();
		this.onDidChange();
		return { kind: 'published', ownership: record.ownership };
	}

	reassign(
		token: IHucodeDesktopWorkbenchOwnershipToken,
		owner: HucodeDesktopWorkbenchOwner
	): HucodeDesktopWorkbenchReassignOutcome {
		const record = this.getCurrentRecord(token);
		if (!record) {
			return this.staleOutcome(token);
		}
		record.ownership = {
			...record.ownership,
			owner,
			updatedAt: this.now(),
		};
		this.onDidChange();
		return {
			kind: 'reassigned',
			reservation: toToken(record.ownership),
			ownership: record.ownership,
		};
	}

	release(
		token: IHucodeDesktopWorkbenchOwnershipToken
	): HucodeDesktopWorkbenchReleaseOutcome {
		const record = this.getCurrentRecord(token);
		if (!record) {
			const current = this.records.get(
				this.toCanonicalKey(token.canonicalPath)
			);
			return {
				kind: 'stale',
				ownership: current?.ownership,
			};
		}

		record.settlement?.resolve({ kind: 'released' });
		this.records.delete(this.toCanonicalKey(token.canonicalPath));
		this.onDidChange();
		return { kind: 'released' };
	}

	seed(
		claim: IHucodeDesktopWorkbenchOwnershipClaim
	): HucodeDesktopWorkbenchSeedOutcome {
		const canonicalPath = this.canonicalizePath(claim.path);
		const key = this.toCanonicalKey(canonicalPath);
		const existing = this.records.get(key);
		if (existing) {
			if (!ownersEqual(existing.ownership.owner, claim.owner)) {
				return { kind: 'conflict', ownership: existing.ownership };
			}
			return {
				kind: 'current-owner',
				ownership: existing.ownership,
				token: toToken(existing.ownership),
			};
		}

		const createdAt = this.now();
		const ownership: IHucodeDesktopWorkbenchOwnership = {
			canonicalPath,
			displayPath: claim.path,
			owner: claim.owner,
			generation: ++this.generation,
			phase: claim.phase ?? 'live',
			createdAt,
			updatedAt: createdAt,
		};
		this.records.set(key, {
			ownership,
			settlement: ownership.phase === 'recovering'
				? createSettlement()
				: undefined,
		});
		this.onDidChange();
		return {
			kind: 'published',
			ownership,
			token: toToken(ownership),
		};
	}

	reconcile(
		ownsScope: (owner: HucodeDesktopWorkbenchOwner) => boolean,
		claims: readonly IHucodeDesktopWorkbenchOwnershipClaim[]
	): readonly HucodeDesktopWorkbenchSeedOutcome[] {
		const claimedKeys = new Set(claims.map(claim =>
			this.toKey(claim.path)
		));
		for (const [key, record] of this.records) {
			if (ownsScope(record.ownership.owner) && !claimedKeys.has(key)) {
				record.settlement?.resolve({ kind: 'released' });
				this.records.delete(key);
				this.onDidChange();
			}
		}
		return claims.map(claim => this.seed(claim));
	}

	releaseOwners(
		matches: (owner: HucodeDesktopWorkbenchOwner) => boolean
	): void {
		for (const [key, record] of this.records) {
			if (!matches(record.ownership.owner)) {
				continue;
			}
			record.settlement?.resolve({ kind: 'released' });
			this.records.delete(key);
			this.onDidChange();
		}
	}

	private getCurrentRecord(
		token: IHucodeDesktopWorkbenchOwnershipToken
	): IInternalOwnershipRecord | undefined {
		const record = this.records.get(
			this.toCanonicalKey(token.canonicalPath)
		);
		return record &&
			record.ownership.generation === token.generation &&
			ownersEqual(record.ownership.owner, token.owner)
			? record
			: undefined;
	}

	private staleOutcome(
		token: IHucodeDesktopWorkbenchOwnershipToken
	): Extract<HucodeDesktopWorkbenchPublishOutcome, { kind: 'stale' }> {
		return {
			kind: 'stale',
			ownership: this.records.get(
				this.toCanonicalKey(token.canonicalPath)
			)?.ownership,
		};
	}

	private toKey(path: string): string {
		return this.toCanonicalKey(this.canonicalizePath(path));
	}

	private toCanonicalKey(path: string): string {
		return getProjectManagerPathComparisonKey(
			path,
			this.isCaseSensitive
		);
	}
}

/** Selects one persisted restore winner per canonical desktop path. */
export function selectHucodeDesktopRestoreWinners(
	candidates: readonly IHucodeDesktopRestoreCandidate[],
	options: Pick<IHucodeDesktopWorkbenchOwnershipCoordinatorOptions,
		'canonicalizePath' | 'isCaseSensitive'> = {}
): ReadonlyMap<string, IHucodeDesktopRestoreCandidate> {
	const canonicalizePath = options.canonicalizePath ??
		canonicalizeDesktopWorkbenchPath;
	const isCaseSensitive = options.isCaseSensitive ?? isLinux;
	const winners = new Map<string, IHucodeDesktopRestoreCandidate>();
	for (const candidate of candidates) {
		const key = getProjectManagerPathComparisonKey(
			canonicalizePath(candidate.path),
			isCaseSensitive
		);
		const current = winners.get(key);
		if (!current || compareRestoreCandidates(candidate, current) < 0) {
			winners.set(key, candidate);
		}
	}
	return winners;
}

export function getHucodeProjectRestoreCandidateId(
	projectId: string,
	path: string
): string {
	return `project:${projectId}:${path}`;
}

export function getHucodeRetainedRestoreCandidateId(id: string): string {
	return `retained:${id}`;
}

export function getHucodeLegacyRetainedRestoreCandidateId(
	path: string
): string {
	return `legacy-retained:${getProjectManagerPathComparisonKey(
		canonicalizeDesktopWorkbenchPath(path),
		isLinux
	)}`;
}

/** Builds the restore claims the controller will submit for one Omni window. */
export function createHucodeDesktopRestoreCandidates(
	source: IHucodeDesktopRestoreWindowSource,
	pathsEqual: (left: string, right: string) => boolean =
		(left, right) => left === right
): readonly IHucodeDesktopRestoreCandidate[] {
	const isActive = (path: string) =>
		source.activeWorktreePath !== undefined &&
		pathsEqual(source.activeWorktreePath, path);
	const retainedCandidates = new Map<
		string,
		IHucodeDesktopRestoreCandidate
	>();
	for (const retained of source.retainedWorkbenches) {
		if (retained.desiredState !== 'loaded') {
			continue;
		}
		const stableInstanceId = getHucodeRetainedRestoreCandidateId(
			retained.id
		);
		retainedCandidates.set(stableInstanceId, {
			path: retained.path,
			windowId: source.windowId,
			windowLastFocusTime: source.windowLastFocusTime,
			stableInstanceId,
			persistedActive: isActive(retained.path),
			lastActiveAt: retained.lastActiveAt,
		});
	}

	const projectCandidates: IHucodeDesktopRestoreCandidate[] = [];
	for (const resident of source.residentWorkspaces) {
		if (resident.projectId) {
			projectCandidates.push({
				path: resident.path,
				windowId: source.windowId,
				windowLastFocusTime: source.windowLastFocusTime,
				stableInstanceId: getHucodeProjectRestoreCandidateId(
					resident.projectId,
					resident.path
				),
				persistedActive: isActive(resident.path),
				lastActiveAt: resident.lastActiveAt,
			});
			continue;
		}

		const retained = source.retainedWorkbenches.find(candidate =>
			pathsEqual(candidate.path, resident.path)
		);
		const stableInstanceId = retained
			? getHucodeRetainedRestoreCandidateId(retained.id)
			: getHucodeLegacyRetainedRestoreCandidateId(resident.path);
		const path = retained?.path ?? resident.path;
		retainedCandidates.set(stableInstanceId, {
			path,
			windowId: source.windowId,
			windowLastFocusTime: source.windowLastFocusTime,
			stableInstanceId,
			persistedActive: isActive(path),
			lastActiveAt: resident.lastActiveAt ?? retained?.lastActiveAt,
		});
	}

	return [...projectCandidates, ...retainedCandidates.values()];
}

/** Runs a generation-safe hosted-to-regular ownership transfer. */
export async function transferHucodeDesktopWorkbenchToRegularWindow(
	delegate: IHucodeDesktopWorkbenchTransferDelegate
): Promise<HucodeDesktopWorkbenchTransferOutcome> {
	const { coordinator, ownership } = delegate;
	const token = toToken(ownership);
	if (ownership.owner.kind !== 'hosted' ||
		coordinator.markTransferring(token).kind === 'stale') {
		return { kind: 'superseded' };
	}

	let closed: boolean;
	try {
		closed = await delegate.closeHostedOwner();
	} catch (error) {
		return restoreHucodeTransferringOwner(coordinator, token)
			? { kind: 'failed', error }
			: { kind: 'superseded' };
	}
	if (!closed) {
		return restoreHucodeTransferringOwner(coordinator, token)
			? { kind: 'vetoed' }
			: { kind: 'superseded' };
	}

	const afterClose = coordinator.lookup(ownership.canonicalPath);
	if (afterClose.kind !== 'absent') {
		return { kind: 'superseded' };
	}

	const pendingOwner = { kind: 'regular' as const, windowId: 0 };
	const reserved = coordinator.reserve(ownership.displayPath, pendingOwner);
	if (reserved.kind !== 'reserved') {
		return { kind: 'superseded' };
	}
	try {
		const windowId = await delegate.openRegularWindow();
		const reassigned = coordinator.reassign(
			reserved.reservation,
			{ kind: 'regular', windowId }
		);
		if (reassigned.kind !== 'reassigned') {
			return { kind: 'superseded' };
		}
		const published = coordinator.publish(reassigned.reservation);
		return published.kind === 'published'
			? { kind: 'transferred', ownership: published.ownership }
			: { kind: 'superseded' };
	} catch (error) {
		coordinator.release(reserved.reservation);
		let recovery: HucodeDesktopWorkbenchTransferRecoveryOutcome;
		try {
			recovery = await delegate.recoverHostedOwner();
		} catch (recoveryError) {
			recovery = { kind: 'failed', error: recoveryError };
		}
		if (recovery.kind === 'restored') {
			const current = coordinator.lookup(ownership.canonicalPath);
			if (current.kind !== 'current-owner' ||
				current.ownership.generation !== recovery.ownership.generation ||
				current.ownership.owner.kind !== 'hosted' ||
				recovery.ownership.owner.kind !== 'hosted' ||
				current.ownership.owner.windowId !==
				recovery.ownership.owner.windowId ||
				current.ownership.owner.instanceId !==
				recovery.ownership.owner.instanceId) {
				recovery = {
					kind: 'superseded',
					ownership: current.kind === 'current-owner'
						? current.ownership
						: undefined,
				};
			}
		}
		return { kind: 'failed', error, recovery };
	}
}

function restoreHucodeTransferringOwner(
	coordinator: HucodeDesktopWorkbenchOwnershipCoordinator,
	token: IHucodeDesktopWorkbenchOwnershipToken
): boolean {
	const current = coordinator.lookup(token.canonicalPath);
	return current.kind === 'current-owner' &&
		current.ownership.generation === token.generation &&
		ownersEqual(current.ownership.owner, token.owner) &&
		current.ownership.phase === 'transferring' &&
		coordinator.publish(token).kind === 'published';
}

/** Projects global coordinator records into one Omni session's UI state. */
export function createHucodeDesktopOwnershipState(
	windowId: number,
	ownerships: readonly IHucodeDesktopWorkbenchOwnership[]
): readonly IHucodeDesktopWorkbenchOwnershipState[] {
	return ownerships.flatMap(ownership => {
		if (ownership.phase === 'reserved') {
			return [];
		}
		const owner = ownership.owner;
		return [{
			worktreePath: ownership.displayPath,
			location: owner.kind === 'regular'
				? 'regular' as const
				: owner.windowId === windowId
					? 'this-omni' as const
					: 'another-omni' as const,
			windowId: owner.windowId,
			instanceId: owner.kind === 'hosted'
				? owner.instanceId
				: undefined,
			phase: ownership.phase,
		}];
	});
}

/** Validates a hosted owner against controller state and releases stale claims. */
export function validateHucodeDesktopHostedOwnership<
	T extends IHostedWorkspaceStateEntry
>(
	coordinator: HucodeDesktopWorkbenchOwnershipCoordinator,
	ownership: IHucodeDesktopWorkbenchOwnership,
	instances: Iterable<T>
): T | undefined {
	const owner = ownership.owner;
	if (owner.kind !== 'hosted') {
		return undefined;
	}
	const instance = Array.from(instances).find(candidate =>
		candidate.instanceId === owner.instanceId &&
		isHostedWorkspaceOwnershipRetained(candidate)
	);
	if (!instance) {
		coordinator.release(toToken(ownership));
	}
	return instance;
}

/** Resolves symlinks for existing paths and normalizes missing restore paths. */
export function canonicalizeDesktopWorkbenchPath(path: string): string {
	const absolutePath = normalize(resolve(path));
	try {
		return realpathSync.native(absolutePath);
	} catch {
		return absolutePath;
	}
}

function ownersEqual(
	left: HucodeDesktopWorkbenchOwner,
	right: HucodeDesktopWorkbenchOwner
): boolean {
	return left.kind === right.kind &&
		left.windowId === right.windowId &&
		(left.kind === 'regular' || (
			right.kind === 'hosted' &&
			left.instanceId === right.instanceId
		));
}

function compareRestoreCandidates(
	left: IHucodeDesktopRestoreCandidate,
	right: IHucodeDesktopRestoreCandidate
): number {
	return Number(right.persistedActive) - Number(left.persistedActive) ||
		(right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0) ||
		right.windowLastFocusTime - left.windowLastFocusTime ||
		left.windowId - right.windowId ||
		left.stableInstanceId.localeCompare(right.stableInstanceId);
}

function toToken(
	ownership: IHucodeDesktopWorkbenchOwnership
): IHucodeDesktopWorkbenchOwnershipToken {
	return {
		canonicalPath: ownership.canonicalPath,
		owner: ownership.owner,
		generation: ownership.generation,
	};
}

function createSettlement(): ISettlement {
	let resolve!: (
		outcome: HucodeDesktopWorkbenchOwnershipSettlement
	) => void;
	const promise = new Promise<HucodeDesktopWorkbenchOwnershipSettlement>(
		complete => resolve = complete
	);
	return { promise, resolve };
}
