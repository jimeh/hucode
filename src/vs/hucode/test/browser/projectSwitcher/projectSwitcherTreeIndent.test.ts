/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
	HUCODE_OMNI_TREE_INDENT_SETTING,
} from '../../../common/retainedWorkbench.js';

const workbenchTreeIndentSetting = 'workbench.tree.indent';

suite('ProjectSwitcherTreeIndent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let configurationService: TestConfigurationService;

	setup(() => {
		configurationService = new TestConfigurationService();
	});

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

		await configurationService.setUserConfiguration(
			HUCODE_OMNI_TREE_INDENT_SETTING,
			14
		);
		assert.strictEqual(
			getProjectSwitcherTreeIndent(true, configurationService),
			14
		);

		await configurationService.setUserConfiguration(
			HUCODE_OMNI_TREE_INDENT_SETTING,
			'invalid'
		);
		assert.strictEqual(
			getProjectSwitcherTreeIndent(true, configurationService),
			HUCODE_OMNI_TREE_INDENT_DEFAULT
		);
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
