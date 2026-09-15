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

	test('treats only the server-injected shell route as the shell', () => {
		assert.deepStrictEqual({
			shell: serviceFor({ hucodeOmniShell: true }).isOmniShellWindow,
			hostedWorkbench: serviceFor({
				hucodeHostedOmniWorkbench: true,
			}).isOmniShellWindow,
			plainWorkbench: serviceFor({}).isOmniShellWindow,
		}, {
			shell: true,
			hostedWorkbench: false,
			plainWorkbench: false,
		});
	});

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

	// `payload` is parsed straight out of the page's own query string, so it
	// must not be able to move a window in or out of the shell's extension
	// policy. `isOmniWindow` still honours it for UI routing.
	test('ignores a payload claiming the workbench is the shell', () => {
		const service = serviceFor({}, [['isOmniWindow', 'true']]);

		assert.deepStrictEqual({
			isOmniWindow: service.isOmniWindow,
			isOmniShellWindow: service.isOmniShellWindow,
			policy: service.hucodeExtensionEnablementPolicy,
		}, {
			isOmniWindow: true,
			isOmniShellWindow: false,
			policy: undefined,
		});
	});

	test('ignores a payload disclaiming the shell', () => {
		const service = serviceFor({ hucodeOmniShell: true }, [
			['isHostedOmniWorkspace', 'true'],
		]);

		assert.deepStrictEqual({
			isHostedOmniWorkspace: service.isHostedOmniWorkspace,
			isOmniShellWindow: service.isOmniShellWindow,
			policy: service.hucodeExtensionEnablementPolicy,
		}, {
			isHostedOmniWorkspace: true,
			isOmniShellWindow: true,
			policy: HUCODE_OMNI_EXTENSION_ENABLEMENT_POLICY,
		});
	});

	function serviceFor(
		options: object,
		payload?: [string, string][]
	): BrowserWorkbenchEnvironmentService {
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
		);
	}

	function policyFor(
		options: object,
		payload?: [string, string][]
	): string | undefined {
		return serviceFor(options, payload).hucodeExtensionEnablementPolicy;
	}
});
