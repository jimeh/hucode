/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IConfigurationService } from
	'../../../platform/configuration/common/configuration.js';
import {
	HUCODE_OMNI_TREE_INDENT_DEFAULT,
	HUCODE_OMNI_TREE_INDENT_MAXIMUM,
	HUCODE_OMNI_TREE_INDENT_MINIMUM,
	HUCODE_OMNI_TREE_INDENT_SETTING,
} from '../../common/retainedWorkbench.js';

/** Resolves the tree indent used by the Project Switcher renderer. */
export function getProjectSwitcherTreeIndent(
	isOmniWindow: boolean,
	configurationService: IConfigurationService,
): number | undefined {
	if (!isOmniWindow) {
		return undefined;
	}

	const configuredIndent = configurationService.getValue(
		HUCODE_OMNI_TREE_INDENT_SETTING
	);
	return typeof configuredIndent === 'number'
		&& Number.isFinite(configuredIndent)
		&& configuredIndent >= HUCODE_OMNI_TREE_INDENT_MINIMUM
		&& configuredIndent <= HUCODE_OMNI_TREE_INDENT_MAXIMUM
		? configuredIndent
		: HUCODE_OMNI_TREE_INDENT_DEFAULT;
}

/** Emits resolved indent updates for an Omni Project Switcher. */
export function onDidChangeProjectSwitcherTreeIndent(
	isOmniWindow: boolean,
	configurationService: IConfigurationService,
): Event<number> {
	if (!isOmniWindow) {
		return Event.None;
	}

	return Event.map(
		Event.filter(
			configurationService.onDidChangeConfiguration,
			event => event.affectsConfiguration(
				HUCODE_OMNI_TREE_INDENT_SETTING
			)
		),
		() => getProjectSwitcherTreeIndent(
			isOmniWindow,
			configurationService
		) ?? HUCODE_OMNI_TREE_INDENT_DEFAULT
	);
}
