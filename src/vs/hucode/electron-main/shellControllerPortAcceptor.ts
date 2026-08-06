/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableMap, IDisposable } from '../../base/common/lifecycle.js';
import { HUCODE_SHELL_CONTROLLER_PORT_RESPONSE_CHANNEL } from
	'../../platform/window/common/hucodeShellControllerService.js';

export interface IHucodeShellControllerPortOwner {
	readonly windowId: number;
	readonly webContentsId: number;
}

export interface IHucodeShellControllerPortConnection extends IDisposable {
	readonly transferPort: Electron.MessagePortMain;
	markTransferred(): void;
}

interface IHucodeShellControllerPortRequestDependencies {
	readonly resolveOwner: (
		sender: Electron.WebContents
	) => IHucodeShellControllerPortOwner | undefined;
	readonly connections: DisposableMap<number>;
	readonly createConnection: (
		owner: IHucodeShellControllerPortOwner
	) => IHucodeShellControllerPortConnection;
	readonly logRefusal: (reason: string) => void;
	readonly logFailure: (error: unknown) => void;
}

/** Accepts a privileged shell port only for the exact owning WebContents. */
export function acceptHucodeShellControllerPortRequest(
	dependencies: IHucodeShellControllerPortRequestDependencies,
	event: Pick<Electron.IpcMainEvent, 'sender'>,
	nonce: unknown
): boolean {
	const sender = event.sender;
	if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) {
		dependencies.logRefusal('invalid nonce');
		return false;
	}
	if (sender.isDestroyed()) {
		dependencies.logRefusal('destroyed sender');
		return false;
	}

	const owner = dependencies.resolveOwner(sender);
	if (!owner || owner.webContentsId !== sender.id) {
		dependencies.logRefusal('unknown or non-owner sender');
		postShellControllerPortDenial(sender, nonce, dependencies.logFailure);
		return false;
	}

	try {
		const connection = dependencies.createConnection(owner);
		dependencies.connections.set(owner.windowId, connection);
		const currentOwner = dependencies.resolveOwner(sender);
		if (sender.isDestroyed() ||
			currentOwner?.windowId !== owner.windowId ||
			currentOwner.webContentsId !== owner.webContentsId) {
			throw new Error('Omni shell renderer was replaced during port setup.');
		}
		sender.postMessage(
			HUCODE_SHELL_CONTROLLER_PORT_RESPONSE_CHANNEL,
			nonce,
			[connection.transferPort]
		);
		connection.markTransferred();
		return true;
	} catch (error) {
		dependencies.connections.deleteAndDispose(owner.windowId);
		dependencies.logFailure(error);
		postShellControllerPortDenial(sender, nonce, dependencies.logFailure);
		return false;
	}
}

function postShellControllerPortDenial(
	sender: Electron.WebContents,
	nonce: string,
	logFailure: (error: unknown) => void
): void {
	if (sender.isDestroyed()) {
		return;
	}
	try {
		sender.postMessage(
			HUCODE_SHELL_CONTROLLER_PORT_RESPONSE_CHANNEL,
			nonce,
			[]
		);
	} catch (error) {
		logFailure(error);
	}
}
