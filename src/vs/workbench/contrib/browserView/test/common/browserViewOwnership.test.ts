/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	getBrowserViewOwner,
	getHostedBrowserViewWebContentsId,
	ownsBrowserView,
} from '../../common/browserViewOwnership.js';

suite('browserViewOwnership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates owners for hosted and normal workbenches', () => {
		assert.deepStrictEqual({
			hosted: getBrowserViewOwner(1, {
				isHostedOmniWorkspace: true,
				hostedWebContentsId: 42,
			}),
			normal: getBrowserViewOwner(1, {
				isHostedOmniWorkspace: false,
				hostedWebContentsId: 42,
			}),
		}, {
			hosted: {
				mainWindowId: 1,
				hostedWebContentsId: 42,
			},
			normal: {
				mainWindowId: 1,
				hostedWebContentsId: undefined,
			},
		});
	});

	test('matches browser views to the active hosted workbench only', () => {
		const environment = {
			isHostedOmniWorkspace: true,
			hostedWebContentsId: 42,
		};

		assert.deepStrictEqual({
			activeHostedWorkbench: ownsBrowserView({
				mainWindowId: 1,
				hostedWebContentsId: 42,
			}, 1, environment),
			otherHostedWorkbench: ownsBrowserView({
				mainWindowId: 1,
				hostedWebContentsId: 7,
			}, 1, environment),
			otherMainWindow: ownsBrowserView({
				mainWindowId: 2,
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
				mainWindowId: 1,
			}, 1, environment),
			hostedOwner: ownsBrowserView({
				mainWindowId: 1,
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
