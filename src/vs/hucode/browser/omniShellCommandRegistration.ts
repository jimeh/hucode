/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../base/common/lifecycle.js';
import { type Action2, registerAction2 } from
	'../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../platform/commands/common/commands.js';

/**
 * Registers an Omni shell `Action2` unless its command id already exists.
 *
 * Omni shell command ids are shared between the Omni window UI, the hosted
 * desktop workbench contribution, and the hosted web bridge, and their action
 * modules can be evaluated more than once in a page when several built entry
 * bundles include them (for example the desktop workbench bundle plus a
 * dynamically imported Omni entry). Registration must therefore be
 * first-wins idempotent per command id instead of relying on which module
 * happens to load.
 */
export function registerOmniShellAction2(
	id: string,
	action: { new(): Action2 }
): IDisposable {
	if (CommandsRegistry.getCommand(id)) {
		return Disposable.None;
	}

	return registerAction2(action);
}
