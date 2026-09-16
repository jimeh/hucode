/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IConfigurationService } from
	'../../../platform/configuration/common/configuration.js';
import {
	HUCODE_OMNI_SECTION_INDENT_DEFAULT,
	HUCODE_OMNI_SECTION_INDENT_MAXIMUM,
	HUCODE_OMNI_SECTION_INDENT_MINIMUM,
	HUCODE_OMNI_SECTION_INDENT_SETTING,
	HUCODE_OMNI_TREE_INDENT_DEFAULT,
	HUCODE_OMNI_TREE_INDENT_MAXIMUM,
	HUCODE_OMNI_TREE_INDENT_MINIMUM,
	HUCODE_OMNI_TREE_INDENT_SETTING,
} from '../../common/retainedWorkbench.js';

export const PROJECT_SWITCHER_DEFAULT_INDENT = 8;

function getConfiguredIndent(
	configurationService: IConfigurationService,
	setting: string,
	defaultValue: number,
	minimum: number,
	maximum: number,
): number {
	const configuredIndent = configurationService.getValue(setting);
	return typeof configuredIndent === 'number'
		&& Number.isFinite(configuredIndent)
		&& configuredIndent >= minimum
		&& configuredIndent <= maximum
		? configuredIndent
		: defaultValue;
}

/** Resolves the tree indent used by the Project Switcher renderer. */
export function getProjectSwitcherTreeIndent(
	isOmniWindow: boolean,
	configurationService: IConfigurationService,
): number | undefined {
	if (!isOmniWindow) {
		return undefined;
	}

	return getConfiguredIndent(
		configurationService,
		HUCODE_OMNI_TREE_INDENT_SETTING,
		HUCODE_OMNI_TREE_INDENT_DEFAULT,
		HUCODE_OMNI_TREE_INDENT_MINIMUM,
		HUCODE_OMNI_TREE_INDENT_MAXIMUM,
	);
}

/** Resolves the indent adjustment for descendants of synthetic sections. */
export function getProjectSwitcherSectionIndentAdjustment(
	isOmniWindow: boolean,
	configurationService: IConfigurationService,
): number {
	if (!isOmniWindow) {
		return 0;
	}

	const treeIndent = getProjectSwitcherTreeIndent(
		isOmniWindow,
		configurationService
	) ?? HUCODE_OMNI_TREE_INDENT_DEFAULT;
	const sectionIndent = getConfiguredIndent(
		configurationService,
		HUCODE_OMNI_SECTION_INDENT_SETTING,
		HUCODE_OMNI_SECTION_INDENT_DEFAULT,
		HUCODE_OMNI_SECTION_INDENT_MINIMUM,
		HUCODE_OMNI_SECTION_INDENT_MAXIMUM,
	);
	return sectionIndent - PROJECT_SWITCHER_DEFAULT_INDENT - treeIndent;
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
