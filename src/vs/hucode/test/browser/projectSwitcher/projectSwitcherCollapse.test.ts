/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../../base/test/common/utils.js';
import { toggleProjectTreeItemCollapsed } from
	'../../../browser/projectSwitcher/projectSwitcherCollapse.js';

suite('ProjectSwitcherCollapse', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ignores non-collapsible unavailable project rows', () => {
		const calls: string[] = [];
		const item = { id: 'unavailable' };

		toggleProjectTreeItemCollapsed({
			isCollapsible: () => false,
			isCollapsed: () => false,
			expand: () => calls.push('expand'),
			collapse: () => calls.push('collapse'),
		}, item, collapsed => calls.push(`persist:${collapsed}`));

		assert.deepStrictEqual(calls, []);
	});

	test('toggles and persists collapsible project rows', () => {
		const calls: string[] = [];
		const item = { id: 'project' };
		let collapsed = false;
		const tree = {
			isCollapsible: () => true,
			isCollapsed: () => collapsed,
			expand: () => {
				calls.push('expand');
				collapsed = false;
			},
			collapse: () => {
				calls.push('collapse');
				collapsed = true;
			},
		};

		toggleProjectTreeItemCollapsed(
			tree,
			item,
			value => calls.push(`persist:${value}`)
		);
		toggleProjectTreeItemCollapsed(
			tree,
			item,
			value => calls.push(`persist:${value}`)
		);

		assert.deepStrictEqual(calls, [
			'collapse',
			'persist:true',
			'expand',
			'persist:false',
		]);
	});
});
