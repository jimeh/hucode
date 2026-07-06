/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { IHucodeWebWorkbenchConfiguration } from
	'../../../platform/environment/common/hucodeWebConfiguration.js';
import type { IWorkbenchConstructionOptions } from
	'../../../workbench/browser/web.api.js';
import {
	resolveHucodeWebWorkbenchCreate,
	toHucodeWebWorkbenchOptions,
} from '../../browser/workbench/hucodeWebWorkbenchEntrypoint.js';

type HucodeWebConstructionOptions =
	IWorkbenchConstructionOptions & IHucodeWebWorkbenchConfiguration;

suite('HucodeWebWorkbenchEntrypoint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('boots the default workbench without Hucode markers', async () => {
		const createdWith: IWorkbenchConstructionOptions[] = [];
		const defaultCreate = (
			_domElement: HTMLElement,
			options: IWorkbenchConstructionOptions
		): IDisposable => {
			createdWith.push(options);
			return Disposable.None;
		};

		const configs: HucodeWebConstructionOptions[] = [
			{},
			{ hucodeOmniShell: false },
			{ hucodeHostedOmniWorkbench: false },
		];
		for (const config of configs) {
			const create = await resolveHucodeWebWorkbenchCreate(
				config,
				defaultCreate
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
