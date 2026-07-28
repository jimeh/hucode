/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	IProjectManagerService,
	ProjectRecord,
} from '../../../platform/projectManager/common/projectManager.js';
import type { IHucodeShellService } from '../../common/omniWindow.js';

export interface IRemoveProjectRouting {
	readonly isOmniWindow: boolean;
	readonly windowId: number;
}

/**
 * Removes a project after confirming it still exists and the user wants to
 * remove it. In the current Omni window, non-active workbenches are closed
 * concurrently before the snapshot-active workbench is closed last.
 */
export async function removeProjectWithHostedWorkbenchCleanup(
	projectId: string,
	routing: IRemoveProjectRouting,
	projectManagerService: Pick<
		IProjectManagerService,
		'getProjects' | 'removeProject'
	>,
	shellService: Pick<
		IHucodeShellService,
		'getWindowState' | 'closeWorkspace'
	>,
	confirmRemoval: (project: ProjectRecord) => Promise<boolean>
): Promise<void> {
	const projects = await projectManagerService.getProjects();
	const project = projects.find(entry => entry.id === projectId);
	if (!project || !await confirmRemoval(project)) {
		return;
	}

	if (routing.isOmniWindow) {
		const state = await shellService.getWindowState(routing.windowId);
		const matches = state.instances.filter(instance =>
			instance.projectId === projectId
		);
		const active = matches.find(instance =>
			instance.instanceId === state.activeInstanceId
		);
		// Non-active workbenches close independently. Start those attempts
		// together so one slow handshake does not multiply the wait, then close
		// the snapshot-active workbench last because closing it activates a
		// sibling and can supersede that sibling's in-flight close.
		await Promise.allSettled(matches
			.filter(instance => instance !== active)
			.map(instance => shellService.closeWorkspace(
				routing.windowId,
				instance.instanceId
			)));
		if (active) {
			await Promise.allSettled([
				shellService.closeWorkspace(
					routing.windowId,
					active.instanceId
				),
			]);
		}
	}

	await projectManagerService.removeProject(projectId);
}
