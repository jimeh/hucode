/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { EditorMigrationFlowState } from './editorMigrationFlow.js';

/** The part of the session this coordinator is allowed to touch. */
export interface EditorMigrationCancellableSession {
	readonly state: EditorMigrationFlowState;
	requestCancellation(): void;
}

/**
 * True when closing the import surface should ask the session to cancel.
 *
 * Only an admitted Apply has anything to cancel. Every other phase is a plain choice screen whose
 * state the session keeps regardless, so closing it must not disturb anything.
 */
export function shouldCancelEditorMigrationOnClose(state: EditorMigrationFlowState): boolean {
	return state.phase === 'apply';
}

/**
 * Asks the session to cancel when the import surface is genuinely closed.
 *
 * The signal has to be the editor input's own disposal, not the pane's `clearInput`. `clearInput`
 * also fires when the pane merely hides or is reused, and the singleton input is routinely hidden
 * and reshown; cancelling there would abort an in-flight Apply for a view change. Renderer loss
 * does not reach this path at all: a dead webview is a presentation failure, and the session and
 * journal keep the admitted operation so reopening reconstructs it.
 */
export function bindEditorMigrationCloseCancellation(
	session: EditorMigrationCancellableSession,
	onWillClose: Event<void>,
): IDisposable {
	const listener = onWillClose(() => {
		if (shouldCancelEditorMigrationOnClose(session.state)) {
			session.requestCancellation();
		}
	});
	return toDisposable(() => listener.dispose());
}
