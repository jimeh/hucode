/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../../base/test/common/utils.js';
import { HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY } from
	'../../../extensions/common/hucodeExtensionEnablementPolicy.js';
import { BrowserWorkbenchEnvironmentService } from
	'../../browser/environmentService.js';
import { TestProductService } from
	'../../../../test/common/workbenchTestServices.js';
import type { IWorkbenchConstructionOptions } from
	'../../../../browser/web.api.js';

suite('HucodeOmniEnvironmentService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('applies the Omni extension policy only to the shell route', () => {
		assert.deepStrictEqual({
			shell: policyFor({ hucodeOmniShell: true }),
			hostedWorkbench: policyFor({ hucodeHostedOmniWorkbench: true }),
			plainWorkbench: policyFor({}),
		}, {
			shell: HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
			hostedWorkbench: undefined,
			plainWorkbench: undefined,
		});
	});

	test('withholds the policy from a hosted workspace payload', () => {
		// Hosted iframes carry `isHostedOmniWorkspace` in their payload. They
		// do not set `isOmniWindow` today, so this covers the guard rather
		// than the route.
		assert.strictEqual(
			policyFor({ hucodeOmniShell: true }, [
				['isHostedOmniWorkspace', 'true'],
			]),
			undefined
		);
	});

	test('reads the shell flag from the connection payload', () => {
		assert.strictEqual(
			policyFor({}, [['isOmniWindow', 'true']]),
			HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY
		);
	});

	function policyFor(
		options: object,
		payload?: [string, string][]
	): string | undefined {
		const constructionOptions = {
			...options,
			workspaceProvider: payload
				? { payload } as IWorkbenchConstructionOptions['workspaceProvider']
				: undefined,
		} as IWorkbenchConstructionOptions;

		return new BrowserWorkbenchEnvironmentService(
			'workspace-id',
			URI.file('/logs'),
			constructionOptions,
			TestProductService
		).hucodeExtensionEnablementPolicy;
	}
});
