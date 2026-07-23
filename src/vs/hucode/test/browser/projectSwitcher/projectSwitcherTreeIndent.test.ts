/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import {
	ConfigurationTarget,
	IConfigurationChangeEvent,
} from '../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from
	'../../../../platform/configuration/test/common/testConfigurationService.js';
import {
	getProjectSwitcherTreeIndent,
	onDidChangeProjectSwitcherTreeIndent,
} from '../../../browser/projectSwitcher/projectSwitcherTreeIndent.js';
import {
	HUCODE_OMNI_TREE_INDENT_DEFAULT,
	HUCODE_OMNI_TREE_INDENT_MAXIMUM,
	HUCODE_OMNI_TREE_INDENT_MINIMUM,
	HUCODE_OMNI_TREE_INDENT_SETTING,
} from '../../../common/retainedWorkbench.js';

const workbenchTreeIndentSetting = 'workbench.tree.indent';

suite('ProjectSwitcherTreeIndent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let configurationService: TestConfigurationService;

	setup(() => {
		configurationService = new TestConfigurationService();
	});

	/** Fires a configuration event for the provided setting key. */
	function fireConfigurationChange(key: string): void {
		configurationService.onDidChangeConfigurationEmitter.fire({
			affectsConfiguration: candidate => candidate === key,
			affectedKeys: new Set([key]),
			change: { keys: [key], overrides: [] },
			source: ConfigurationTarget.USER,
		} satisfies IConfigurationChangeEvent);
	}

	test('resolves Omni values without affecting non-Omni trees', async () => {
		assert.deepStrictEqual([
			getProjectSwitcherTreeIndent(true, configurationService),
			getProjectSwitcherTreeIndent(false, configurationService),
		], [HUCODE_OMNI_TREE_INDENT_DEFAULT, undefined]);

		const cases: readonly [unknown, number][] = [
			[HUCODE_OMNI_TREE_INDENT_MINIMUM, 4],
			[HUCODE_OMNI_TREE_INDENT_MAXIMUM, 40],
			[3, HUCODE_OMNI_TREE_INDENT_DEFAULT],
			[41, HUCODE_OMNI_TREE_INDENT_DEFAULT],
			[Number.NaN, HUCODE_OMNI_TREE_INDENT_DEFAULT],
			[Number.POSITIVE_INFINITY, HUCODE_OMNI_TREE_INDENT_DEFAULT],
			['invalid', HUCODE_OMNI_TREE_INDENT_DEFAULT],
		];
		for (const [configuredIndent, expectedIndent] of cases) {
			await configurationService.setUserConfiguration(
				HUCODE_OMNI_TREE_INDENT_SETTING,
				configuredIndent
			);
			assert.strictEqual(
				getProjectSwitcherTreeIndent(true, configurationService),
				expectedIndent
			);
		}
	});

	test('emits only live Omni indent changes', async () => {
		const omniValues: number[] = [];
		let nonOmniChanges = 0;
		store.add(onDidChangeProjectSwitcherTreeIndent(
			true,
			configurationService
		)(indent => omniValues.push(indent)));
		store.add(onDidChangeProjectSwitcherTreeIndent(
			false,
			configurationService
		)(() => nonOmniChanges++));

		await configurationService.setUserConfiguration(
			HUCODE_OMNI_TREE_INDENT_SETTING,
			16
		);
		fireConfigurationChange(HUCODE_OMNI_TREE_INDENT_SETTING);
		await configurationService.setUserConfiguration(
			workbenchTreeIndentSetting,
			20
		);
		fireConfigurationChange(workbenchTreeIndentSetting);

		assert.deepStrictEqual(
			{ omniValues, nonOmniChanges },
			{ omniValues: [16], nonOmniChanges: 0 }
		);
	});
});
