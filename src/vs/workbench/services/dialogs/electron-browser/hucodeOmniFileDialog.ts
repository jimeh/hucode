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

/** Environment flags used to decide whether folder opens stay in Omni. */
export interface IHucodeOmniFileDialogEnvironment {
	readonly isOmniWindow: boolean;
	readonly isHostedOmniWorkspace?: boolean;
	readonly extensionDevelopmentLocationURI?: readonly URI[];
}

/** Host and dialog operations needed by Omni file-dialog routing. */
export interface IHucodeOmniFileDialogHost {
	showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined>;
	openWindow(
		openables: IWindowOpenable[],
		options?: IOpenWindowOptions
	): Promise<void>;
}

/** Host operations needed by the Omni file-or-folder picker route. */
export interface IHucodeOmniFileFolderDialogHost
	extends IHucodeOmniFileDialogHost {
	isDirectory(resource: URI): Promise<boolean>;
	openFiles(resources: readonly URI[]): Promise<void>;
}

/**
 * Selects a local file or folder without allowing a folder selection to
 * replace the Omni shell.
 *
 * @returns Whether the native file-or-folder path was handled, including
 * cancel.
 */
export async function tryPickHucodeOmniFileFolderAndOpen(
	schema: string,
	options: IPickAndOpenOptions,
	environment: IHucodeOmniFileDialogEnvironment,
	host: IHucodeOmniFileFolderDialogHost,
): Promise<boolean> {
	if (!shouldHandleHucodeOmniOpen(schema, options, environment)) {
		return false;
	}

	const resources = await host.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: true,
		canSelectMany: true,
		defaultUri: options.defaultUri,
		title: localize('openFileOrFolder.title', "Open File or Folder"),
	});
	if (resources?.length) {
		const files: URI[] = [];
		const folders: URI[] = [];
		for (const resource of resources) {
			const isDirectory = await host.isDirectory(resource);
			(isDirectory ? folders : files).push(resource);
		}

		if (files.length) {
			await host.openFiles(files);
		}
		for (const folder of folders) {
			await host.openWindow(
				[{ folderUri: folder }],
				{ remoteAuthority: options.remoteAuthority }
			);
		}
	}

	return true;
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
	if (!shouldHandleHucodeOmniOpen(schema, options, environment)) {
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

/** Determines whether a local open request should stay in the Omni shell. */
function shouldHandleHucodeOmniOpen(
	schema: string,
	options: IPickAndOpenOptions,
	environment: IHucodeOmniFileDialogEnvironment,
): boolean {
	return schema === Schemas.file &&
		!options.forceNewWindow &&
		(environment.isOmniWindow || !!environment.isHostedOmniWorkspace) &&
		!environment.extensionDevelopmentLocationURI;
}
