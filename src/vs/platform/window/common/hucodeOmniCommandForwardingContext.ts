/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from
	'../../instantiation/common/extensions.js';
import {
	HucodeOmniCommandForwardingContext,
	IHucodeOmniCommandForwardingContext,
} from './hucodeOmniCommandRouting.js';

registerSingleton(
	IHucodeOmniCommandForwardingContext,
	HucodeOmniCommandForwardingContext,
	InstantiationType.Delayed
);
