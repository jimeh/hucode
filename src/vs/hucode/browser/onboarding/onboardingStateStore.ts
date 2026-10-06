/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { ONBOARDING_STATE_STORAGE_KEY, OnboardingRecord, OnboardingStoredState, readOnboardingState } from '../../../platform/storage/common/hucodeOnboardingStorage.js';
export * from '../../../platform/storage/common/hucodeOnboardingStorage.js';

/** Reads navigation state, with an optional acknowledged native checkpoint authority. */
export class OnboardingStateStore {
	constructor(
		private readonly storageService: IStorageService,
		private readonly checkpoint?: (record: OnboardingRecord) => Promise<void>,
		private readonly readAuthority?: () => Promise<string | undefined>,
	) { }

	read(): OnboardingStoredState {
		return readOnboardingState(this.storageService.get(ONBOARDING_STATE_STORAGE_KEY, StorageScope.APPLICATION));
	}

	/** Native sessions use the ordering authority instead of an eventually consistent mirror. */
	readAccepted(): OnboardingStoredState | Promise<OnboardingStoredState> {
		return this.readAuthority ? this.readAuthority().then(readOnboardingState) : this.read();
	}

	write(record: OnboardingRecord): void | Promise<void> {
		if (this.checkpoint) {
			return this.checkpoint(record);
		}
		this.storageService.store(ONBOARDING_STATE_STORAGE_KEY, JSON.stringify(record), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}
