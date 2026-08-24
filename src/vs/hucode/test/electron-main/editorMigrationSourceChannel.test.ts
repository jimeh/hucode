/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import {
	EditorMigrationCategory,
	EditorMigrationDiscoveryOptions,
	EditorMigrationDiscoveryResult,
	EditorMigrationSourceFingerprint,
	EditorMigrationSourceProfileRef,
	EditorMigrationSourceSnapshot,
	EditorMigrationSourceVerification,
	IEditorMigrationSourceService,
} from '../../common/migration/editorMigrationSource.js';
import { EditorMigrationSourceChannelClient } from '../../common/migration/editorMigrationSourceIpc.js';
import { EditorMigrationSourceChannel } from '../../electron-main/migration/editorMigrationSourceChannel.js';

suite('EditorMigrationSourceChannel', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards protocol cancellation to active discovery', async () => {
		const service = new WaitingSourceService();
		const server = new EditorMigrationSourceChannel(service);
		const client = new EditorMigrationSourceChannelClient(localChannel(server));
		const source = disposables.add(new CancellationTokenSource());

		const result = client.discoverSources({}, source.token);
		source.cancel();

		await assert.rejects(result, error => error instanceof CancellationError);
		assert.strictEqual(service.sawCancellation, true);
	});

	test('rejects malformed arguments and unknown commands', async () => {
		const server = new EditorMigrationSourceChannel(new WaitingSourceService());

		await assert.rejects(server.call('', 'readSourceProfile', { ref: { value: 'ref' }, categories: ['unknown'] }, CancellationToken.None), /Invalid readSourceProfile arguments/);
		await assert.rejects(server.call('', 'unknown', undefined, CancellationToken.None), /Unknown editor migration source command/);
	});
});

function localChannel(server: EditorMigrationSourceChannel): IChannel {
	return {
		call: (command, argument, token) => server.call('', command, argument, token),
		listen: event => server.listen('', event),
	};
}

class WaitingSourceService implements IEditorMigrationSourceService {
	declare readonly _serviceBrand: undefined;
	sawCancellation = false;

	async discoverSources(_options: EditorMigrationDiscoveryOptions, token: CancellationToken): Promise<EditorMigrationDiscoveryResult> {
		if (!token.isCancellationRequested) {
			await new Promise<void>(resolve => {
				const listener = token.onCancellationRequested(() => {
					listener.dispose();
					resolve();
				});
			});
		}
		this.sawCancellation = true;
		throw new CancellationError();
	}

	async readSourceProfile(_ref: EditorMigrationSourceProfileRef, _categories: readonly EditorMigrationCategory[], _token: CancellationToken): Promise<EditorMigrationSourceSnapshot> {
		throw new Error('not called');
	}

	async verifySourceSnapshot(_ref: EditorMigrationSourceProfileRef, _fingerprint: EditorMigrationSourceFingerprint, _token: CancellationToken): Promise<EditorMigrationSourceVerification> {
		return { status: 'unavailable', diagnostics: [] };
	}
}
