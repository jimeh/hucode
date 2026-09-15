/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Details, Event as ElectronEvent } from 'electron';

export interface IUtilityProcessCrashHandler {
	handleUtilityProcessCrash(details: Details): void;
}

export class UtilityProcessCrashRegistry {

	private readonly handlers = new Map<string, IUtilityProcessCrashHandler>();
	private listenerRegistered = false;

	constructor(
		private readonly registerListener: (
			listener: (event: ElectronEvent, details: Details) => void
		) => void
	) { }

	register(serviceName: string, handler: IUtilityProcessCrashHandler): void {
		this.handlers.set(serviceName, handler);
		this.ensureListener();
	}

	unregister(serviceName: string): void {
		this.handlers.delete(serviceName);
	}

	handleChildProcessGone(_event: ElectronEvent, details: Details): void {
		if (details.type !== 'Utility') {
			return;
		}

		if (typeof details.name !== 'string') {
			return;
		}

		this.handlers.get(details.name)?.handleUtilityProcessCrash(details);
	}

	get size(): number {
		return this.handlers.size;
	}

	private ensureListener(): void {
		if (this.listenerRegistered) {
			return;
		}

		this.listenerRegistered = true;
		this.registerListener((event, details) =>
			this.handleChildProcessGone(event, details));
	}
}
