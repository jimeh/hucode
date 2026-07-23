/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isLinux, isMacintosh } from
	'../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { ContextKeyValue } from
	'../../../platform/contextkey/common/contextkey.js';
import {
	createNewHucodeOmniWindowContext,
	isNewHucodeOmniWindowAvailable,
	NewHucodeOmniWindowContext,
} from
	'../../electron-browser/actions/hucodeOmniWindowAction.js';

/** Runtime context values used to exercise the production action predicate. */
interface IActionRuntimeContext {
	readonly isSessionsWindow?: boolean;
	readonly isOmniWindow?: boolean;
	readonly isHostedOmniWorkspace?: boolean;
}

suite('HucodeOmniWindowAction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('supports only macOS and Linux desktop platforms', () => {
		assert.deepStrictEqual(
			[
				{ platform: 'mac' as const },
				{ platform: 'linux' as const },
				{ platform: 'windows' as const },
				{ platform: 'linux' as const, isWeb: true },
			].map(isNewHucodeOmniWindowAvailable),
			[true, true, false, false]
		);
	});

	test('evaluates regular, Omni, hosted, and Sessions contexts', () => {
		const contexts: IActionRuntimeContext[] = [
			{},
			{ isOmniWindow: true },
			{ isHostedOmniWorkspace: true },
			{ isOmniWindow: true, isHostedOmniWorkspace: true },
			{ isSessionsWindow: true },
			{ isOmniWindow: true, isSessionsWindow: true },
			{ isHostedOmniWorkspace: true, isSessionsWindow: true },
		];
		const supportedDesktop = isMacintosh || isLinux;

		assert.deepStrictEqual(
			contexts.map(evaluateProductionContext),
			[
				supportedDesktop,
				supportedDesktop,
				supportedDesktop,
				supportedDesktop,
				false,
				false,
				false,
			]
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

/** Evaluates the production context expression against explicit test values. */
function evaluateProductionContext(context: IActionRuntimeContext): boolean {
	return NewHucodeOmniWindowContext.evaluate({
		getValue<T extends ContextKeyValue>(key: string): T | undefined {
			return context[key as keyof IActionRuntimeContext] as T | undefined;
		}
	});
}
