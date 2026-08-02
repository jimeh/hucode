/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs a browser upload while periodically renewing its server-side migration lease.
 */
export async function runHucodeWebUserDataUploadWithLeaseRenewal<TTimer>(
	upload: (signal: AbortSignal) => Promise<void>,
	renew: () => Promise<void>,
	setRenewalInterval: (callback: () => void, delay: number) => TTimer,
	clearRenewalInterval: (timer: TTimer) => void,
): Promise<void> {
	const controller = new AbortController();
	let renewalError: unknown;
	let renewal = Promise.resolve();
	const renewLease = () => {
		renewal = renewal.then(renew).catch(error => {
			renewalError = error;
			controller.abort();
		});
	};
	const timer = setRenewalInterval(renewLease, 20_000);
	try {
		try {
			await upload(controller.signal);
		} catch (error) {
			await renewal;
			throw renewalError ?? error;
		}
		await renewal;
		if (renewalError) {
			throw renewalError;
		}
	} finally {
		clearRenewalInterval(timer);
	}
}

/**
 * Reads a structured error from a web user-data response or returns the fallback.
 */
export async function readHucodeWebUserDataResponseError(response: Pick<Response, 'json'>, fallback: string): Promise<string> {
	try {
		const body = await response.json() as { error?: unknown } | undefined;
		return typeof body?.error === 'string' ? body.error : fallback;
	} catch {
		return fallback;
	}
}

/**
 * Reads all keys and values while queuing both IndexedDB requests synchronously.
 */
export async function readHucodeWebUserDataStore(store: Pick<IDBObjectStore, 'getAllKeys' | 'getAll'>): Promise<readonly (readonly [IDBValidKey, unknown])[]> {
	const keysRequest = idbRequest<IDBValidKey[]>(store.getAllKeys());
	const valuesRequest = idbRequest<unknown[]>(store.getAll());
	const [keys, values] = await Promise.all([keysRequest, valuesRequest]);
	return keys.map((key, index) => [key, values[index]] as const);
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
}
