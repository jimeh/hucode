/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IHucodeHostedWorkspaceState
} from './omniWindow.js';

/**
 * Operations needed to reopen a hosted workspace normally.
 */
export interface IHucodeHostedWorkspaceReopenDelegate {
	getState(): IHucodeHostedWorkspaceState;
	closeWorkspace(instanceId: string):
		Promise<IHucodeHostedWorkspaceCloseResult> |
		IHucodeHostedWorkspaceCloseResult;
	focusNormalWindowByPath(worktreePath: string): Promise<boolean>;
	openNormalWindow(worktreePath: string): Promise<void> | void;
}

/** Result of this reopen operation's own irreversible hosted close. */
export interface IHucodeHostedWorkspaceCloseResult {
	readonly committed: boolean;
}

/**
 * Closes a hosted workspace before focusing or opening its normal window.
 */
export async function reopenHucodeHostedWorkspaceInNormalWindow(
	delegate: IHucodeHostedWorkspaceReopenDelegate,
	instanceId: string
): Promise<boolean> {
	const instance = delegate.getState().instances.find(candidate =>
		candidate.instanceId === instanceId
	);
	if (
		!instance ||
		instance.state === 'crashed' ||
		instance.state === 'unloaded'
	) {
		return false;
	}

	const worktreePath = instance.worktreePath;
	const closeResult = await delegate.closeWorkspace(instanceId);
	if (!closeResult.committed) {
		return false;
	}

	if (await delegate.focusNormalWindowByPath(worktreePath)) {
		return true;
	}

	await delegate.openNormalWindow(worktreePath);
	return true;
}
