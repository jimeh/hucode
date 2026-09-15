/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { URI } from '../../../base/common/uri.js';
import { ISingleFolderWorkspaceIdentifier } from '../../../platform/workspace/common/workspace.js';
import { getSingleFolderWorkspaceIdentifier } from '../../../platform/workspaces/node/workspaces.js';

/** Local workspace IDs include filesystem identity, matching ordinary native window creation. */
export async function resolveOnboardingWorkspaceIdentifier(worktreePath: string): Promise<ISingleFolderWorkspaceIdentifier> {
	const stat = await fs.stat(worktreePath);
	if (!stat.isDirectory()) {
		throw new Error('The selected folder is unavailable.');
	}
	return getSingleFolderWorkspaceIdentifier(URI.file(worktreePath), stat);
}

/** Routing may retry creation; a committed association must not compare against its old value again. */
export function createOnboardingAssociationCommit(save: () => Promise<void>): () => Promise<void> {
	let committed = false;
	return async () => {
		if (committed) { return; }
		await save();
		committed = true;
	};
}
