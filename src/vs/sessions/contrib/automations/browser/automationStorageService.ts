/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IAtomicApplicationStorageService, isAtomicApplicationStorageService } from '../../../../platform/storage/common/storageService.js';
import { AUTOMATION_STORAGE_KEY, IAutomationStorageCompareAndSwapResult, IAutomationStorageService } from '../common/automationStorageService.js';

/**
 * Uses an IndexedDB transaction so automation writes remain atomic across browser tabs.
 */
export class BrowserAutomationStorageService implements IAutomationStorageService {

	declare readonly _serviceBrand: undefined;

	private readonly storageService: IAtomicApplicationStorageService;

	constructor(
		@IStorageService storageService: IStorageService,
	) {
		if (!isAtomicApplicationStorageService(storageService)) {
			throw new Error('Browser automation storage requires atomic application storage.');
		}
		this.storageService = storageService;
	}

	async read(): Promise<string | undefined> {
		return this.storageService.getApplicationStorageValue(AUTOMATION_STORAGE_KEY);
	}

	async compareAndSwap(expectedValue: string | undefined, newValue: string): Promise<IAutomationStorageCompareAndSwapResult> {
		return this.storageService.compareAndSwapApplicationStorage(AUTOMATION_STORAGE_KEY, expectedValue, newValue);
	}
}
