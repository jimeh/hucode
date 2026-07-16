/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	createNewHucodeOmniWindowContext,
	isNewHucodeOmniWindowAvailable,
} from
	'../../electron-browser/actions/hucodeOmniWindowAction.js';

interface IActionContext {
	readonly platform: 'linux' | 'mac' | 'windows';
	readonly isWeb?: boolean;
	readonly isSessionsWindow?: boolean;
	readonly isOmniWindow?: boolean;
	readonly isHostedOmniWorkspace?: boolean;
}

suite('HucodeOmniWindowAction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('is available in supported desktop workbench contexts', () => {
		const contexts: IActionContext[] = [
			{ platform: 'mac' },
			{ platform: 'linux' },
			{ platform: 'mac', isOmniWindow: true },
			{ platform: 'linux', isOmniWindow: true },
			{ platform: 'mac', isHostedOmniWorkspace: true },
			{ platform: 'linux', isHostedOmniWorkspace: true },
		];

		assert.deepStrictEqual(
			contexts.map(isNewHucodeOmniWindowAvailable),
			[true, true, true, true, true, true]
		);
	});

	test('is unavailable on Windows, web, and in Sessions windows', () => {
		const contexts: IActionContext[] = [
			{ platform: 'windows' },
			{ platform: 'linux', isWeb: true },
			{ platform: 'mac', isWeb: true },
			{ platform: 'linux', isSessionsWindow: true },
			{ platform: 'mac', isSessionsWindow: true },
		];

		assert.deepStrictEqual(
			contexts.map(isNewHucodeOmniWindowAvailable),
			[false, false, false, false, false]
		);
	});

	test('builds the production context from the static policy', () => {
		assert.deepStrictEqual(
			[
				createNewHucodeOmniWindowContext({
					platform: 'mac'
				}).serialize(),
				createNewHucodeOmniWindowContext({
					platform: 'linux'
				}).serialize(),
				createNewHucodeOmniWindowContext({
					platform: 'linux',
					isWeb: true
				}).serialize(),
				createNewHucodeOmniWindowContext({
					platform: 'windows'
				}).serialize(),
			],
			['!isSessionsWindow', '!isSessionsWindow', 'false', 'false']
		);
	});
});
