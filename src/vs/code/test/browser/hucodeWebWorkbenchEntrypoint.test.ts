/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { IHucodeWebWorkbenchConfiguration } from
	'../../../platform/environment/common/hucodeWebConfiguration.js';
import { toUserDataProfile } from
	'../../../platform/userDataProfile/common/userDataProfile.js';
import type { IWorkbenchConstructionOptions } from
	'../../../workbench/browser/web.api.js';
import { toHucodeRemoteUserDataProfile } from
	'../../browser/workbench/hucodeWebUserDataBootstrap.js';
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

	test('normalizes bootstrap profile workspaces to remote URIs', () => {
		const profile = toUserDataProfile(
			'diagnostic',
			'Diagnostic',
			URI.file('/user/profiles/diagnostic'),
			URI.file('/cache'),
			{ workspaces: [URI.file('/workspace')] }
		);

		const remote = toHucodeRemoteUserDataProfile(
			profile,
			URI.parse('vscode-remote://server/user')
		);

		assert.strictEqual(
			URI.revive(remote.location).toString(),
			'vscode-remote://server/user/profiles/diagnostic'
		);
		assert.deepStrictEqual(
			remote.workspaces?.map(workspace => URI.revive(workspace).toString()),
			['vscode-remote://server/workspace']
		);
	});
});
