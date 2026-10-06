/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorage } from '../../../base/parts/storage/common/storage.js';
import product from '../../product/common/product.js';
import { IS_NEW_KEY, loadKeyTargets, StorageTarget, TARGET_KEY } from '../common/storage.js';
import { ONBOARDING_RECORD_VERSION, ONBOARDING_STATE_STORAGE_KEY } from '../common/hucodeOnboardingStorage.js';

/** Seeds first-launch intent before the application newness marker may be persisted. */
export async function initializeHucodeOnboardingStorage(storage: IStorage, enabled = !!product.hucodeVersion): Promise<void> {
	if (!enabled || storage.get(IS_NEW_KEY) !== undefined || storage.get(ONBOARDING_STATE_STORAGE_KEY) !== undefined) {
		return;
	}
	if (!storage.setWithAcknowledgement) {
		throw new Error('Onboarding requires acknowledged application storage.');
	}
	await storage.setWithAcknowledgement(TARGET_KEY, JSON.stringify({ ...loadKeyTargets(storage), [ONBOARDING_STATE_STORAGE_KEY]: StorageTarget.MACHINE }));
	await storage.setWithAcknowledgement(ONBOARDING_STATE_STORAGE_KEY, JSON.stringify({ version: ONBOARDING_RECORD_VERSION, status: 'inProgress', stage: 'bring' }));
}
