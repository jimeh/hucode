/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUpdate } from './update.js';

/**
 * Returns the Hucode application version to show for an update.
 */
export function getHucodeUpdateDisplayVersion(update: IUpdate | undefined): string | undefined {
	return update?.hucodeVersion ?? update?.productVersion;
}

/**
 * Restores Hucode-specific update fields that platform update backends can drop.
 */
export function mergeHucodeUpdateMetadata(update: IUpdate, ...candidates: Array<IUpdate | undefined>): IUpdate {
	if (update.hucodeVersion) {
		return update;
	}

	const metadata = candidates.find(candidate =>
		candidate?.version === update.version && candidate.hucodeVersion
	);

	if (!metadata) {
		return update;
	}

	return {
		...metadata,
		...update,
		hucodeVersion: metadata.hucodeVersion,
	};
}
