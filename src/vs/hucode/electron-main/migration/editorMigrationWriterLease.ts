/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';

/** Identity of one main-process editor migration writer lease. */
export interface EditorMigrationWriterLease {
	readonly windowId: number;
	readonly operationId: string;
	readonly generation: number;
}

/** Installation-wide, generation-safe editor migration writer authority. */
export class EditorMigrationWriterLeaseAuthority {
	private current: EditorMigrationWriterLease | undefined;
	private generation = 0;

	/** Acquires the sole writer lease, or returns undefined while another holder owns it. */
	acquire(windowId: number, operationId: string): EditorMigrationWriterLease | undefined {
		if (!operationId || this.current) {
			return undefined;
		}
		return this.current = Object.freeze({ windowId, operationId, generation: ++this.generation });
	}

	/** Releases only the exact active generation. */
	release(lease: EditorMigrationWriterLease): void {
		if (this.current === lease) {
			this.current = undefined;
		}
	}

	/** Returns whether the exact bound shell request still owns mutation authority. */
	holds(windowId: number, operationId: string): boolean {
		return this.current?.windowId === windowId && this.current.operationId === operationId;
	}
}

/** Binds one shell-controller connection to at most one exact writer lease. */
export function bindEditorMigrationWriterLease(
	authority: EditorMigrationWriterLeaseAuthority,
	windowId: number,
	connection: DisposableStore,
): {
	readonly acquire: (operationId: string) => Promise<boolean>;
	readonly validate: (operationId: string) => Promise<boolean>;
	readonly release: (operationId: string) => Promise<void>;
} {
	let lease: EditorMigrationWriterLease | undefined;
	let disposeLease: (() => void) | undefined;
	return {
		acquire: operationId => {
			if (lease) {
				return Promise.resolve(false);
			}
			const acquired = authority.acquire(windowId, operationId);
			if (!acquired) {
				return Promise.resolve(false);
			}
			lease = acquired;
			const release = connection.add(toDisposable(() => authority.release(acquired)));
			disposeLease = () => release.dispose();
			return Promise.resolve(true);
		},
		validate: operationId => Promise.resolve(
			authority.holds(windowId, operationId) && lease?.operationId === operationId
		),
		release: operationId => {
			if (lease?.operationId === operationId) {
				disposeLease?.();
				disposeLease = undefined;
				lease = undefined;
			}
			return Promise.resolve();
		},
	};
}
