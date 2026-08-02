/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { Queue } from '../../base/common/async.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable } from '../../base/common/lifecycle.js';
import { dirname, join } from '../../base/common/path.js';
import { IServerChannel } from '../../base/parts/ipc/common/ipc.js';
import { Storage } from '../../base/parts/storage/common/storage.js';
import { SQLiteStorageDatabase } from '../../base/parts/storage/node/storage.js';
import { ILogService } from '../../platform/log/common/log.js';
import {
	IBaseSerializableStorageRequest,
	ISerializableCompareAndSwapRequest,
	ISerializableCompareAndSwapResult,
	ISerializableGetValueRequest,
	ISerializableItemsChangeEvent,
	ISerializableUpdateRequest,
} from '../../platform/storage/common/storageIpc.js';

interface HucodeWebStorageEntry {
	readonly key: string;
	readonly storage: Storage;
	readonly writes: Queue<unknown>;
}

/**
 * Hosts the web client's state databases in the serve-web WebUser namespace.
 */
export class HucodeWebUserDataStorageHost extends Disposable {
	private readonly entries = new Map<string, Promise<HucodeWebStorageEntry>>();
	private readonly entryDisposables = this._register(new DisposableMap<string, DisposableStore>());
	private readonly emitters = new Map<string, Emitter<ISerializableItemsChangeEvent>>();
	private readonly operations = new Queue<unknown>();
	private closing = false;
	private closePromise: Promise<void> | undefined;

	constructor(
		private readonly stateHome: string,
		private readonly isKnownProfile: (id: string) => boolean,
		private readonly logService: ILogService,
		private readonly acquireOperationLease?: () => IDisposable,
	) {
		super();
	}

	/** Returns the common storage IPC channel backed by this host. */
	createChannel<TContext>(): IServerChannel<TContext> {
		return new HucodeWebUserDataStorageChannel(this) as IServerChannel<TContext>;
	}

	getChangeEvent(request: IBaseSerializableStorageRequest): Event<ISerializableItemsChangeEvent> {
		const key = this.resolveDatabase(request).key;
		let emitter = this.emitters.get(key);
		if (!emitter) {
			emitter = this._register(new Emitter<ISerializableItemsChangeEvent>());
			this.emitters.set(key, emitter);
		}
		return emitter.event;
	}

	async getItems(request: IBaseSerializableStorageRequest): Promise<[string, string][]> {
		return this.queueOperation(async () => {
			const entry = await this.getEntry(request);
			return Array.from(entry.storage.items.entries());
		});
	}

	async getValue(request: ISerializableGetValueRequest): Promise<string | undefined> {
		return this.queueOperation(async () => {
			const entry = await this.getEntry(request);
			return entry.storage.get(request.key);
		});
	}

	async updateItems(request: ISerializableUpdateRequest): Promise<void> {
		await this.queueOperation(async () => {
			const entry = await this.getEntry(request);
			await entry.writes.queue(async () => {
				const writes: Promise<void>[] = [];
				for (const [key, value] of request.insert ?? []) {
					writes.push(entry.storage.set(key, value));
				}
				for (const key of request.delete ?? []) {
					writes.push(entry.storage.delete(key));
				}
				await Promise.all(writes);
			});
		});
	}

	async compareAndSwap(
		request: ISerializableCompareAndSwapRequest,
	): Promise<ISerializableCompareAndSwapResult> {
		return this.queueOperation(async () => {
			const entry = await this.getEntry(request);
			return entry.writes.queue(async () => {
				const currentValue = entry.storage.get(request.key);
				if (currentValue !== request.expectedValue) {
					return { swapped: false, currentValue };
				}
				await entry.storage.set(request.key, request.newValue);
				return { swapped: true, currentValue: request.newValue };
			}) as Promise<ISerializableCompareAndSwapResult>;
		});
	}

	async optimize(request: IBaseSerializableStorageRequest): Promise<void> {
		await this.queueOperation(async () => {
			const entry = await this.getEntry(request);
			await entry.writes.queue(() => entry.storage.optimize());
		});
	}

	/** Clears every server-backed state database after admitted operations settle. */
	async reset(): Promise<void> {
		await this.queueOperation(async () => {
			for (const [key, entry] of [...this.entries.entries()]) {
				const resolved = await entry;
				const deleted = [...resolved.storage.items.keys()];
				await this.closeEntry(resolved);
				if (deleted.length) {
					this.emitters.get(key)?.fire({ deleted });
				}
			}
			this.entries.clear();
			await fs.rm(this.stateHome, { recursive: true, force: true });
		});
	}

