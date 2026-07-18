/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	IOpenDialogOptions,
	IPickAndOpenOptions,
} from '../../../../platform/dialogs/common/dialogs.js';
import { IWindowOpenable, IOpenWindowOptions } from
	'../../../../platform/window/common/window.js';

/** Environment flags used to decide whether Open Folder stays in Omni. */
export interface IHucodeOmniFileDialogEnvironment {
	readonly isOmniWindow: boolean;
	readonly isHostedOmniWorkspace?: boolean;
	readonly extensionDevelopmentLocationURI?: readonly URI[];
}

/** Host and dialog operations needed by the Omni folder-picker route. */
export interface IHucodeOmniFileDialogHost {
	showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined>;
	openWindow(
		openables: IWindowOpenable[],
		options?: IOpenWindowOptions
	): Promise<void>;
}

/**
 * Selects a local folder and routes it through the existing Omni open
 * interceptor when the active renderer belongs to an Omni window.
 *
 * @returns Whether the native folder-open path was handled, including cancel.
 */
export async function tryPickHucodeOmniFolderAndOpen(
	schema: string,
	options: IPickAndOpenOptions,
	environment: IHucodeOmniFileDialogEnvironment,
	host: IHucodeOmniFileDialogHost,
): Promise<boolean> {
	if (schema !== Schemas.file || options.forceNewWindow ||
		(!environment.isOmniWindow && !environment.isHostedOmniWorkspace) ||
		environment.extensionDevelopmentLocationURI
	) {
		return false;
	}

	const folders = await host.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		defaultUri: options.defaultUri,
		title: localize('openFolder.title', 'Open Folder'),
	});
	if (folders?.[0]) {
		await host.openWindow(
			[{ folderUri: folders[0] }],
			{ remoteAuthority: options.remoteAuthority }
		);
	}

	return true;
}
