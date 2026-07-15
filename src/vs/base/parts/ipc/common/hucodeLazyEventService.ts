/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Returns a service proxy that keeps selected event properties available for
 * direct lookup while hiding them from enumeration-based eager buffering.
 */
export function hucodeCreateLazyEventService<T extends object>(
	service: T,
	eventNames: readonly string[]
): T {
	const lazyEvents = new Set(eventNames);

	return new Proxy(service, {
		ownKeys(target) {
			return Reflect.ownKeys(target).filter(key =>
				typeof key !== 'string' || !lazyEvents.has(key)
			);
		},

		getOwnPropertyDescriptor(target, key) {
			const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
			if (
				descriptor &&
				typeof key === 'string' &&
				lazyEvents.has(key)
			) {
				return { ...descriptor, enumerable: false };
			}

			return descriptor;
		}
	});
}
