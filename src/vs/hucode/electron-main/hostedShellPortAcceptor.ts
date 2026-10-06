/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	DisposableMap,
	IDisposable,
	toDisposable,
} from '../../base/common/lifecycle.js';
import {
	HUCODE_HOSTED_SHELL_PORT_RESPONSE_CHANNEL,
	IHucodeHostedShellBinding,
} from '../../platform/window/common/hucodeHostedShellService.js';

interface IHucodeHostedShellPortOwner {
	readonly windowId: number;
	readonly instanceId: string;
}

export interface IHucodeHostedShellPortController {
	acquireHostedShellBinding(
		webContentsId: number
	): IHucodeHostedShellBinding | undefined;
	releaseHostedShellBinding(binding: IHucodeHostedShellBinding): void;
}

export interface IHucodeHostedShellPortConnection extends IDisposable {
	readonly transferPort: Electron.MessagePortMain;
	markTransferred(): void;
}

interface IHucodeHostedShellPortCloseSource {
	on(event: 'close', listener: () => void): unknown;
	removeListener(event: 'close', listener: () => void): unknown;
}

/** Releases a binding once when its remote MessagePort closes. */
export function bindHucodeHostedShellPortLifetime(
	port: IHucodeHostedShellPortCloseSource,
	releaseBinding: () => void
): IDisposable {
	let released = false;
	const onClose = (): void => {
		if (released) {
			return;
		}
		released = true;
		port.removeListener('close', onClose);
		releaseBinding();
	};
	port.on('close', onClose);
	return toDisposable(() => port.removeListener('close', onClose));
}

interface IHucodeHostedShellPortRequestDependencies<
	TController extends IHucodeHostedShellPortController
> {
	readonly ownersByWebContentsId:
	ReadonlyMap<number, IHucodeHostedShellPortOwner>;
	readonly getController: (windowId: number) => TController | undefined;
	readonly connections: DisposableMap<number>;
	readonly createConnection: (
		controller: TController,
		binding: IHucodeHostedShellBinding
	) => IHucodeHostedShellPortConnection;
	readonly logRefusal: (reason: string) => void;
	readonly logFailure: (error: unknown) => void;
}

/**
 * Accepts a desktop hosted-shell port request using only authority derived from
 * the sending WebContents.
 */
export function acceptHucodeHostedShellPortRequest<
	TController extends IHucodeHostedShellPortController
>(
	dependencies: IHucodeHostedShellPortRequestDependencies<TController>,
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

	const webContentsId = sender.id;
	const owner = dependencies.ownersByWebContentsId.get(webContentsId);
	const controller = owner
		? dependencies.getController(owner.windowId)
		: undefined;
	if (!owner || !controller) {
		dependencies.logRefusal(owner ? 'missing controller' : 'unknown sender');
		postHostedShellPortDenial(sender, nonce, dependencies.logFailure);
		return false;
	}

	// Acquisition deliberately invalidates the prior binding and connection so
	// replacement setup cannot leave two usable generations. Failure below is
	// fail-closed and the renderer must retry acquisition.
	const binding = controller.acquireHostedShellBinding(webContentsId);
	if (!binding || binding.instanceId !== owner.instanceId) {
		if (binding) {
			controller.releaseHostedShellBinding(binding);
		}
		dependencies.logRefusal(
			binding ? 'owner mismatch' : 'unavailable binding'
		);
		postHostedShellPortDenial(sender, nonce, dependencies.logFailure);
		return false;
	}

	try {
		const connection = dependencies.createConnection(controller, binding);
		dependencies.connections.set(webContentsId, connection);
		if (sender.isDestroyed() ||
			dependencies.ownersByWebContentsId.get(webContentsId) !== owner) {
			throw new Error('Hosted renderer was replaced during port setup.');
		}
		sender.postMessage(
			HUCODE_HOSTED_SHELL_PORT_RESPONSE_CHANNEL,
			nonce,
			[connection.transferPort]
		);
		connection.markTransferred();
		return true;
	} catch (error) {
		dependencies.connections.deleteAndDispose(webContentsId);
		controller.releaseHostedShellBinding(binding);
		dependencies.logFailure(error);
		postHostedShellPortDenial(sender, nonce, dependencies.logFailure);
		return false;
	}
}

function postHostedShellPortDenial(
	sender: Electron.WebContents,
	nonce: string,
	logFailure: (error: unknown) => void
): void {
	if (sender.isDestroyed()) {
		return;
	}
	try {
		sender.postMessage(
			HUCODE_HOSTED_SHELL_PORT_RESPONSE_CHANNEL,
			nonce,
			[]
		);
	} catch (error) {
		logFailure(error);
	}
}