	async close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = (async () => {
				await this.operations.whenIdle();
				const entries = await Promise.all(this.entries.values());
				await Promise.all(entries.map(entry => this.closeEntry(entry)));
			})();
		}
		await this.closePromise;
	}

	private queueOperation<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) {
			return Promise.reject(new Error('Serve-web user-data storage is shutting down.'));
		}
		const lease = this.acquireOperationLease?.();
		return this.operations.queue(async () => {
			try {
				return await operation();
			} finally {
				lease?.dispose();
			}
		}) as Promise<T>;
	}

	private async getEntry(
		request: IBaseSerializableStorageRequest,
	): Promise<HucodeWebStorageEntry> {
		const resolved = this.resolveDatabase(request);
		let entry = this.entries.get(resolved.key);
		if (!entry) {
			entry = this.createEntry(resolved.key, resolved.path);
			this.entries.set(resolved.key, entry);
			void entry.catch(() => {
				if (this.entries.get(resolved.key) === entry) {
					this.entries.delete(resolved.key);
				}
			});
		}
		return entry;
	}

	private async createEntry(key: string, path: string): Promise<HucodeWebStorageEntry> {
		await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const database = new SQLiteStorageDatabase(path, {
			logging: {
				logTrace: message => this.logService.trace(`[WebUser storage ${key}] ${message}`),
				logError: error => this.logService.error(`[WebUser storage ${key}]`, error),
			},
		});
		const disposables = new DisposableStore();
		const storage = disposables.add(new Storage(database));
		try {
			await storage.init();
			if (await database.isInMemory()) {
				throw new Error(`Serve-web user-data database could not be opened at ${path}.`);
			}

			disposables.add(storage.onDidChangeStorage(event => {
				const value = storage.get(event.key);
				this.emitters.get(key)?.fire(value === undefined
					? { deleted: [event.key] }
					: { changed: [[event.key, value]] });
			}));

			this.entryDisposables.set(key, disposables);
			return { key, storage, writes: new Queue<unknown>() };
		} catch (error) {
			try {
				await storage.close();
			} catch (closeError) {
				this.logService.error(`[WebUser storage ${key}] Unable to close failed database entry.`, closeError);
			} finally {
				disposables.dispose();
			}
			throw error;
		}
	}

	private async closeEntry(entry: HucodeWebStorageEntry): Promise<void> {
		await entry.writes.whenIdle();
		try {
			await entry.storage.close();
		} finally {
			this.entryDisposables.deleteAndDispose(entry.key);
		}
	}

	private resolveDatabase(request: IBaseSerializableStorageRequest): {
		readonly key: string;
		readonly path: string;
	} {
		if (request.workspace) {
			const id = (request.workspace as { id?: unknown }).id;
			if (typeof id !== 'string' || !id || id.length > 4096 || id.includes('\0')) {
				throw new Error('Invalid workspace storage identifier.');
			}
			const digest = createHash('sha256').update(id).digest('hex');
			return {
				key: `workspace:${digest}`,
				path: join(this.stateHome, 'workspaces', digest, 'state.vscdb'),
			};
		}

		if (request.profile) {
			const id = request.profile.id;
			if (!isSafeProfileId(id) || !this.isKnownProfile(id)) {
				throw new Error('Unknown web user-data profile.');
			}
			return {
				key: `profile:${id}`,
				path: join(this.stateHome, 'profiles', id, 'state.vscdb'),
			};
		}

		if (request.applicationShared) {
			return {
				key: 'application-shared',
				path: join(this.stateHome, 'application-shared', 'state.vscdb'),
			};
		}

		return {
			key: 'application',
			path: join(this.stateHome, 'application', 'state.vscdb'),
		};
	}
}

/** Returns whether an identifier is safe for use as a profile path segment. */
export function isSafeProfileId(id: unknown): id is string {
	return typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id) && !/^\.+$/.test(id);
}

class HucodeWebUserDataStorageChannel implements IServerChannel {
	constructor(private readonly host: HucodeWebUserDataStorageHost) { }

	listen<T>(_: unknown, event: string, request: IBaseSerializableStorageRequest): Event<T> {
		if (event !== 'onDidChangeStorage') {
			throw new Error(`Event not found: ${event}`);
		}
		return this.host.getChangeEvent(request) as Event<T>;
	}

	async call<T>(_: unknown, command: string, request: IBaseSerializableStorageRequest): Promise<T> {
		switch (command) {
			case 'getItems':
				return await this.host.getItems(request) as T;
			case 'getValue':
				return await this.host.getValue(request as ISerializableGetValueRequest) as T;
			case 'updateItems':
				return await this.host.updateItems(request as ISerializableUpdateRequest) as T;
			case 'compareAndSwap':
				return await this.host.compareAndSwap(request as ISerializableCompareAndSwapRequest) as T;
			case 'optimize':
				return await this.host.optimize(request) as T;
			case 'isUsed':
				return false as T;
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}
}
