/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
	EditorMigrationSetupHostMessage,
	EditorMigrationSetupIntent,
	EditorMigrationSetupPresentation,
	parseEditorMigrationSetupHostMessage,
} from '@/generated/editorMigrationSetupProtocol';

export interface SetupHostState {
	/** Latest snapshot, or `undefined` until the host answers the renderer's `ready`. */
	readonly presentation: EditorMigrationSetupPresentation | undefined;
	/** Recoverable host error, cleared by the next snapshot. */
	readonly hostError: string | undefined;
	/** Focus target the host asked for, consumed once. */
	readonly focusRequest: { readonly focusId: string; readonly revision: number } | undefined;
	readonly disposed: boolean;
}

const EMPTY: SetupHostState = { presentation: undefined, hostError: undefined, focusRequest: undefined, disposed: false };

/**
 * Holds the authoritative snapshot outside React.
 *
 * Migration state belongs to the core session. This store only mirrors the latest immutable
 * snapshot and forwards intents, so React owns nothing but local presentation state.
 */
export class SetupHost {
	private state: SetupHostState = EMPTY;
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly post: (message: unknown) => void,
		addMessageListener: (listener: (message: unknown) => void) => () => void,
	) {
		this.dispose = addMessageListener(message => this.receive(message));
	}

	readonly dispose: () => void;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): SetupHostState => this.state;

	/** Announces the renderer is mounted. The host answers with the current full snapshot. */
	ready(): void {
		this.post({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 0, intent: { type: 'ready' } });
	}

	/** Sends one intent, stamped with the snapshot the user was looking at. */
	send(intent: EditorMigrationSetupIntent): void {
		this.post({
			protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
			revision: this.state.presentation?.revision ?? 0,
			intent,
		});
	}

	private receive(raw: unknown): void {
		const message = parseEditorMigrationSetupHostMessage(raw);
		if (!message) {
			return;
		}
		const next = applyHostMessage(this.state, message);
		if (next === this.state) {
			return;
		}
		this.state = next;
		for (const listener of this.listeners) {
			listener();
		}
	}
}

/** Pure reducer over host messages, so the transition is testable without a webview. */
export function applyHostMessage(state: SetupHostState, message: EditorMigrationSetupHostMessage): SetupHostState {
	switch (message.type) {
		case 'state':
			return { ...state, presentation: message.presentation, hostError: undefined };
		case 'error':
			return { ...state, hostError: message.message };
		case 'focus':
			return { ...state, focusRequest: { focusId: message.focusId, revision: message.revision } };
		case 'disposed':
			return { ...state, disposed: true };
		case 'accepted':
			return state;
	}
}

/** Binds the store to the real webview bridge. */
export function createSetupHost(): SetupHost {
	const api = acquireVsCodeApi();
	return new SetupHost(
		message => api.postMessage(message),
		listener => {
			const handler = (event: MessageEvent) => listener(event.data);
			window.addEventListener('message', handler);
			return () => window.removeEventListener('message', handler);
		},
	);
}
