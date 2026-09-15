/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	DisposableMap,
	IDisposable,
	toDisposable,
} from '../../base/common/lifecycle.js';
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

/** Disposes a bound shell port only when its owning main frame goes away. */
export function registerHucodeShellControllerOwnerLifecycle(
	webContents: Electron.WebContents,
	disposeConnection: () => void
): IDisposable {
	const onDidStartLoading = () => {
		if (webContents.isLoadingMainFrame()) {
			disposeConnection();
		}
	};
	webContents.on('did-start-loading', onDidStartLoading);
	webContents.on('render-process-gone', disposeConnection);
	webContents.on('destroyed', disposeConnection);
	return toDisposable(() => {
		webContents.removeListener('did-start-loading', onDidStartLoading);
		webContents.removeListener('render-process-gone', disposeConnection);
		webContents.removeListener('destroyed', disposeConnection);
	});
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
	// Independently verify the identity returned by the injected resolver so a
	// weakened resolver cannot widen admission.
	if (!owner || owner.webContentsId !== sender.id) {
		dependencies.logRefusal('unknown or non-owner sender');
		postShellControllerPortDenial(sender, nonce, dependencies.logFailure);
		return false;
	}

	let connectionStored = false;
	try {
		const connection = dependencies.createConnection(owner);
		dependencies.connections.set(owner.windowId, connection);
		connectionStored = true;
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
		if (connectionStored) {
			dependencies.connections.deleteAndDispose(owner.windowId);
		}
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
