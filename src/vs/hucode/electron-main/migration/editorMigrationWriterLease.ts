/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
