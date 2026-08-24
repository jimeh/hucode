/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { opendir } from 'fs/promises';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { consumeStream, ReadableStreamEvents } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { FileSystemProviderErrorCode, FileType, IFileReadStreamOptions, IStat, toFileSystemProviderErrorCode } from '../../../platform/files/common/files.js';

/** Maximum entries accepted from a known source directory. */
export const EDITOR_MIGRATION_MAX_DIRECTORY_ENTRIES = 4096;

/** Bounded read request issued by a source adapter. */
export interface EditorMigrationSourceReadLimits {
	readonly maxBytes: number;
}

/** Read-only stat data exposed to source adapters. */
export interface EditorMigrationSourceFileStat {
	readonly type: 'file' | 'directory' | 'other';
	readonly mtime: number;
	readonly size: number;
}

/** Read-only directory entry exposed to source adapters. */
export interface EditorMigrationSourceDirectoryEntry {
	readonly name: string;
	readonly type: 'file' | 'directory' | 'other';
}

/** Narrow filesystem capability available to migration source adapters. */
export interface IEditorMigrationSourceFileSystem {
	realpath(resource: URI, token: CancellationToken): Promise<URI>;
	stat(resource: URI, token: CancellationToken): Promise<EditorMigrationSourceFileStat>;
	readDirectory(resource: URI, token: CancellationToken): Promise<readonly EditorMigrationSourceDirectoryEntry[]>;
	readFile(resource: URI, limits: EditorMigrationSourceReadLimits, token: CancellationToken): Promise<VSBuffer>;
}

/** Error kinds expected while reading an editor source. */
export type EditorMigrationSourceFileErrorKind = 'notFound' | 'permission' | 'oversized' | 'changed' | 'other';

/** Expected source filesystem error without raw operating-system details. */
export class EditorMigrationSourceFileError extends Error {
	constructor(
		readonly kind: EditorMigrationSourceFileErrorKind,
		readonly resource: URI,
		readonly limit?: number,
	) {
		super(`Editor migration source read failed: ${kind}`);
		this.name = 'EditorMigrationSourceFileError';
	}
}

/** Structural read-only subset of the local disk provider. */
export interface IEditorMigrationDiskProvider {
	realpath(resource: URI): Promise<string>;
	stat(resource: URI): Promise<IStat>;
	openDirectory(resource: URI): Promise<IEditorMigrationDirectoryHandle>;
	readFileStream(resource: URI, options: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array>;
}

export interface IEditorMigrationDirectoryHandle {
	read(): Promise<readonly [string, FileType] | undefined>;
	close(): Promise<void>;
}

type EditorMigrationDiskProviderBase = Omit<IEditorMigrationDiskProvider, 'openDirectory'>;

/** Adds incremental native directory enumeration to the existing local disk provider. */
export class NativeEditorMigrationDiskProvider implements IEditorMigrationDiskProvider {
	constructor(private readonly provider: EditorMigrationDiskProviderBase) { }

	realpath(resource: URI): Promise<string> { return this.provider.realpath(resource); }
	stat(resource: URI): Promise<IStat> { return this.provider.stat(resource); }
	readFileStream(resource: URI, options: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		return this.provider.readFileStream(resource, options, token);
	}

	async openDirectory(resource: URI): Promise<IEditorMigrationDirectoryHandle> {
		const directory = await opendir(resource.fsPath);
		return {
			read: async () => {
				const entry = await directory.read();
				if (!entry) {
					return undefined;
				}
				return [entry.name, entry.isFile() ? FileType.File : entry.isDirectory() ? FileType.Directory : FileType.Unknown];
			},
			close: () => directory.close(),
		};
	}
}

/** Wraps the local disk provider without exposing any mutation method. */
export class NativeEditorMigrationSourceFileSystem implements IEditorMigrationSourceFileSystem {
	constructor(private readonly provider: IEditorMigrationDiskProvider) { }

	async realpath(resource: URI, token: CancellationToken): Promise<URI> {
		throwIfCancelled(token);
		try {
			const value = await this.provider.realpath(resource);
			throwIfCancelled(token);
			return URI.file(value);
		} catch (error) {
			throw translateFileError(error, resource);
		}
	}

	async stat(resource: URI, token: CancellationToken): Promise<EditorMigrationSourceFileStat> {
		throwIfCancelled(token);
		try {
			const stat = await this.provider.stat(resource);
			throwIfCancelled(token);
			return {
				type: toSourceFileType(stat.type),
				mtime: stat.mtime,
				size: stat.size,
			};
		} catch (error) {
			throw translateFileError(error, resource);
		}
	}

