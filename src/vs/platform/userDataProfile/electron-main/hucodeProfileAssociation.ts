/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAnyWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { IUserDataProfilesMainService } from './userDataProfile.js';

/** Compares and saves one folder association while its caller holds the owner reservation. */
export async function setHucodeProfileForWorkspace(
	profiles: Pick<IUserDataProfilesMainService, 'profiles' | 'getProfileForWorkspace' | 'setProfileForWorkspace' | 'unsetWorkspace'>,
	workspace: IAnyWorkspaceIdentifier,
	profileId: string | undefined,
	expectedProfileId: string | undefined,
	flush: ((matches: (persisted: unknown) => boolean) => Promise<void>) | undefined,
): Promise<boolean> {
	if (!isSingleFolderWorkspaceIdentifier(workspace)) { throw new Error('Onboarding associations require an exact folder.'); }
	const matches = (expected: string | undefined) => (persisted: unknown): boolean => {
		if (persisted === undefined) { return expected === undefined; }
		if (typeof persisted !== 'object' || persisted === null) { return false; }
		const workspaces = (persisted as { workspaces?: Record<string, string> }).workspaces;
		return workspaces?.[workspace.uri.toString()] === expected;
	};
	const previous = profiles.getProfileForWorkspace(workspace);
	if (previous?.id !== expectedProfileId) { return false; }
	if (profileId === undefined) { return true; }
	const profile = profiles.profiles.find(candidate => candidate.id === profileId && !candidate.isDefault && !candidate.isTransient && !candidate.isAgentsWindowProfile);
	if (!profile) { return false; }
	if (!flush) { throw new Error('Acknowledged profile persistence is unavailable.'); }
	try {
		await profiles.setProfileForWorkspace(workspace, profile);
		await flush(matches(profileId));
		return profiles.getProfileForWorkspace(workspace)?.id === profileId;
	} catch (error) {
		if (profiles.getProfileForWorkspace(workspace)?.id === profileId) {
			if (previous) { await profiles.setProfileForWorkspace(workspace, previous); }
			else { profiles.unsetWorkspace(workspace); }
			// Drain any buffered failed save using the restored association. Its error must
			// remain visible, while the live profile service already has the prior value.
			try { await flush(matches(previous?.id)); } catch { /* Preserve the original failure. */ }
		}
		throw error;
	}
}
