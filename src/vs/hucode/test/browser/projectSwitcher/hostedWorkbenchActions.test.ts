/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { HucodeHostedWorkbenchLifecycleState } from
	'../../../common/omniWindow.js';
import {
	canSuspendHostedWorkbench,
	shouldUnloadHostedWorkbench,
} from '../../../browser/projectSwitcher/hostedWorkbenchActions.js';

suite('Hosted Workbench Actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const states: readonly HucodeHostedWorkbenchLifecycleState[] = [
		'restore-pending',
		'loading',
		'active',
		'loaded',
		'dormant',
		'unloaded',
		'missing',
		'crashed',
	];

	test('offers suspend only for ready live workbenches', () => {
		assert.deepStrictEqual(
			states.filter(canSuspendHostedWorkbench),
			['active', 'loaded']
		);
	});

	test('uses unload for resident and crashed workbenches', () => {
		assert.deepStrictEqual(
			states.filter(shouldUnloadHostedWorkbench),
			[
				'restore-pending',
				'loading',
				'active',
				'loaded',
				'dormant',
				'crashed',
			]
		);
	});
});
