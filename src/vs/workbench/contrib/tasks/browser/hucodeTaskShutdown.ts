/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { ILifecycleService, ShutdownReason } from '../../../services/lifecycle/common/lifecycle.js';
import { TaskEventKind } from '../common/tasks.js';

export const enum PersistentTaskAction {
	None,
	Save,
	Remove,
}

/**
 * Tracks only committed shutdowns so a vetoed preparation cannot alter task
 * reconnection bookkeeping in the still-running workbench.
 */
export class TaskShutdownState extends Disposable {
	private shutdownReason: ShutdownReason | undefined;

	constructor(private readonly lifecycleService: ILifecycleService) {
		super();
		this._register(lifecycleService.onBeforeShutdown(event => {
			this.shutdownReason = event.reason;
		}));
	}

	getPersistentTaskAction(
		kind: TaskEventKind,
		exitReason: TerminalExitReason | undefined,
		hasTaskId: boolean
	): PersistentTaskAction {
		const willRestart = this.lifecycleService.willShutdown &&
			this.shutdownReason !== ShutdownReason.RELOAD;
		if (
			hasTaskId &&
			(willRestart ||
				(kind === TaskEventKind.Terminated &&
					exitReason === TerminalExitReason.User))
		) {
			return PersistentTaskAction.Remove;
		}

		return kind === TaskEventKind.Start ?
			PersistentTaskAction.Save :
			PersistentTaskAction.None;
	}
}
