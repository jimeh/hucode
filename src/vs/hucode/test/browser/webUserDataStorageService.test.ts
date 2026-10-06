/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../base/common/network.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { isUUID } from '../../../base/common/uuid.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { getServiceMachineId } from '../../../platform/externalServices/common/serviceMachineId.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import { HucodeWebUserDataStorageService, IHucodeWebUserDataStorageBackend } from '../../../workbench/browser/hucodeWebUserDataStorageService.js';
import { HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY } from '../../../platform/environment/common/hucodeWebUserDataMigration.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import type { IWorkbenchConstructionOptions } from '../../../workbench/browser/web.api.js';
import { BrowserWorkbenchEnvironmentService } from '../../../workbench/services/environment/browser/environmentService.js';
import { TestProductService } from '../../../workbench/test/common/workbenchTestServices.js';

suite('HucodeWebUserDataStorageService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function createStorage(): Promise<{
		readonly storage: HucodeWebUserDataStorageService;
		readonly remote: AtomicInMemoryStorageService;
		readonly browser: AtomicInMemoryStorageService;
	}> {
		const remote = new AtomicInMemoryStorageService();
		const browser = new AtomicInMemoryStorageService();
		await Promise.all([remote.initialize(), browser.initialize()]);
		const storage = disposables.add(new HucodeWebUserDataStorageService(remote, browser));
		return { storage, remote, browser };
	}

	test('routes only the application machine identity to browser storage', async () => {
		const { storage, remote, browser } = await createStorage();
		browser.store(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, 'browser-uuid', StorageScope.APPLICATION, StorageTarget.MACHINE);
		remote.store(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, 'stale-server-uuid', StorageScope.APPLICATION, StorageTarget.MACHINE);
		remote.store('workbench.colorTheme', 'Default Dark Modern', StorageScope.APPLICATION, StorageTarget.USER);

		assert.strictEqual(storage.get(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), 'browser-uuid');
		assert.strictEqual(storage.get('workbench.colorTheme', StorageScope.APPLICATION), 'Default Dark Modern');
		assert.deepStrictEqual(storage.keys(StorageScope.APPLICATION, StorageTarget.MACHINE), [HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY]);

		browser.store(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, '17', StorageScope.APPLICATION, StorageTarget.MACHINE);
		assert.strictEqual(storage.getNumber(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), 17);
		browser.store(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, 'true', StorageScope.APPLICATION, StorageTarget.MACHINE);
		assert.strictEqual(storage.getBoolean(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), true);
		browser.store(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, JSON.stringify({ id: 'browser-uuid' }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		assert.deepStrictEqual(storage.getObject(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), { id: 'browser-uuid' });

		const batchListeners = disposables.add(new DisposableStore());
		let remoteValueWhenLocalBatchEventFired: string | undefined;
		batchListeners.add(storage.onDidChangeValue(StorageScope.APPLICATION, HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, batchListeners)(() => {
			remoteValueWhenLocalBatchEventFired = storage.get('workbench.colorTheme', StorageScope.APPLICATION);
		}));
		storage.storeAll([
			{ key: HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, value: 'browser-updated', scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
			{ key: 'workbench.colorTheme', value: 'Default Light Modern', scope: StorageScope.APPLICATION, target: StorageTarget.USER },
		], false);
		assert.strictEqual(browser.get(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), 'browser-updated');
		assert.strictEqual(remote.get(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), 'stale-server-uuid');
		assert.strictEqual(remote.get('workbench.colorTheme', StorageScope.APPLICATION), 'Default Light Modern');
		assert.strictEqual(remoteValueWhenLocalBatchEventFired, 'Default Light Modern', 'mixed batch events must wait for both backends');

		storage.remove(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION);
		assert.strictEqual(storage.get(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), undefined);
		assert.strictEqual(remote.get(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), 'stale-server-uuid');
		assert.deepStrictEqual(storage.keys(StorageScope.APPLICATION, StorageTarget.MACHINE), [], 'a stale server identity must stay hidden after local removal');
	});

	test('routes machine identity events and atomic access locally', async () => {
		const { storage, remote, browser } = await createStorage();
		browser.store(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, 'browser-uuid', StorageScope.APPLICATION, StorageTarget.MACHINE);
		remote.store(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, 'stale-server-uuid', StorageScope.APPLICATION, StorageTarget.MACHINE);
		const listeners = disposables.add(new DisposableStore());
		const exactEvents: string[] = [];
		const applicationEvents: string[] = [];
		listeners.add(storage.onDidChangeValue(StorageScope.APPLICATION, HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, listeners)(event => exactEvents.push(event.key)));
		listeners.add(storage.onDidChangeValue(StorageScope.APPLICATION, undefined, listeners)(event => applicationEvents.push(event.key)));

		storage.store(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, 'browser-updated', StorageScope.APPLICATION, StorageTarget.MACHINE);
		remote.store(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, 'server-updated', StorageScope.APPLICATION, StorageTarget.MACHINE);
		remote.store('workbench.colorTheme', 'Default Dark Modern', StorageScope.APPLICATION, StorageTarget.USER);

		assert.deepStrictEqual(exactEvents, [HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY]);
		assert.deepStrictEqual(applicationEvents, [HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, 'workbench.colorTheme']);
		assert.strictEqual(await storage.getApplicationStorageValue(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY), 'browser-updated');
		assert.deepStrictEqual(
			await storage.compareAndSwapApplicationStorage(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, 'browser-updated', 'browser-atomic'),
			{ swapped: true, currentValue: 'browser-atomic' },
		);
		assert.strictEqual(browser.get(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), 'browser-atomic');
		assert.strictEqual(remote.get(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), 'server-updated');
		remote.store('other.atomic', 'remote', StorageScope.APPLICATION, StorageTarget.MACHINE);
		assert.strictEqual(await storage.getApplicationStorageValue('other.atomic'), 'remote');
		assert.deepStrictEqual(await storage.compareAndSwapApplicationStorage('other.atomic', 'remote', 'remote-updated'), { swapped: true, currentValue: 'remote-updated' });
		assert.strictEqual(remote.get('other.atomic', StorageScope.APPLICATION), 'remote-updated');
		assert.strictEqual(browser.get('other.atomic', StorageScope.APPLICATION), undefined);

		remote.remove(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION);
		remote.remove('workbench.colorTheme', StorageScope.APPLICATION);
		assert.strictEqual(storage.get(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), 'browser-atomic', 'server reset must not clear browser identity');
	});

	test('creates distinct first-run identities in browser-local files', async () => {
		const remoteUserDataHome = URI.from({ scheme: Schemas.vscodeRemote, authority: 'host', path: '/WebUser/User' });
		const environmentService = new BrowserWorkbenchEnvironmentService(
			'workspace-id',
			URI.file('/logs'),
			{
				hucodeWebUserDataStorage: 'server',
				hucodeWebUserDataHome: remoteUserDataHome,
			} as IWorkbenchConstructionOptions,
			TestProductService,
		);
		const expectedBrowserMachineIdResource = URI.from({ scheme: Schemas.vscodeUserData, path: '/User/machineid' });
		assert.strictEqual(environmentService.userRoamingDataHome.toString(), remoteUserDataHome.toString());
		assert.strictEqual(environmentService.serviceMachineIdResource.toString(), expectedBrowserMachineIdResource.toString());
		assert.strictEqual(environmentService.stateResource.scheme, Schemas.vscodeRemote, 'all other user data resources must stay remote');

		const sharedRemoteProvider = disposables.add(new InMemoryFileSystemProvider());
		const identities: string[] = [];
		for (let browser = 0; browser < 2; browser++) {
			const fileService = disposables.add(new FileService(new NullLogService()));
			const browserProvider = disposables.add(new InMemoryFileSystemProvider());
			disposables.add(fileService.registerProvider(Schemas.vscodeUserData, browserProvider));
			disposables.add(fileService.registerProvider(Schemas.vscodeRemote, sharedRemoteProvider));
			await fileService.createFolder(joinPath(expectedBrowserMachineIdResource, '..'));
			await fileService.createFolder(remoteUserDataHome);
			const { storage, remote, browser: browserStorage } = await createStorage();

			const identity = await getServiceMachineId(environmentService, fileService, storage);
			identities.push(identity);
			assert.ok(isUUID(identity));
			assert.strictEqual((await fileService.readFile(expectedBrowserMachineIdResource)).value.toString(), identity);
			assert.strictEqual(browserStorage.get(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), identity);
			assert.strictEqual(remote.get(HUCODE_WEB_USER_DATA_SERVICE_MACHINE_ID_KEY, StorageScope.APPLICATION), undefined);
			assert.strictEqual(await fileService.exists(joinPath(remoteUserDataHome, 'machineid')), false, 'first-run fallback must not create a server machine identity file');
		}

		assert.notStrictEqual(identities[0], identities[1], 'fresh browser profiles must not adopt a server-shared machine identity');
	});
});

class AtomicInMemoryStorageService extends InMemoryStorageService implements IHucodeWebUserDataStorageBackend {
	async getApplicationStorageValue(key: string): Promise<string | undefined> {
		return this.get(key, StorageScope.APPLICATION);
	}

	async compareAndSwapApplicationStorage(key: string, expectedValue: string | undefined, newValue: string): Promise<{ readonly swapped: boolean; readonly currentValue: string | undefined }> {
		const currentValue = this.get(key, StorageScope.APPLICATION);
		if (currentValue !== expectedValue) {
			return { swapped: false, currentValue };
		}
		this.store(key, newValue, StorageScope.APPLICATION, StorageTarget.MACHINE);
		return { swapped: true, currentValue: newValue };
	}

	close(): void {
		this.dispose();
	}
}
