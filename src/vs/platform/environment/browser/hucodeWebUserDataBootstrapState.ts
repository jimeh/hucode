/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI, UriDto } from '../../../base/common/uri.js';
import { IUserDataProfile } from '../../userDataProfile/common/userDataProfile.js';

export interface HucodeWebUserDataBootstrapResult {
	readonly profiles: readonly UriDto<IUserDataProfile>[];
	readonly profilesHome: URI;
}

let result: HucodeWebUserDataBootstrapResult | undefined;

/** Records the trusted bootstrap result before BrowserMain construction. */
export function setHucodeWebUserDataBootstrapResult(value: HucodeWebUserDataBootstrapResult): void {
	result = value;
}

/** Returns the trusted server profile snapshot established before BrowserMain starts. */
export function getHucodeWebUserDataBootstrapResult(): HucodeWebUserDataBootstrapResult {
	if (!result) {
		throw new Error('Serve-web server user-data bootstrap did not complete.');
	}
	return result;
}
