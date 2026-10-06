/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isLinux, isMacintosh, isWeb } from
	'../../../base/common/platform.js';
import { ContextKeyExpr, ContextKeyExpression } from
	'../../../platform/contextkey/common/contextkey.js';
import { IsSessionsWindowContext } from '../../common/contextkeys.js';

/**
 * Inputs that determine whether a workbench can create a new Omni window.
 */
export interface INewHucodeOmniWindowContext {
	readonly platform: 'linux' | 'mac' | 'windows';
	readonly isWeb?: boolean;
	readonly isSessionsWindow?: boolean;
}

/**
 * Returns whether a workbench can create a new Hucode Omni window.
 */
export function isNewHucodeOmniWindowAvailable(
	context: INewHucodeOmniWindowContext
): boolean {
	return !context.isWeb &&
		!context.isSessionsWindow &&
		(context.platform === 'mac' || context.platform === 'linux');
}

/**
 * Builds the command context from the tested static platform policy while
 * leaving the Sessions-window check dynamic.
 */
export function createNewHucodeOmniWindowContext(
	context: Omit<INewHucodeOmniWindowContext, 'isSessionsWindow'>
): ContextKeyExpression {
	if (!isNewHucodeOmniWindowAvailable(context)) {
		return ContextKeyExpr.false();
	}

	return IsSessionsWindowContext.negate();
}

/**
 * Context in which desktop workbenches may create a new Hucode Omni window.
 */
export const NewHucodeOmniWindowContext =
	createNewHucodeOmniWindowContext({
		platform: isMacintosh ? 'mac' : isLinux ? 'linux' : 'windows',
		isWeb,
	});
