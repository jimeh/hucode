/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { DiskFileSystemProvider } from '../../../platform/files/node/diskFileSystemProvider.js';
import {
	EditorMigrationCategory,
	EditorMigrationDiscoveryOptions,
	EditorMigrationSourceFingerprint,
	EditorMigrationSourceProfileRef,
	IEditorMigrationSourceService,
} from '../../common/migration/editorMigrationSource.js';
import { NativeEditorMigrationSourceFileSystem } from '../../node/migration/editorMigrationSourceFileSystem.js';
import { EditorMigrationSourceService } from '../../node/migration/editorMigrationSourceService.js';

interface ReadSourceProfileArguments {
	readonly ref: EditorMigrationSourceProfileRef;
	readonly categories: readonly EditorMigrationCategory[];
}

interface VerifySourceSnapshotArguments {
	readonly ref: EditorMigrationSourceProfileRef;
	readonly fingerprint: EditorMigrationSourceFingerprint;
}

/** Cancellation-aware desktop IPC server for editor source discovery. */
export class EditorMigrationSourceChannel implements IServerChannel {
	constructor(private readonly service: IEditorMigrationSourceService) { }

	listen<T>(_context: string, event: string): Event<T> {
		throw new Error(`Editor migration source channel has no event '${event}'`);
	}

	async call<T>(_context: string, command: string, argument: unknown, token: CancellationToken = CancellationToken.None): Promise<T> {
		switch (command) {
			case 'discoverSources':
				return await this.service.discoverSources(asDiscoveryOptions(argument), token) as T;
			case 'readSourceProfile': {
				const value = asReadArguments(argument);
				return await this.service.readSourceProfile(value.ref, value.categories, token) as T;
			}
			case 'verifySourceSnapshot': {
				const value = asVerifyArguments(argument);
				return await this.service.verifySourceSnapshot(value.ref, value.fingerprint, token) as T;
			}
			default:
				throw new Error(`Unknown editor migration source command '${command}'`);
		}
	}
}

/** Creates the desktop source service and its least-authority IPC channel. */
export function createEditorMigrationSourceChannel(provider: DiskFileSystemProvider): {
	readonly service: EditorMigrationSourceService;
	readonly channel: EditorMigrationSourceChannel;
} {
	const service = new EditorMigrationSourceService(new NativeEditorMigrationSourceFileSystem(provider));
	return { service, channel: new EditorMigrationSourceChannel(service) };
}

function asDiscoveryOptions(value: unknown): EditorMigrationDiscoveryOptions {
	if (value === undefined) {
		return {};
	}
	if (!isObject(value) || (value.includeAbsentCandidateDiagnostics !== undefined && typeof value.includeAbsentCandidateDiagnostics !== 'boolean')) {
		throw new Error('Invalid editor migration discovery options');
	}
	return { includeAbsentCandidateDiagnostics: value.includeAbsentCandidateDiagnostics as boolean | undefined };
}

function asReadArguments(value: unknown): ReadSourceProfileArguments {
	if (!isObject(value) || !isRef(value.ref) || !Array.isArray(value.categories) || !value.categories.every(isCategory)) {
		throw new Error('Invalid readSourceProfile arguments');
	}
	return { ref: value.ref, categories: value.categories };
}

function asVerifyArguments(value: unknown): VerifySourceSnapshotArguments {
	if (!isObject(value) || !isRef(value.ref) || !isFingerprint(value.fingerprint)) {
		throw new Error('Invalid verifySourceSnapshot arguments');
	}
	return { ref: value.ref, fingerprint: value.fingerprint };
}

function isRef(value: unknown): value is EditorMigrationSourceProfileRef {
	return isObject(value) && typeof value.value === 'string';
}

function isFingerprint(value: unknown): value is EditorMigrationSourceFingerprint {
	return isObject(value)
		&& value.schemaVersion === 1
		&& value.algorithm === 'sha256'
		&& typeof value.value === 'string'
		&& Array.isArray(value.categories)
		&& value.categories.every(isCategory)
		&& Array.isArray(value.entries);
}

function isCategory(value: unknown): value is EditorMigrationCategory {
	return value === 'settings' || value === 'keybindings' || value === 'snippets' || value === 'extensions';
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
