/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
import { whenEditorClosed } from '../../workbench/browser/editor.js';
import {
	IResourceDiffEditorInput,
	IResourceMergeEditorInput,
	isResourceEditorInput,
	IUntitledTextResourceEditorInput,
	IUntypedEditorInput,
	pathsToEditors,
} from '../../workbench/common/editor.js';
import { IEditorService } from
	'../../workbench/services/editor/common/editorService.js';

/**
 * Dependencies needed to open files forwarded into a hosted Omni workbench.
 */
export interface IHostedOmniOpenFilesServices {
	readonly editorService: IEditorService;
	readonly fileService: IFileService;
	readonly instantiationService: IInstantiationService;
	readonly logService: ILogService;
}

/**
 * Opens a native file-open request inside a hosted Omni web workbench.
 */
export async function openHostedOmniFiles(
	request: INativeOpenFileRequest,
	services: IHostedOmniOpenFilesServices
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
		createHostedOmniOpenEditors(inputs, diffMode, mergeMode),
		undefined,
		{ validateTrust: true }
	);
	if (request.filesToWait) {
		if (openedEditorPanes.length) {
			void trackClosedWaitFiles(
				URI.revive(request.filesToWait.waitMarkerFileUri),
				coalesce(request.filesToWait.paths.map(path =>
					URI.revive(path.fileUri)
				)),
				services
			);
		} else {
			await deleteWaitMarker(request, services.fileService);
		}
	}

	return openedEditorPanes.length > 0;
}

/**
 * Converts path-derived editor inputs into normal, diff, or merge open inputs.
 */
export function createHostedOmniOpenEditors(
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
	services: IHostedOmniOpenFilesServices
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
