/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import type { IWorkbenchConstructionOptions } from
	'../../../workbench/browser/web.api.js';
import {
	resolveHucodeWebWorkbenchCreate,
	toHucodeWebWorkbenchOptions,
} from '../../browser/workbench/hucodeWebWorkbenchEntrypoint.js';

suite('HucodeWebWorkbenchEntrypoint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('boots the default workbench without Hucode markers', async () => {
		const createdWith: IWorkbenchConstructionOptions[] = [];
		const defaultCreate = (
			_domElement: unknown,
			options: IWorkbenchConstructionOptions
		) => {
			createdWith.push(options);
			return Disposable.None;
		};

		const configs: IWorkbenchConstructionOptions[] = [
			{},
			{ hucodeOmniShell: false } as IWorkbenchConstructionOptions,
			{ hucodeHostedOmniWorkbench: false } as IWorkbenchConstructionOptions,
		];
		for (const config of configs) {
			const create = await resolveHucodeWebWorkbenchCreate(
				config,
				defaultCreate as never
			);
			create(document.createElement('div'), config);
		}

		assert.strictEqual(createdWith.length, 3);
	});

	test('resolves relative webview endpoints against the page location', () => {
		const location = 'https://hucode.example:8443/omni?folder=/tmp/x';

		assert.deepStrictEqual({
			relative: toHucodeWebWorkbenchOptions({
				webviewEndpoint:
					'/static/out/vs/workbench/contrib/webview/browser/pre',
			}, location).webviewEndpoint,
			basePath: toHucodeWebWorkbenchOptions({
				webviewEndpoint:
					'/base/static/out/vs/workbench/contrib/webview/browser/pre',
			}, location).webviewEndpoint,
			absolute: toHucodeWebWorkbenchOptions({
				webviewEndpoint: 'https://cdn.example/pre',
			}, location).webviewEndpoint,
			absent: toHucodeWebWorkbenchOptions({}, location).webviewEndpoint,
		}, {
			relative: 'https://hucode.example:8443' +
				'/static/out/vs/workbench/contrib/webview/browser/pre',
			basePath: 'https://hucode.example:8443' +
				'/base/static/out/vs/workbench/contrib/webview/browser/pre',
			absolute: 'https://cdn.example/pre',
			absent: undefined,
		});
	});
});
