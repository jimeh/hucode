/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../base/common/arrays.js';
import { URI } from '../../base/common/uri.js';
import { IResourceEditorInput } from
	'../../platform/editor/common/editor.js';
import { IFileService } from '../../platform/files/common/files.js';
import { IInstantiationService } from
	'../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';
import { INativeOpenFileRequest } from
	'../../platform/window/common/window.js';
import { whenEditorClosed } from './editor.js';
import {
	IResourceDiffEditorInput,
	IResourceMergeEditorInput,
	isResourceEditorInput,
	IUntitledTextResourceEditorInput,
	IUntypedEditorInput,
	pathsToEditors,
} from '../common/editor.js';
import { IEditorService } from
	'../services/editor/common/editorService.js';

type IHucodeOpenFilesInstantiationService =
	Pick<IInstantiationService, 'invokeFunction'>;

/**
 * Dependencies needed to open a forwarded file-open request.
 */
export interface IHucodeOpenFilesRequestServices {
	readonly editorService: Pick<IEditorService, 'openEditors'>;
	readonly fileService: IFileService;
	readonly instantiationService: IHucodeOpenFilesInstantiationService;
	readonly logService: ILogService;
}

/**
 * Opens a `vscode:openFiles` request in the running workbench.
 *
 * Shared by the desktop `NativeWindow` IPC handler and the hosted Omni web
 * bridge so both platforms use the same diff/merge/wait-marker handling.
 * Wait-marker tracking is started in the background; the returned promise
 * only reflects whether editors were opened.
 */
export async function openHucodeFilesRequest(
	request: INativeOpenFileRequest,
	services: IHucodeOpenFilesRequestServices
): Promise<boolean> {
	const diffMode = !!(request.filesToDiff?.length === 2);
	const mergeMode = !!(request.filesToMerge?.length === 4);
	const paths = mergeMode
		? request.filesToMerge
		: diffMode
			? request.filesToDiff
			: request.filesToOpenOrCreate;
	const inputs = coalesce(await pathsToEditors(
		paths,
		services.fileService,
		services.logService
	));
	if (!inputs.length) {
		await deleteWaitMarker(request, services.fileService);
		return false;
	}

	const openedEditorPanes = await services.editorService.openEditors(
		createHucodeOpenFileEditors(inputs, diffMode, mergeMode),
		undefined,
		{ validateTrust: true }
	);
	if (request.filesToWait) {

		// In wait mode, listen to changes to the editors and wait until the
		// files are closed that the user wants to wait for. When this happens
		// we delete the wait marker file to signal to the outside that editing
		// is done. However, it is possible that opening of the editors failed,
		// as such we check for whether editor panes got opened and otherwise
		// delete the marker right away.

		if (openedEditorPanes.length) {
			void trackClosedWaitFiles(
				URI.revive(request.filesToWait.waitMarkerFileUri),
				coalesce(request.filesToWait.paths.map(path =>
					URI.revive(path.fileUri)
				)),
				services
			).catch(error => services.logService.error(error));
		} else {
			await deleteWaitMarker(request, services.fileService);
		}
	}

	return openedEditorPanes.length > 0;
}

/**
 * Converts path-derived editor inputs into normal, diff, or merge open inputs.
 */
export function createHucodeOpenFileEditors(
	resources: Array<IResourceEditorInput | IUntitledTextResourceEditorInput>,
	diffMode: boolean,
	mergeMode: boolean
): IUntypedEditorInput[] {
	const editors: IUntypedEditorInput[] = [];

	if (
		mergeMode &&
		isResourceEditorInput(resources[0]) &&
		isResourceEditorInput(resources[1]) &&
		isResourceEditorInput(resources[2]) &&
		isResourceEditorInput(resources[3])
	) {
		const mergeEditor: IResourceMergeEditorInput = {
			input1: { resource: resources[0].resource },
			input2: { resource: resources[1].resource },
			base: { resource: resources[2].resource },
			result: { resource: resources[3].resource },
			options: { pinned: true },
		};
		editors.push(mergeEditor);
	} else if (
		diffMode &&
		isResourceEditorInput(resources[0]) &&
		isResourceEditorInput(resources[1])
	) {
		const diffEditor: IResourceDiffEditorInput = {
			original: { resource: resources[0].resource },
			modified: { resource: resources[1].resource },
			options: { pinned: true },
		};
		editors.push(diffEditor);
	} else {
		editors.push(...resources);
	}

	return editors;
}

async function trackClosedWaitFiles(
	waitMarkerFile: URI,
	resourcesToWaitFor: URI[],
	services: IHucodeOpenFilesRequestServices
): Promise<void> {
	await services.instantiationService.invokeFunction(accessor =>
		whenEditorClosed(accessor, resourcesToWaitFor)
	);
	await services.fileService.del(waitMarkerFile);
}

async function deleteWaitMarker(
	request: INativeOpenFileRequest,
	fileService: IFileService
): Promise<void> {
	if (request.filesToWait) {
		await fileService.del(URI.revive(
			request.filesToWait.waitMarkerFileUri
		));
	}
}
