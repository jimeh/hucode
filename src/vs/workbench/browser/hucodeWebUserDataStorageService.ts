/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, PauseableEmitter } from '../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../base/common/lifecycle.js';
import { StorageValue } from '../../base/parts/storage/common/storage.js';
import { HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY } from '../../platform/environment/common/hucodeWebUserDataMigration.js';
import { IAtomicApplicationStorageService } from '../../platform/storage/common/storageService.js';
import {
	IApplicationSharedStorageValueChangeEvent,
	IApplicationStorageValueChangeEvent,
	IProfileStorageValueChangeEvent,
	IStorageEntry,
	IStorageService,
	IStorageTargetChangeEvent,
	IStorageValueChangeEvent,
	IWillSaveStateEvent,
	IWorkspaceStorageValueChangeEvent,
	StorageScope,
	StorageTarget,
	WillSaveStateReason,
} from '../../platform/storage/common/storage.js';
import { IUserDataProfile } from '../../platform/userDataProfile/common/userDataProfile.js';
import { IAnyWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';

export interface IHucodeWebUserDataStorageBackend extends IStorageService, IAtomicApplicationStorageService, IDisposable {
	close(): void | Promise<void>;
}

/** Keeps the browser's service identity local while all other state remains server-authoritative. */
export class HucodeWebUserDataStorageService extends Disposable implements IStorageService, IAtomicApplicationStorageService {
	declare readonly _serviceBrand: undefined;

	private readonly changeListeners = this._register(new DisposableStore());
	private readonly _onDidChangeValue = this._register(new PauseableEmitter<IStorageValueChangeEvent>());
	private readonly _onDidChangeTarget = this._register(new PauseableEmitter<IStorageTargetChangeEvent>());
	readonly onDidChangeTarget = this._onDidChangeTarget.event;
	readonly onWillSaveState: Event<IWillSaveStateEvent>;

	constructor(
		private readonly remoteStorage: IHucodeWebUserDataStorageBackend,
		private readonly browserStorage: IHucodeWebUserDataStorageBackend,
	) {
		super();
		this._register(remoteStorage);
		this._register(browserStorage);
		this.onWillSaveState = remoteStorage.onWillSaveState;
		for (const scope of [StorageScope.APPLICATION_SHARED, StorageScope.APPLICATION, StorageScope.PROFILE, StorageScope.WORKSPACE]) {
			this.changeListeners.add(remoteStorage.onDidChangeValue(scope, undefined, this.changeListeners)(event => {
				if (!this.isBrowserLocal(event.key, event.scope)) {
					this._onDidChangeValue.fire(event);
				}
			}));
		}
		this.changeListeners.add(browserStorage.onDidChangeValue(StorageScope.APPLICATION, HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, this.changeListeners)(event => this._onDidChangeValue.fire(event)));
		this.changeListeners.add(remoteStorage.onDidChangeTarget(event => this._onDidChangeTarget.fire(event)));
		this.changeListeners.add(Event.filter(browserStorage.onDidChangeTarget, event => event.scope === StorageScope.APPLICATION)(event => this._onDidChangeTarget.fire(event)));
	}

	onDidChangeValue(scope: StorageScope.WORKSPACE, key: string | undefined, disposable: DisposableStore): Event<IWorkspaceStorageValueChangeEvent>;
	onDidChangeValue(scope: StorageScope.PROFILE, key: string | undefined, disposable: DisposableStore): Event<IProfileStorageValueChangeEvent>;
	onDidChangeValue(scope: StorageScope.APPLICATION, key: string | undefined, disposable: DisposableStore): Event<IApplicationStorageValueChangeEvent>;
	onDidChangeValue(scope: StorageScope.APPLICATION_SHARED, key: string | undefined, disposable: DisposableStore): Event<IApplicationSharedStorageValueChangeEvent>;
	onDidChangeValue(scope: StorageScope, key: string | undefined, disposable: DisposableStore): Event<IStorageValueChangeEvent> {
		return Event.filter(this._onDidChangeValue.event, event => event.scope === scope && (key === undefined || event.key === key), disposable);
	}

	get(key: string, scope: StorageScope, fallbackValue: string): string;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined {
		return this.storageFor(key, scope).get(key, scope, fallbackValue);
	}

	getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
	getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined;
	getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		return this.storageFor(key, scope).getBoolean(key, scope, fallbackValue);
	}

	getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
	getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined;
	getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined {
		return this.storageFor(key, scope).getNumber(key, scope, fallbackValue);
	}

	getObject<T extends object>(key: string, scope: StorageScope, fallbackValue: T): T;
	getObject<T extends object>(key: string, scope: StorageScope, fallbackValue?: T): T | undefined;
	getObject<T extends object>(key: string, scope: StorageScope, fallbackValue?: T): T | undefined {
		return this.storageFor(key, scope).getObject<T>(key, scope, fallbackValue);
	}

	store(key: string, value: StorageValue, scope: StorageScope, target: StorageTarget): void {
		this.storageFor(key, scope).store(key, value, scope, target);
	}

	storeAll(entries: IStorageEntry[], external: boolean): void {
		const browserEntries: IStorageEntry[] = [];
		const remoteEntries: IStorageEntry[] = [];
		for (const entry of entries) {
			(this.isBrowserLocal(entry.key, entry.scope) ? browserEntries : remoteEntries).push(entry);
		}
		this._onDidChangeValue.pause();
		this._onDidChangeTarget.pause();
		try {
			if (browserEntries.length) {
				this.browserStorage.storeAll(browserEntries, external);
			}
			if (remoteEntries.length) {
				this.remoteStorage.storeAll(remoteEntries, external);
			}
		} finally {
			this._onDidChangeValue.resume();
			this._onDidChangeTarget.resume();
		}
	}

	remove(key: string, scope: StorageScope): void {
		this.storageFor(key, scope).remove(key, scope);
	}

	keys(scope: StorageScope, target: StorageTarget): string[] {
		const remoteKeys = this.remoteStorage.keys(scope, target).filter(key => !this.isBrowserLocal(key, scope));
		if (scope !== StorageScope.APPLICATION) {
			return remoteKeys;
		}
		const browserKeys = this.browserStorage.keys(scope, target).filter(key => key === HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY);
		return [...new Set([...remoteKeys, ...browserKeys])];
	}

	log(): void {
		const entries: Array<{ scope: StorageScope; target: StorageTarget; key: string; value: string | undefined }> = [];
		for (const scope of [StorageScope.APPLICATION_SHARED, StorageScope.APPLICATION, StorageScope.PROFILE, StorageScope.WORKSPACE]) {
			for (const target of [StorageTarget.USER, StorageTarget.MACHINE]) {
				for (const key of this.keys(scope, target)) {
					entries.push({ scope, target, key, value: this.get(key, scope) });
				}
			}
		}
		console.table(entries);
	}

	hasScope(scope: IAnyWorkspaceIdentifier | IUserDataProfile): boolean {
		return this.remoteStorage.hasScope(scope);
	}

	switch(to: IAnyWorkspaceIdentifier | IUserDataProfile, preserveData: boolean): Promise<void> {
		return this.remoteStorage.switch(to, preserveData);
	}

	isNew(scope: StorageScope): boolean {
		return this.remoteStorage.isNew(scope);
	}

	async optimize(scope: StorageScope): Promise<void> {
		if (scope === StorageScope.APPLICATION) {
			await Promise.all([this.remoteStorage.optimize(scope), this.browserStorage.optimize(scope)]);
			return;
		}
		await this.remoteStorage.optimize(scope);
	}

	async flush(reason?: WillSaveStateReason): Promise<void> {
		await Promise.all([this.remoteStorage.flush(reason), this.browserStorage.flush(reason)]);
	}

	getApplicationStorageValue(key: string): Promise<string | undefined> {
		return this.atomicStorageFor(key).getApplicationStorageValue(key);
	}

	compareAndSwapApplicationStorage(key: string, expectedValue: string | undefined, newValue: string): Promise<{ readonly swapped: boolean; readonly currentValue: string | undefined }> {
		return this.atomicStorageFor(key).compareAndSwapApplicationStorage(key, expectedValue, newValue);
	}

	async close(): Promise<void> {
		await Promise.allSettled([
			Promise.resolve(this.remoteStorage.close()),
			Promise.resolve(this.browserStorage.close()),
		]);
		this.dispose();
	}

	private storageFor(key: string, scope: StorageScope): IStorageService {
		return this.isBrowserLocal(key, scope) ? this.browserStorage : this.remoteStorage;
	}

	private atomicStorageFor(key: string): IAtomicApplicationStorageService {
		return key === HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY ? this.browserStorage : this.remoteStorage;
	}

	private isBrowserLocal(key: string, scope: StorageScope): boolean {
		return scope === StorageScope.APPLICATION && key === HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY;
	}
}
