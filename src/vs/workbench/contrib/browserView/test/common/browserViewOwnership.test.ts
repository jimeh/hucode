/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
		assert.deepStrictEqual(getBrowserViewOwner(1, {
			isHostedOmniWorkspace: true,
			hostedWebContentsId: 42,
		}), {
			mainWindowId: 1,
			hostedWebContentsId: 42,
		});
		assert.deepStrictEqual(getBrowserViewOwner(1, {
			isHostedOmniWorkspace: false,
			hostedWebContentsId: 42,
		}), {
			mainWindowId: 1,
			hostedWebContentsId: undefined,
		});
	});

	test('matches browser views to the active hosted workbench only', () => {
		const environment = {
			isHostedOmniWorkspace: true,
			hostedWebContentsId: 42,
		};

		assert.strictEqual(ownsBrowserView({
			mainWindowId: 1,
			hostedWebContentsId: 42,
		}, 1, environment), true);
		assert.strictEqual(ownsBrowserView({
			mainWindowId: 1,
			hostedWebContentsId: 7,
		}, 1, environment), false);
		assert.strictEqual(ownsBrowserView({
			mainWindowId: 2,
			hostedWebContentsId: 42,
		}, 1, environment), false);
	});

	test('normal workbenches ignore hosted browser views', () => {
		const environment = {
			isHostedOmniWorkspace: false,
			hostedWebContentsId: 42,
		};

		assert.strictEqual(ownsBrowserView({
			mainWindowId: 1,
		}, 1, environment), true);
		assert.strictEqual(ownsBrowserView({
			mainWindowId: 1,
			hostedWebContentsId: 42,
		}, 1, environment), false);
		assert.strictEqual(
			getHostedBrowserViewWebContentsId(environment),
			undefined
		);
	});
});
