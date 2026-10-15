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
 * Catalog snapshots are consumed in-process by the Omni shell main service and
 * have no desktop IPC subscriber, so buffering them until a first listener
 * would retain every snapshot for the lifetime of the app.
 */
export function createProjectManagerChannel(
	service: IProjectManagerService,
	disposables: DisposableStore
): IServerChannel {
	return ProxyChannel.fromService(service, disposables, {
		unbufferedEvents: [
			'onDidChangeCatalog',
		] satisfies (keyof IProjectManagerService)[]
	});
}
