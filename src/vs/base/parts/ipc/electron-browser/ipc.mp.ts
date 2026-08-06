/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../browser/window.js';
import { IDisposable } from '../../../common/lifecycle.js';
import { generateUuid } from '../../../common/uuid.js';
import { ipcMessagePort, ipcRenderer } from '../../sandbox/electron-browser/globals.js';

interface IMessageChannelResult {
	nonce: string;
	port: MessagePort;
	source: unknown;
}

/** One cancellable renderer-side MessagePort acquisition. */
export interface IMessagePortAcquisition extends IDisposable {
	readonly promise: Promise<MessagePort | undefined>;
}

/** Injectable browser/preload boundary used by focused acquisition tests. */
export interface IMessagePortAcquisitionHost {
	addMessageListener(listener: (event: MessageEvent) => void): void;
	removeMessageListener(listener: (event: MessageEvent) => void): void;
	acquire(responseChannel: string, nonce: string): void;
	cancel(responseChannel: string, nonce: string): void;
	send(requestChannel: string, nonce: string): void;
}

const defaultAcquisitionHost: IMessagePortAcquisitionHost = {
	addMessageListener: listener => mainWindow.addEventListener('message', listener),
	removeMessageListener: listener => mainWindow.removeEventListener('message', listener),
	acquire: (responseChannel, nonce) =>
		ipcMessagePort.acquire(responseChannel, nonce),
	cancel: (responseChannel, nonce) =>
		ipcMessagePort.cancel(responseChannel, nonce),
	send: (requestChannel, nonce) => ipcRenderer.send(requestChannel, nonce),
};

export async function acquirePort(requestChannel: string | undefined, responseChannel: string, nonce = generateUuid()): Promise<MessagePort> {
	const port = await acquirePortOrUndefined(requestChannel, responseChannel, nonce);
	if (!port) {
		throw new Error(`No MessagePort was returned for ${responseChannel}.`);
	}
	return port;
}

export async function acquirePortOrUndefined(requestChannel: string | undefined, responseChannel: string, nonce = generateUuid()): Promise<MessagePort | undefined> {
	const acquisition = acquirePortOrUndefinedCancellable(
		requestChannel,
		responseChannel,
		nonce
	);
	try {
		return await acquisition.promise;
	} finally {
		acquisition.dispose();
	}
}

/**
 * Starts a MessagePort acquisition whose renderer and preload listeners can be
 * released together. A denial is represented by a matching response without a
 * transferred port.
 */
export function acquirePortOrUndefinedCancellable(
	requestChannel: string | undefined,
	responseChannel: string,
	nonce = generateUuid(),
	host: IMessagePortAcquisitionHost = defaultAcquisitionHost
): IMessagePortAcquisition {
	let settled = false;
	let resolvePromise: (port: MessagePort | undefined) => void;
	const promise = new Promise<MessagePort | undefined>(resolve => {
		resolvePromise = resolve;
	});
	const cleanup = (): void => {
		host.removeMessageListener(onMessage);
		host.cancel(responseChannel, nonce);
	};
	const finish = (port: MessagePort | undefined): void => {
		if (settled) {
			port?.close();
			return;
		}
		settled = true;
		cleanup();
		resolvePromise(port);
	};
	const onMessage = (event: MessageEvent): void => {
		const result: IMessageChannelResult = {
			nonce: event.data,
			port: event.ports[0],
			source: event.source,
		};
		if (result.nonce === nonce && result.source === mainWindow) {
			finish(result.port);
		}
	};

	host.addMessageListener(onMessage);
	try {
		host.acquire(responseChannel, nonce);
		if (typeof requestChannel === 'string') {
			host.send(requestChannel, nonce);
		}
	} catch (error) {
		settled = true;
		cleanup();
		throw error;
	}

	return {
		promise,
		dispose: () => finish(undefined),
	};
}