	async readDirectory(resource: URI, token: CancellationToken): Promise<readonly EditorMigrationSourceDirectoryEntry[]> {
		throwIfCancelled(token);
		let handle: IEditorMigrationDirectoryHandle | undefined;
		try {
			handle = await this.provider.openDirectory(resource);
			const entries: EditorMigrationSourceDirectoryEntry[] = [];
			while (true) {
				throwIfCancelled(token);
				const entry = await handle.read();
				throwIfCancelled(token);
				if (!entry) {
					return entries;
				}
				if (entries.length === EDITOR_MIGRATION_MAX_DIRECTORY_ENTRIES) {
					throw new EditorMigrationSourceFileError('oversized', resource, EDITOR_MIGRATION_MAX_DIRECTORY_ENTRIES);
				}
				entries.push({ name: entry[0], type: toSourceFileType(entry[1]) });
			}
		} catch (error) {
			if (error instanceof EditorMigrationSourceFileError) {
				throw error;
			}
			throw translateFileError(error, resource);
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	async readFile(resource: URI, limits: EditorMigrationSourceReadLimits, token: CancellationToken): Promise<VSBuffer> {
		throwIfCancelled(token);
		try {
			const before = await this.provider.stat(resource);
			if (before.size > limits.maxBytes) {
				throw new EditorMigrationSourceFileError('oversized', resource, limits.maxBytes);
			}

			const stream = this.provider.readFileStream(resource, { length: limits.maxBytes + 1 }, token);
			const value = await consumeStream(stream, chunks => VSBuffer.concat(chunks.map(chunk => VSBuffer.wrap(chunk))));
			throwIfCancelled(token);
			if (value.byteLength > limits.maxBytes) {
				throw new EditorMigrationSourceFileError('oversized', resource, limits.maxBytes);
			}

			const after = await this.provider.stat(resource);
			throwIfCancelled(token);
			if (before.mtime !== after.mtime || before.size !== after.size) {
				throw new EditorMigrationSourceFileError('changed', resource);
			}
			return value;
		} catch (error) {
			if (error instanceof EditorMigrationSourceFileError || error instanceof CancellationError) {
				throw error;
			}
			throw translateFileError(error, resource);
		}
	}
}

interface PendingOperation {
	readonly deferred: DeferredPromise<unknown>;
	readonly factory: (token: CancellationToken) => Promise<unknown>;
	readonly token: CancellationToken;
	cancellationListener: IDisposable;
}

interface ActiveOperation {
	readonly deferred: DeferredPromise<unknown>;
	readonly source: CancellationTokenSource;
	readonly cancellationListener: IDisposable;
}

/** Small cancellable scheduler whose queued promises always settle. */
export class EditorMigrationSourceOperationScheduler extends Disposable {
	private readonly pending: PendingOperation[] = [];
	private readonly active = new Set<ActiveOperation>();
	private disposed = false;

	constructor(private readonly maximumConcurrency: number) {
		super();
		if (!Number.isInteger(maximumConcurrency) || maximumConcurrency < 1) {
			throw new Error('maximumConcurrency must be a positive integer');
		}
	}

	run<T>(factory: (token: CancellationToken) => Promise<T>, token: CancellationToken): Promise<T> {
		if (this.disposed || token.isCancellationRequested) {
			return Promise.reject(new CancellationError());
		}

		const deferred = new DeferredPromise<unknown>();
		const operation: PendingOperation = {
			deferred,
			factory,
			token,
			cancellationListener: token.onCancellationRequested(() => {
				const index = this.pending.indexOf(operation);
				if (index !== -1) {
					this.pending.splice(index, 1);
					operation.cancellationListener.dispose();
					void deferred.error(new CancellationError());
				}
			}),
		};
		this.pending.push(operation);
		this.drain();
		return deferred.p as Promise<T>;
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const operation of this.pending.splice(0)) {
			operation.cancellationListener.dispose();
			void operation.deferred.error(new CancellationError());
		}
		for (const operation of this.active) {
			operation.source.dispose(true);
			if (!operation.deferred.isSettled) {
				void operation.deferred.error(new CancellationError());
			}
		}
		super.dispose();
	}

	private drain(): void {
		while (!this.disposed && this.active.size < this.maximumConcurrency && this.pending.length > 0) {
			const operation = this.pending.shift()!;
			operation.cancellationListener.dispose();
			if (operation.token.isCancellationRequested) {
				void operation.deferred.error(new CancellationError());
				continue;
			}
			const source = new CancellationTokenSource(operation.token);
			const active: ActiveOperation = {
				deferred: operation.deferred,
				source,
				cancellationListener: operation.token.onCancellationRequested(() => {
					if (!operation.deferred.isSettled) {
						void operation.deferred.error(new CancellationError());
					}
				}),
			};
			this.active.add(active);
			void operation.factory(source.token).then(
				value => {
					if (!operation.deferred.isSettled) {
						void operation.deferred.complete(value);
					}
				},
				error => {
					if (!operation.deferred.isSettled) {
						void operation.deferred.error(isCancellationError(error) ? new CancellationError() : error);
					}
				}
			).finally(() => {
				this.active.delete(active);
				active.cancellationListener.dispose();
				source.dispose();
				this.drain();
			});
		}
	}
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

function toSourceFileType(type: FileType): 'file' | 'directory' | 'other' {
	if (type & FileType.File) {
		return 'file';
	}
	if (type & FileType.Directory) {
		return 'directory';
	}
	return 'other';
}

function translateFileError(error: unknown, resource: URI): Error {
	if (isCancellationError(error)) {
		return new CancellationError();
	}
	const code = toFileSystemProviderErrorCode(error instanceof Error ? error : undefined);
	if (code === FileSystemProviderErrorCode.FileNotFound) {
		return new EditorMigrationSourceFileError('notFound', resource);
	}
	if (code === FileSystemProviderErrorCode.NoPermissions || code === FileSystemProviderErrorCode.FileWriteLocked) {
		return new EditorMigrationSourceFileError('permission', resource);
	}
	if (code === FileSystemProviderErrorCode.FileTooLarge) {
		return new EditorMigrationSourceFileError('oversized', resource);
	}
	return new EditorMigrationSourceFileError('other', resource);
}
