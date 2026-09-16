/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { suppressHucodeStartupPage, suppressHucodeUpstreamOnboarding } from '../../../workbench/contrib/welcomeGettingStarted/browser/hucodeStartupPolicy.js';

suite('Hucode onboarding startup suppression', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('native experimental suppression is independent of completion and application age', () => {
		assert.strictEqual(suppressHucodeUpstreamOnboarding(false, '0.1.0'), true);
		assert.strictEqual(suppressHucodeUpstreamOnboarding(true, '0.1.0'), false);
		assert.strictEqual(suppressHucodeUpstreamOnboarding(false, undefined), false);
	});
	test('first-process page suppression covers later children and leaves later launches and web unchanged', () => {
		assert.deepStrictEqual([
			suppressHucodeStartupPage(false, '0.1.0', true),
			suppressHucodeStartupPage(false, '0.1.0', false),
			suppressHucodeStartupPage(true, '0.1.0', true),
			suppressHucodeStartupPage(false, undefined, true),
		], [true, false, false, false]);
	});
});
