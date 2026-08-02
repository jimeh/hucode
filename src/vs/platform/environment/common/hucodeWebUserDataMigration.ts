/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SECRET_STORAGE_PREFIX } from '../../secrets/common/secrets.js';
import { IS_NEW_KEY } from '../../storage/common/storage.js';

const SERVICE_MACHINE_ID_KEY = 'storage.serviceMachineId';

/** Returns whether a browser user-data file is safe to migrate to the shared server namespace. */
export function shouldMigrateWebUserDataFile(path: string): boolean {
	return path.startsWith('/User/') && path !== '/User/machineid';
}

/** Returns whether a browser state entry is non-secret persisted user data. */
export function shouldMigrateWebUserDataState(key: string, value: unknown): value is string {
	return key !== IS_NEW_KEY && key !== SERVICE_MACHINE_ID_KEY && !key.startsWith(SECRET_STORAGE_PREFIX) && typeof value === 'string';
}

/** Returns whether an HTTP response is accepted by a bootstrap operation. */
export function isAcceptedWebUserDataResponse(ok: boolean, status: number, allowConflict: boolean): boolean {
	return ok || (allowConflict && status === 409);
}
