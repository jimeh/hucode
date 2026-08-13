/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IBaseSerializableStorageRequest, ISerializableItemsChangeEvent } from '../../common/storageIpc.js';
import { StorageDatabaseChannel } from '../../electron-main/storageIpc.js';
import { IStorageChangeEvent } from '../../electron-main/storageMain.js';
import { IStorageMainService } from '../../electron-main/storageMainService.js';

suite('HucodeStorageDatabaseChannel', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('rebinds workspace events after the storage instance closes', async () => {
		const application = disposables.add(new TestStorage());
		const first = disposables.add(new TestStorage());
		let workspace = first;
		const storageMainService = {
			applicationStorage: application,
			applicationSharedStorage: application,
			workspaceStorage: () => workspace,
			profileStorage: () => application,
		} as unknown as IStorageMainService;
		const channel = disposables.add(new StorageDatabaseChannel(new NullLogService(), storageMainService));
		const request: IBaseSerializableStorageRequest = {
			profile: undefined,
			workspace: { id: 'workspace-one' },
		};

		const firstEvent = channel.listen(null, 'onDidChangeStorage', request) as Event<ISerializableItemsChangeEvent>;
		const firstChange = Event.toPromise(firstEvent);
		first.setValue('layout', 'wide');
		assert.deepStrictEqual(await firstChange, { changed: [['layout', 'wide']], deleted: [] });

		first.closeStorage();
		assert.strictEqual(first.hasChangeListeners, false);
		workspace = disposables.add(new TestStorage());
		const secondEvent = channel.listen(null, 'onDidChangeStorage', request) as Event<ISerializableItemsChangeEvent>;
		assert.notStrictEqual(secondEvent, firstEvent);
		const secondChange = Event.toPromise(secondEvent);
		workspace.setValue('layout', 'narrow');
		assert.deepStrictEqual(await secondChange, { changed: [['layout', 'narrow']], deleted: [] });

		await timeout(0);
	});
});

class TestStorage {
	private readonly changeEmitter = new Emitter<IStorageChangeEvent>();
	private readonly closeEmitter = new Emitter<void>();
	readonly onDidChangeStorage = this.changeEmitter.event;
	readonly onDidCloseStorage = this.closeEmitter.event;
	readonly items = new Map<string, string>();

	get hasChangeListeners(): boolean {
		return this.changeEmitter.hasListeners();
	}

	get(key: string): string | undefined {
		return this.items.get(key);
	}

	setValue(key: string, value: string): void {
		this.items.set(key, value);
		this.changeEmitter.fire({ key } as IStorageChangeEvent);
	}

	closeStorage(): void {
		this.closeEmitter.fire();
	}

	dispose(): void {
		this.changeEmitter.dispose();
		this.closeEmitter.dispose();
	}
}
