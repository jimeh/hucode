/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IHucodeDefaultStartupWindowPath {
	readonly isOmniWindow: true;
}

export interface IHucodeDefaultStartupWindowOptions {
	readonly initialStartup?: boolean;
	readonly hasRestorableWindows?: boolean;
}

/**
 * Returns the Hucode default startup window when there is no session or path to
 * restore.
 */
export function getHucodeDefaultStartupWindowPath(
	options: IHucodeDefaultStartupWindowOptions
): IHucodeDefaultStartupWindowPath | undefined {
	if (!options.initialStartup || options.hasRestorableWindows) {
		return undefined;
	}

	return { isOmniWindow: true };
}
