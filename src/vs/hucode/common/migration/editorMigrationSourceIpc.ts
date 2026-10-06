/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import {
	EditorMigrationCategory,
	EditorMigrationDiscoveryOptions,
	EditorMigrationDiscoveryResult,
	EditorMigrationSourceFingerprint,
	EditorMigrationSourceProfileRef,
	EditorMigrationSourceSnapshot,
	EditorMigrationSourceVerification,
	IEditorMigrationSourceService,
} from './editorMigrationSource.js';

/** Hand-written client that forwards cancellation through the IPC protocol. */
export class EditorMigrationSourceChannelClient implements IEditorMigrationSourceService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly channel: IChannel) { }

	discoverSources(options: EditorMigrationDiscoveryOptions, token: CancellationToken): Promise<EditorMigrationDiscoveryResult> {
		return this.channel.call('discoverSources', options, token);
	}

	readSourceProfile(ref: EditorMigrationSourceProfileRef, categories: readonly EditorMigrationCategory[], token: CancellationToken): Promise<EditorMigrationSourceSnapshot> {
		return this.channel.call('readSourceProfile', { ref, categories }, token);
	}

	verifySourceSnapshot(ref: EditorMigrationSourceProfileRef, fingerprint: EditorMigrationSourceFingerprint, token: CancellationToken): Promise<EditorMigrationSourceVerification> {
		return this.channel.call('verifySourceSnapshot', { ref, fingerprint }, token);
	}
}
