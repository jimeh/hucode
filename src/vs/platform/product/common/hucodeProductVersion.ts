/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProductConfiguration } from '../../../base/common/product.js';

/**
 * Returns the product-facing app version shown in Hucode UI.
 */
export function getHucodeApplicationVersion(
	product: Pick<IProductConfiguration, 'hucodeVersion' | 'version'>
): string {
	return product.hucodeVersion ?? product.version;
}

/**
 * Returns the Hucode markdown release notes URL for a specific app version.
 */
export function getHucodeReleaseNotesMarkdownUrl(
	product: Pick<IProductConfiguration, 'hucodeReleaseNotesUrlTemplate'>,
	version: string
): string | undefined {
	const template = product.hucodeReleaseNotesUrlTemplate;
	if (!template || !version) {
		return undefined;
	}

	return template.replace(/\{version\}/g, encodeURIComponent(version));
}

/**
 * Returns true when product configuration can show release notes.
 */
export function hasHucodeReleaseNotes(
	product: Pick<IProductConfiguration, 'hucodeReleaseNotesUrlTemplate' | 'releaseNotesUrl'>
): boolean {
	return Boolean(product.hucodeReleaseNotesUrlTemplate || product.releaseNotesUrl);
}
