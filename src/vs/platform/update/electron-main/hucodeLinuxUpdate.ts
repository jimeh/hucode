/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Action supported by Hucode's notification-only Linux updater. */
export interface IHucodeLinuxUpdateAction {
	readonly kind: 'openExternal';
	readonly url: string;
}

/**
 * Resolves the manual download action for an available Linux update.
 */
export function getHucodeLinuxUpdateAction(
	downloadPageUrl: string | undefined,
	updateUrl: string | undefined
): IHucodeLinuxUpdateAction | undefined {
	const url = downloadPageUrl?.trim() || updateUrl?.trim();
	return url ? { kind: 'openExternal', url } : undefined;
}
