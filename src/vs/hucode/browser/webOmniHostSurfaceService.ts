/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { createDecorator } from
	'../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from
	'../../platform/instantiation/common/extensions.js';

export const IHucodeWebOmniHostSurfaceService =
	createDecorator<IHucodeWebOmniHostSurfaceService>(
		'hucodeWebOmniHostSurfaceService'
	);

/**
 * Shares the Omni host DOM surface with browser iframe adapters.
 */
export interface IHucodeWebOmniHostSurfaceService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSurface: Event<HTMLElement | undefined>;
	getSurface(): HTMLElement | undefined;
	setSurface(surface: HTMLElement | undefined): void;
}

/**
 * Browser service that exposes the Omni host surface to iframe adapters.
 */
export class HucodeWebOmniHostSurfaceService
	extends Disposable
	implements IHucodeWebOmniHostSurfaceService {

	declare readonly _serviceBrand: undefined;

	private surface: HTMLElement | undefined;
	private readonly _onDidChangeSurface =
		this._register(new Emitter<HTMLElement | undefined>());
	readonly onDidChangeSurface = this._onDidChangeSurface.event;

	getSurface(): HTMLElement | undefined {
		return this.surface;
	}

	setSurface(surface: HTMLElement | undefined): void {
		if (surface === this.surface) {
			return;
		}

		this.surface = surface;
		this._onDidChangeSurface.fire(surface);
	}
}

registerSingleton(
	IHucodeWebOmniHostSurfaceService,
	HucodeWebOmniHostSurfaceService,
	InstantiationType.Delayed
);
