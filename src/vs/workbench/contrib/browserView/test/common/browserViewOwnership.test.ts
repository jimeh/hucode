/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	getHostedBrowserViewWebContentsId,
	ownsBrowserView,
} from '../../common/browserViewOwnership.js';

suite('browserViewOwnership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches browser views to the active hosted workbench only', () => {
		const environment = {
			isHostedOmniWorkspace: true,
			hostedWebContentsId: 42,
		};

		assert.deepStrictEqual({
			activeHostedWorkbench: ownsBrowserView({
				hostWindowId: 1,
				hostedWebContentsId: 42,
			}, 1, environment),
			otherHostedWorkbench: ownsBrowserView({
				hostWindowId: 1,
				hostedWebContentsId: 7,
			}, 1, environment),
			otherMainWindow: ownsBrowserView({
				hostWindowId: 2,
				hostedWebContentsId: 42,
			}, 1, environment),
		}, {
			activeHostedWorkbench: true,
			otherHostedWorkbench: false,
			otherMainWindow: false,
		});
	});

	test('normal workbenches ignore hosted browser views', () => {
		const environment = {
			isHostedOmniWorkspace: false,
			hostedWebContentsId: 42,
		};

		assert.deepStrictEqual({
			normalOwner: ownsBrowserView({
				hostWindowId: 1,
			}, 1, environment),
			hostedOwner: ownsBrowserView({
				hostWindowId: 1,
				hostedWebContentsId: 42,
			}, 1, environment),
			hostedWebContentsId:
				getHostedBrowserViewWebContentsId(environment),
		}, {
			normalOwner: true,
			hostedOwner: false,
			hostedWebContentsId: undefined,
		});
	});
});
