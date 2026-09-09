/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { loadKeyTargets, StorageTarget, TARGET_KEY } from '../../../platform/storage/common/storage.js';
import { IStorageMain } from '../../../platform/storage/electron-main/storageMain.js';
import { ONBOARDING_STATE_STORAGE_KEY, OnboardingRecord, readOnboardingState } from '../../../platform/storage/common/hucodeOnboardingStorage.js';

/** Single-process admission and ordered, acknowledged onboarding checkpoints. */
export class OnboardingMain {
	private pending: Promise<void> = Promise.resolve();
	private owner: number | undefined;
	private warnedMalformed = false;

	constructor(private readonly storage: Pick<IStorageMain, 'storage' | 'init'>, private readonly warnMalformed: () => void = () => { }) { }

	/** Reads only after admitted checkpoint operations have settled. */
	read(): Promise<string | undefined> {
		return this.enqueue(async () => {
			await this.storage.init();
			return this.storage.storage.get(ONBOARDING_STATE_STORAGE_KEY);
		});
	}

	/** Closing or crashing the owning shell releases admission without completing onboarding. */
	release(windowId: number): void {
		if (this.owner === windowId) {
			this.owner = undefined;
		}
	}

	/** Admits one trusted shell, including a reload of the same window. */
	admit(windowId: number, eligible: () => boolean): Promise<boolean> {
		return this.enqueue(async () => {
			await this.storage.init();
			if (!eligible() || this.owner !== undefined && this.owner !== windowId) {
				return false;
			}
			const stored = readOnboardingState(this.storage.storage.get(ONBOARDING_STATE_STORAGE_KEY));
			if (stored.kind === 'record' && stored.origin === 'malformed' && !this.warnedMalformed) {
				this.warnedMalformed = true;
				this.warnMalformed();
			}
			if (stored.kind !== 'record' || stored.origin || stored.record.status !== 'inProgress' && stored.record.status !== 'notStarted') {
				return false;
			}
			const record: OnboardingRecord = { ...stored.record, status: 'inProgress', stage: stored.record.stage ?? 'bring' };
			await this.persist(record);
			if (!eligible()) {
				return false;
			}
			this.owner = windowId;
			return true;
		});
	}

	/** Validates and persists one complete navigation record. Retries always reach the database. */
	checkpoint(raw: string): Promise<void> {
		return this.enqueue(async () => {
			await this.storage.init();
			const next = readOnboardingState(raw);
			if (raw.length > 4096 || next.kind !== 'record' || next.origin) {
				throw new Error('Invalid onboarding checkpoint.');
			}
			const current = readOnboardingState(this.storage.storage.get(ONBOARDING_STATE_STORAGE_KEY));
			if (current.kind === 'superseded') {
				throw new Error('This onboarding record belongs to a newer Hucode version.');
			}
			if (current.kind === 'record' && (current.record.status === 'completed' || current.record.status === 'skipped') && (next.record.status === 'inProgress' || current.record.status === 'completed' && next.record.status === 'skipped')) {
				return;
			}
			await this.persist(next.record);
		});
	}

	private async persist(record: OnboardingRecord): Promise<void> {
		const storage = this.storage.storage;
		if (!storage.setWithAcknowledgement) {
			throw new Error('Acknowledged onboarding storage is unavailable.');
		}
		const targets = loadKeyTargets(storage);
		if (targets[ONBOARDING_STATE_STORAGE_KEY] !== StorageTarget.MACHINE) {
			await storage.setWithAcknowledgement(TARGET_KEY, JSON.stringify({ ...targets, [ONBOARDING_STATE_STORAGE_KEY]: StorageTarget.MACHINE }));
		}
		await storage.setWithAcknowledgement(ONBOARDING_STATE_STORAGE_KEY, JSON.stringify(record));
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation);
		this.pending = result.then(() => undefined, () => undefined);
		return result;
	}
}
