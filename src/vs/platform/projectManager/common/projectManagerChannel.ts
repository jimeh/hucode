/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IProjectManagerService } from './projectManager.js';

/**
 * Creates the desktop main-process channel for the project manager.
 *
 * `ProxyChannel.fromService` buffers events until their first IPC listener and
 * replays them only to that listener. No desktop consumer depends on that
 * replay: renderers fetch initial state through `getProjects` and
 * `setGitWorktreeTargets`, and the Omni shell main service consumes catalog
 * changes in-process. Buffering would instead retain every payload for an
 * event no renderer subscribes to, such as catalog snapshots, or project
 * changes in a session without an Omni window.
 */
export function createProjectManagerChannel(
	service: IProjectManagerService,
	disposables: DisposableStore
): IServerChannel {
	return ProxyChannel.fromService(service, disposables, {
		unbufferedEvents: [
			'onDidChangeProjects',
			'onDidChangeCatalog',
			'onDidChangeGitWorktreeTargets',
		] satisfies (keyof IProjectManagerService)[]
	});
}
