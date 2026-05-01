/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement } from '../../base/browser/dom.js';
import {
	HUCODE_OMNI_LOCAL_INPUT_SELECTOR,
	HUCODE_OMNI_PROJECTS_SELECTOR,
} from '../../platform/window/common/hucodeOmniCommandRouting.js';

/**
 * Returns whether keyboard focus is currently inside the Omni Projects UI.
 */
export function isHucodeOmniProjectsFocus(): boolean {
	return isActiveElementInside(HUCODE_OMNI_PROJECTS_SELECTOR);
}

/**
 * Returns whether focus is in shell UI that must keep editing shortcuts local.
 */
export function isHucodeOmniLocalInputFocus(): boolean {
	return isActiveElementInside(HUCODE_OMNI_LOCAL_INPUT_SELECTOR);
}

function isActiveElementInside(selector: string): boolean {
	const activeElement = getActiveElement();
	return activeElement instanceof Element &&
		!!activeElement.closest(selector);
}
