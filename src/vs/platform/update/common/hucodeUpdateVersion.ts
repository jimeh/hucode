/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUpdate } from './update.js';

/**
 * Returns the Hucode application version to show for an update.
 */
export function getHucodeUpdateDisplayVersion(update: IUpdate | undefined): string | undefined {
	return update?.hucodeVersion ?? update?.productVersion;
}

/**
 * Restores update metadata that platform update backends can drop or rewrite.
 */
export function mergeHucodeUpdateMetadata(
	update: IUpdate,
	...candidates: Array<IUpdate | undefined>
): IUpdate {
	const metadata = candidates.find(candidate =>
		candidate?.version === update.version &&
		(candidate.productVersion || candidate.hucodeVersion)
	);

	if (!metadata) {
		return update;
	}

	return {
		...update,
		productVersion: metadata.productVersion ?? update.productVersion,
		hucodeVersion: metadata.hucodeVersion ?? update.hucodeVersion,
	};
}
