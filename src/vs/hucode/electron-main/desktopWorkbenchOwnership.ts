/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync } from 'fs';
import { normalize, resolve } from '../../base/common/path.js';
import { isLinux } from '../../base/common/platform.js';
import { getProjectManagerPathComparisonKey } from
	'../../platform/projectManager/common/projectManagerState.js';
import {
	isHostedWorkspaceOwnershipRetained,
	type IHostedWorkspaceStateEntry,
} from '../common/hostedWorkspaceState.js';

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
	private generation = 0;

	constructor(
		options: IHucodeDesktopWorkbenchOwnershipCoordinatorOptions = {}
	) {
		this.canonicalizePath = options.canonicalizePath ??
			canonicalizeDesktopWorkbenchPath;
		this.isCaseSensitive = options.isCaseSensitive ?? isLinux;
		this.now = options.now ?? Date.now;
	}

	lookup(path: string): HucodeDesktopWorkbenchOwnershipLookup {
		const record = this.records.get(this.toKey(path));
		return record
			? { kind: 'current-owner', ownership: record.ownership }
			: { kind: 'absent' };
	}

	reserve(
		path: string,
		owner: HucodeDesktopWorkbenchOwner
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
			if (existing.settlement) {
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
		} else {
			record.settlement ??= createSettlement();
		}
		return { kind: 'published', ownership: record.ownership };
	}

	markRecovering(
		token: IHucodeDesktopWorkbenchOwnershipToken
	): HucodeDesktopWorkbenchPublishOutcome {
		return this.publish(token, 'recovering');
	}

	release(
		token: IHucodeDesktopWorkbenchOwnershipToken
	): HucodeDesktopWorkbenchReleaseOutcome {
		const record = this.getCurrentRecord(token);
		if (!record) {
			const current = this.records.get(this.toKey(token.canonicalPath));
			return {
				kind: 'stale',
				ownership: current?.ownership,
			};
		}

		record.settlement?.resolve({ kind: 'released' });
		this.records.delete(this.toKey(token.canonicalPath));
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
		}
	}

	private getCurrentRecord(
		token: IHucodeDesktopWorkbenchOwnershipToken
	): IInternalOwnershipRecord | undefined {
		const record = this.records.get(this.toKey(token.canonicalPath));
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
				this.toKey(token.canonicalPath)
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
