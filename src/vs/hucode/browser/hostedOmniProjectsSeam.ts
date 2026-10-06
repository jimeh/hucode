/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/hostedOmniProjectsSeam.css';

const PROJECTS_VISIBLE_CLASS = 'hucode-omni-projects-visible';

/**
 * Marks a hosted workbench container while the Omni shell shows its Projects
 * sidebar, so the hosted status bar can continue the seam between them.
 */
export function updateHostedOmniProjectsSeam(
	container: HTMLElement,
	projectsSidebarVisible: boolean
): void {
	container.classList.toggle(PROJECTS_VISIBLE_CLASS, projectsSidebarVisible);
}
