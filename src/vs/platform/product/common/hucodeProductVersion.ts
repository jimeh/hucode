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
