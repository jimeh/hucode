/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../base/common/async.js';
import { BroadcastDataChannel } from '../../base/browser/broadcast.js';
import { mainWindow } from '../../base/browser/window.js';
import { Event } from '../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { generateUuid } from '../../base/common/uuid.js';

export interface IHucodeWebTabLockHandle extends IDisposable { }

export type HucodeWebTabLockAdmission =
	| { readonly kind: 'acquired'; readonly handle: IHucodeWebTabLockHandle }
	| { readonly kind: 'held' }
	| { readonly kind: 'unavailable' };

export interface IHucodeWebTabLockProvider {
	acquire(name: string): Promise<HucodeWebTabLockAdmission>;
}

export interface IHucodeWebTabOwnershipChannel extends IDisposable {
	readonly onDidReceiveMessage: Event<HucodeWebTabOwnershipMessage>;
	postMessage(message: HucodeWebTabOwnershipMessage): void;
}

export interface IHucodeWebTabOwnershipClock {
	setTimeout(callback: () => void, delay: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface IHucodeWebTabOwnershipOwner {
	readonly tabId: string;
	readonly instanceId: string;
	readonly generation: string;
}

interface IHucodeWebTabActivationRequest {
	readonly type: 'activate';
	readonly pathKey: string;
	readonly requestId: string;
	readonly requestingTabId: string;
}

interface IHucodeWebTabActivationResult {
	readonly type: 'activation-result';
	readonly pathKey: string;
	readonly requestId: string;
	readonly requestingTabId: string;
	readonly owner: IHucodeWebTabOwnershipOwner;
	readonly focusAccepted: boolean;
}

export type HucodeWebTabOwnershipMessage =
	| IHucodeWebTabActivationRequest
	| IHucodeWebTabActivationResult;

export interface IHucodeWebTabOwnershipClaim {
	readonly pathKey: string;
	readonly generation: string;
}

export interface IHucodeWebTabOwnershipCoordinator extends IDisposable {
	admit(pathKey: string): Promise<HucodeWebTabOwnershipAdmission>;
	publish(
		claim: IHucodeWebTabOwnershipClaim,
		instanceId: string,
		activate: () => Promise<boolean>
	): boolean;
	abandon(claim: IHucodeWebTabOwnershipClaim): boolean;
	release(claim: IHucodeWebTabOwnershipClaim): boolean;
}

export type HucodeWebTabOwnershipAdmission =
	| {
		readonly kind: 'acquired';
		readonly claim: IHucodeWebTabOwnershipClaim;
	}
	| {
		readonly kind: 'reserved-here';
		readonly claim: IHucodeWebTabOwnershipClaim;
	}
	| {
		readonly kind: 'owned-here';
		readonly owner: IHucodeWebTabOwnershipOwner;
	}
	| {
		readonly kind: 'owned-elsewhere';
		readonly owner?: IHucodeWebTabOwnershipOwner;
		readonly focusAccepted?: boolean;
	}
	| { readonly kind: 'unavailable' };

interface ILocalOwnership {
	readonly claim: IHucodeWebTabOwnershipClaim;
	readonly handle: IHucodeWebTabLockHandle;
	readonly ready: DeferredPromise<IHucodeWebTabOwnershipOwner | undefined>;
	owner?: IHucodeWebTabOwnershipOwner;
	activate?: () => Promise<boolean>;
	reservations: number;
}

interface IPendingActivation {
	readonly pathKey: string;
	readonly result: DeferredPromise<IHucodeWebTabActivationResult | undefined>;
	readonly timer: unknown;
}

const DEFAULT_ACTIVATION_TIMEOUT_MS = 750;

/**
 * Coordinates live hosted-workbench ownership between same-origin tabs.
 *
 * Paths are already normalized by the shell using the server's configured
 * case semantics. Browsers cannot resolve server-side symlinks, so this layer
 * intentionally makes no stronger canonical-path claim.
 */
export class HucodeWebTabOwnershipCoordinator extends Disposable
	implements IHucodeWebTabOwnershipCoordinator {
	private readonly local = new Map<string, ILocalOwnership>();
	private readonly pendingAdmissions = new Map<
		string,
		Promise<HucodeWebTabOwnershipAdmission>
	>();
	private readonly pendingActivations = new Map<string, IPendingActivation>();
	private disposed = false;

	constructor(
		private readonly scope: string,
		private readonly tabId: string,
		private readonly locks: IHucodeWebTabLockProvider,
		private readonly channel: IHucodeWebTabOwnershipChannel,
		private readonly clock: IHucodeWebTabOwnershipClock,
		private readonly activationTimeoutMs = DEFAULT_ACTIVATION_TIMEOUT_MS,
	) {
		super();
		this._register(channel);
		this._register(channel.onDidReceiveMessage(message => {
			void this.onMessage(message);
		}));
		this._register(toDisposable(() => {
			this.disposed = true;
			for (const ownership of this.local.values()) {
				ownership.handle.dispose();
				void ownership.ready.complete(undefined);
			}
			this.local.clear();
			for (const pending of this.pendingActivations.values()) {
				this.clock.clearTimeout(pending.timer);
				void pending.result.complete(undefined);
			}
			this.pendingActivations.clear();
			this.pendingAdmissions.clear();
		}));
	}

	async admit(pathKey: string): Promise<HucodeWebTabOwnershipAdmission> {
		const existing = this.local.get(pathKey);
		if (existing) {
			if (existing.owner) {
				return { kind: 'owned-here', owner: existing.owner };
			}
			existing.reservations++;
			return { kind: 'reserved-here', claim: existing.claim };
		}
		const pending = this.pendingAdmissions.get(pathKey);
		if (pending) {
			const admission = await pending;
			return admission.kind === 'acquired'
				? this.admit(pathKey)
				: admission;
		}

		const admission = this.acquireUnowned(pathKey);
		this.pendingAdmissions.set(pathKey, admission);
		try {
			return await admission;
		} finally {
			if (this.pendingAdmissions.get(pathKey) === admission) {
				this.pendingAdmissions.delete(pathKey);
			}
		}
	}

	private async acquireUnowned(
		pathKey: string
	): Promise<HucodeWebTabOwnershipAdmission> {
		const lock = await this.locks.acquire(this.lockName(pathKey));
		if (lock.kind === 'unavailable') {
			return { kind: 'unavailable' };
		}
		if (lock.kind === 'held') {
			return this.requestActivation(pathKey);
		}
		if (this.disposed) {
			lock.handle.dispose();
			return { kind: 'unavailable' };
		}

		const claim: IHucodeWebTabOwnershipClaim = {
			pathKey,
			generation: generateUuid(),
		};
		this.local.set(pathKey, {
			claim,
			handle: lock.handle,
			ready: new DeferredPromise(),
			reservations: 1,
		});
		return { kind: 'acquired', claim };
	}

	publish(
		claim: IHucodeWebTabOwnershipClaim,
		instanceId: string,
		activate: () => Promise<boolean>
	): boolean {
		const ownership = this.local.get(claim.pathKey);
		if (!ownership || ownership.claim.generation !== claim.generation) {
			return false;
		}
		const owner: IHucodeWebTabOwnershipOwner = {
			tabId: this.tabId,
			instanceId,
			generation: claim.generation,
		};
		ownership.owner = owner;
		ownership.activate = activate;
		ownership.reservations = 0;
		if (!ownership.ready.isSettled) {
			void ownership.ready.complete(owner);
		}
		return true;
	}

	abandon(claim: IHucodeWebTabOwnershipClaim): boolean {
		const ownership = this.local.get(claim.pathKey);
		if (!ownership || ownership.claim.generation !== claim.generation ||
			ownership.owner) {
			return false;
		}
		ownership.reservations--;
		if (ownership.reservations > 0) {
			return true;
		}
		return this.release(claim);
	}

	release(claim: IHucodeWebTabOwnershipClaim): boolean {
		const ownership = this.local.get(claim.pathKey);
		if (!ownership || ownership.claim.generation !== claim.generation) {
			return false;
		}
		this.local.delete(claim.pathKey);
		if (!ownership.ready.isSettled) {
			void ownership.ready.complete(undefined);
		}
		ownership.handle.dispose();
		return true;
	}

	private async requestActivation(
		pathKey: string
	): Promise<HucodeWebTabOwnershipAdmission> {
		const requestId = generateUuid();
		const result = new DeferredPromise<IHucodeWebTabActivationResult | undefined>();
		const timer = this.clock.setTimeout(() => {
			void result.complete(undefined);
		}, this.activationTimeoutMs);
		this.pendingActivations.set(requestId, { pathKey, result, timer });
		try {
			this.channel.postMessage({
				type: 'activate',
				pathKey,
				requestId,
				requestingTabId: this.tabId,
			});
		} catch {
			void result.complete(undefined);
		}
		const reply = await result.p;
		this.clock.clearTimeout(timer);
		this.pendingActivations.delete(requestId);
		return {
			kind: 'owned-elsewhere',
			owner: reply?.owner,
			focusAccepted: reply?.focusAccepted,
		};
	}

	private async onMessage(message: HucodeWebTabOwnershipMessage): Promise<void> {
		if (message.type === 'activation-result') {
			if (message.requestingTabId !== this.tabId) {
				return;
			}
			const pending = this.pendingActivations.get(message.requestId);
			if (pending?.pathKey === message.pathKey) {
				void pending.result.complete(message);
			}
			return;
		}
		if (message.requestingTabId === this.tabId) {
			return;
		}
		const ownership = this.local.get(message.pathKey);
		const owner = ownership?.owner ?? await ownership?.ready.p;
		if (!ownership || !owner || !ownership.activate ||
			this.local.get(message.pathKey) !== ownership) {
			return;
		}
		const focusAccepted = await ownership.activate();
		const currentOwner = ownership.owner;
		if (this.local.get(message.pathKey) !== ownership ||
			currentOwner?.generation !== owner.generation) {
			return;
		}
		try {
			this.channel.postMessage({
				type: 'activation-result',
				pathKey: message.pathKey,
				requestId: message.requestId,
				requestingTabId: message.requestingTabId,
				owner: currentOwner,
				focusAccepted,
			});
		} catch {
			// The lock still prevents a duplicate when discovery is unavailable.
		}
	}

	private lockName(pathKey: string): string {
		return `hucode.omni.web-path:${this.scope}:${pathKey}`;
	}
}

class BrowserWebTabLockProvider implements IHucodeWebTabLockProvider {
	async acquire(name: string): Promise<HucodeWebTabLockAdmission> {
		if (!mainWindow.navigator.locks) {
			return { kind: 'unavailable' };
		}
		const admitted = new DeferredPromise<HucodeWebTabLockAdmission>();
		const release = new DeferredPromise<void>();
		void mainWindow.navigator.locks.request(
			name,
			{ mode: 'exclusive', ifAvailable: true },
			async lock => {
				if (!lock) {
					await admitted.complete({ kind: 'held' });
					return;
				}
				await admitted.complete({
					kind: 'acquired',
					handle: toDisposable(() => {
						void release.complete();
					}),
				});
				await release.p;
			}
		).catch(() => {
			void admitted.complete({ kind: 'unavailable' });
		});
		return admitted.p;
	}
}

class BrowserWebTabOwnershipChannel extends BroadcastDataChannel<HucodeWebTabOwnershipMessage>
	implements IHucodeWebTabOwnershipChannel {
	readonly onDidReceiveMessage = this.onDidReceiveData;

	postMessage(message: HucodeWebTabOwnershipMessage): void {
		this.postData(message);
	}
}

const browserClock: IHucodeWebTabOwnershipClock = {
	setTimeout: (callback, delay) => mainWindow.setTimeout(callback, delay),
	clearTimeout: handle => mainWindow.clearTimeout(handle as number),
};

export function createHucodeWebTabOwnershipCoordinator(
	scope: string
): HucodeWebTabOwnershipCoordinator {
	return new HucodeWebTabOwnershipCoordinator(
		scope,
		generateUuid(),
		new BrowserWebTabLockProvider(),
		new BrowserWebTabOwnershipChannel(`hucode.omni.web-ownership:${scope}`),
		browserClock
	);
}
