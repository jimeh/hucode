/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IBrowserViewBounds } from './browserView.js';

export interface IBrowserViewHostOffset {
	readonly x: number;
	readonly y: number;
}

export interface IBrowserViewWindowBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Converts renderer-relative browser editor bounds into Electron window bounds.
 */
export function toBrowserViewWindowBounds(
	bounds: IBrowserViewBounds,
	hostOffset?: IBrowserViewHostOffset
): IBrowserViewWindowBounds {
	return {
		x: Math.round(bounds.x * bounds.zoomFactor) + (hostOffset?.x ?? 0),
		y: Math.round(bounds.y * bounds.zoomFactor) + (hostOffset?.y ?? 0),
		width: Math.round(bounds.width * bounds.zoomFactor),
		height: Math.round(bounds.height * bounds.zoomFactor),
	};
}
