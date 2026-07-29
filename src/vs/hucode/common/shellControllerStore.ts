/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../base/common/event.js';
import {
	Disposable,
	DisposableMap,
	IDisposable,
} from '../../base/common/lifecycle.js';

export interface IShellControllerHost {
	readonly isOmniWindow?: boolean;
}

/**
 * Lazily owns one disposable shell controller per window. Removing entries
 * through the map avoids retaining disposed controllers for the store's
 * lifetime.
 */
export class ShellControllerStore<
	THost extends IShellControllerHost,
	T extends IDisposable
> extends Disposable {
	private readonly controllers = this._register(
		new DisposableMap<number, T>()
	);

	constructor(
		private readonly getWindowById: (
			windowId: number
		) => THost | undefined,
		private readonly createController: (
			windowId: number,
			host: THost
		) => T,
		onDidDestroyWindow: Event<number>
	) {
		super();

		this._register(onDidDestroyWindow(windowId => {
			this.controllers.deleteAndDispose(windowId);
		}));
	}

	get(windowId: number): T | undefined {
		return this.controllers.get(windowId);
	}

	getOrCreate(windowId: number): T {
		const existing = this.controllers.get(windowId);
		if (existing) {
			return existing;
		}

		const host = this.getWindowById(windowId);
		if (!host?.isOmniWindow) {
			throw new Error(`Window ${windowId} is not a Hucode Omni-window.`);
		}

		const controller = this.createController(windowId, host);
		this.controllers.set(windowId, controller);
		return controller;
	}

}
