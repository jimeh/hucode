/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { toBrowserViewWindowBounds } from '../../common/browserViewLayout.js';

suite('browserViewLayout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('grounds hosted browser bounds in the host view offset', () => {
		assert.deepStrictEqual(toBrowserViewWindowBounds({
			windowId: 1,
			hostedWebContentsId: 42,
			x: 320,
			y: 74,
			width: 640,
			height: 480,
			zoomFactor: 1,
			cornerRadius: 0,
		}, { x: 280, y: 0 }), {
			x: 600,
			y: 74,
			width: 640,
			height: 480,
		});
	});

	test('applies window zoom before adding the native host offset', () => {
		assert.deepStrictEqual(toBrowserViewWindowBounds({
			windowId: 1,
			hostedWebContentsId: 42,
			x: 10.4,
			y: 20.4,
			width: 300.4,
			height: 200.4,
			zoomFactor: 1.5,
			cornerRadius: 0,
		}, { x: 280, y: 5 }), {
			x: 296,
			y: 36,
			width: 451,
			height: 301,
		});
	});
});
