/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IProjectManagerService, ProjectRecord } from '../../../platform/projectManager/common/projectManager.js';
import { IHucodeShellControllerService } from '../../../platform/window/common/hucodeShellControllerService.js';
import { canonicalizeProjectSwitcherTarget } from '../../common/projectSwitcher/switchProjectWorktreeModel.js';
import { pathsEqual } from './projectSwitcherCommon.js';

/** Folder selection and catalog update report cancellation and failure separately. */
export type ProjectSwitcherFolderResult =
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'selected'; readonly folder: URI; readonly project?: ProjectRecord }
	| { readonly kind: 'failed'; readonly error: unknown };

/** Picks a folder and optionally adds its repository, preserving normal command behavior. */
export async function pickProjectSwitcherFolder(
	kind: 'project' | 'workbench',
	fileDialogService: Pick<IFileDialogService, 'showOpenDialog'>,
	projectManagerService: Pick<IProjectManagerService, 'addProject'>,
	shellService: Pick<IHucodeShellControllerService, 'promoteRetainedWorkbenchProjectFolders'>,
	isOmniShell: boolean,
): Promise<ProjectSwitcherFolderResult> {
	try {
		const folders = await fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: kind === 'project' ? localize('addProjectOpenLabel', "Add Project") : localize('addWorkbenchOpenLabel', "Add Workbench"),
			title: kind === 'project' ? localize('addProjectTitle', "Add Git Project") : localize('addWorkbenchTitle', "Open Folder as Workbench"),
		});
		if (!folders?.length) { return { kind: 'cancelled' }; }
		const folder = folders[0];
		if (kind === 'workbench') { return { kind: 'selected', folder }; }
		const project = await projectManagerService.addProject(folder);
		if (isOmniShell) {
			await shellService.promoteRetainedWorkbenchProjectFolders(project.worktrees.map(worktree => ({ projectId: project.id, folderUri: URI.file(worktree.path).toJSON() })));
		}
		return { kind: 'selected', folder, project };
	} catch (error) {
		return { kind: 'failed', error };
	}
}

/** Resolves the picked checkout, then the repository's valid last-active or main worktree. */
export function resolveOnboardingFolderTarget(folder: URI, projects: readonly ProjectRecord[], added?: ProjectRecord): { readonly worktreePath: string; readonly projectId?: string } | undefined {
	const exact = canonicalizeProjectSwitcherTarget({ worktreePath: folder.fsPath }, projects, pathsEqual);
	if (exact.projectId) { return exact; }
	const project = added ? projects.find(candidate => candidate.id === added.id) ?? added : projects.find(candidate => pathsEqual(candidate.rootUri.fsPath, folder.fsPath));
	if (!project) { return exact; }
	const worktree = project.worktrees.find(candidate => pathsEqual(candidate.path, project.lastActiveWorktreePath ?? '')) ?? project.worktrees.find(candidate => candidate.isMain);
	return worktree ? { projectId: project.id, worktreePath: worktree.path } : undefined;
}
