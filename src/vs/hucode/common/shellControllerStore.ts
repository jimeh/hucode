/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Disposable,
	DisposableMap,
	IDisposable,
} from '../../base/common/lifecycle.js';

/**
 * Lazily owns one disposable shell controller per window. Removing entries
 * through the map avoids retaining disposed controllers for the store's
 * lifetime.
 */
export class ShellControllerStore<T extends IDisposable> extends Disposable {
	private readonly controllers = this._register(
		new DisposableMap<number, T>()
	);

	constructor(
		private readonly createController: (windowId: number) => T
	) {
		super();
	}

	get(windowId: number): T | undefined {
		return this.controllers.get(windowId);
	}

	getOrCreate(windowId: number): T {
		const existing = this.controllers.get(windowId);
		if (existing) {
			return existing;
		}

		const controller = this.createController(windowId);
		this.controllers.set(windowId, controller);
		return controller;
	}

	deleteAndDispose(windowId: number): void {
		this.controllers.deleteAndDispose(windowId);
	}
}
