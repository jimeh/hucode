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
 * remove it.
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
		// Workbenches close independently. Start every attempt together so one
		// slow handshake does not multiply the wait, and let every attempt
		// settle so one failed close cannot strand its siblings.
		await Promise.allSettled(state.instances
			.filter(instance => instance.projectId === projectId)
			.map(instance => shellService.closeWorkspace(
				routing.windowId,
				instance.instanceId
			)));
	}

	await projectManagerService.removeProject(projectId);
}
