/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import type { INativeWindowConfiguration } from
	'../../../platform/window/common/window.js';
import { TestProductService } from
	'../../../workbench/test/common/workbenchTestServices.js';
import {
	HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
	HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS,
} from '../../../workbench/services/extensions/common/hucodeExtensionEnablementPolicy.js';
import { HucodeOmniWorkbenchEnvironmentService } from
	'../../electron-browser/omni.main.js';

/**
 * Desktop and web enforce the shell's built-in filter through different
 * mechanisms — `skipBuiltinExtensions` at scan time here, enablement in the
 * browser — but from one shared list. Nothing else asserts the desktop half is
 * wired to it, so deleting the override below would be silent.
 */
suite('HucodeOmniDesktopExtensionPolicy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the desktop shell skips every built-in on the shared list', () => {
		const skipped = anOmniEnvironmentService().skipBuiltinExtensions;

		assert.deepStrictEqual(
			HUCODE_OMNI_SHELL_SKIP_BUILTIN_EXTENSIONS.filter(
				id => !skipped.includes(id)
			),
			[]
		);
	});

	test('the desktop shell applies the theme-only user policy', () => {
		assert.strictEqual(
			anOmniEnvironmentService().hucodeExtensionEnablementPolicy,
			HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY
		);
	});

	// Not covered: that the override preserves `super.skipBuiltinExtensions`.
	// The base reads `VSCODE_SKIP_BUILTIN_EXTENSIONS` from the process
	// environment rather than the window configuration, so pinning it would
	// mean mutating process state from a renderer test. Dropping the spread
	// would only discard an operator's own env-provided skips, not weaken the
	// shell filter.

	function anOmniEnvironmentService(): HucodeOmniWorkbenchEnvironmentService {
		const configuration = {
			windowId: 1,
			userEnv: {},
			execPath: '/test/exec',
			homeDir: '/test/home',
			tmpDir: '/test/tmp',
			userDataDir: '/test/user-data',
		} as unknown as INativeWindowConfiguration;

		return new HucodeOmniWorkbenchEnvironmentService(
			configuration,
			TestProductService
		);
	}
});
