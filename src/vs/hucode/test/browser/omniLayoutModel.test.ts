/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	ISerializedLeafNode,
	ISerializedNode,
} from '../../../base/browser/ui/grid/grid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import { Parts } from
	'../../../workbench/services/layout/browser/layoutService.js';
import { createOmniGridDescriptor } from '../../browser/omniLayoutModel.js';

suite('OmniLayoutModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('first render exposes sidebar, titlebar, host surface, and panel regions', () => {
		const descriptor = createOmniGridDescriptor({
			width: 1280,
			height: 800,
			titleBarHeight: 34,
			sideBarVisible: true,
			auxiliaryBarVisible: false,
			chatBarVisible: true,
			panelVisible: false,
		});

		const root = descriptor.root as ISerializedNode;
		const sideBar = getLeaf(root, Parts.SIDEBAR_PART);
		const titleBar = getLeaf(root, Parts.TITLEBAR_PART);
		const host = getLeaf(root, Parts.CHATBAR_PART);
		const panel = getLeaf(root, Parts.PANEL_PART);

		assert.strictEqual(descriptor.width, 1280);
		assert.strictEqual(descriptor.height, 800);
		assert.strictEqual(sideBar.visible, true);
		assert.strictEqual(sideBar.size, 300);
		assert.strictEqual(titleBar.visible, true);
		assert.strictEqual(titleBar.size, 34);
		assert.strictEqual(host.visible, true);
		assert.strictEqual(host.size, 600);
		assert.strictEqual(panel.visible, false);
		assert.strictEqual(panel.size, 300);
	});

	test('sidebar toggle keeps host surface visible with bounded width', () => {
		const descriptor = createOmniGridDescriptor({
			width: 1024,
			height: 700,
			titleBarHeight: 30,
			sideBarVisible: false,
			auxiliaryBarVisible: false,
			chatBarVisible: true,
			panelVisible: false,
		});

		const root = descriptor.root as ISerializedNode;
		const sideBar = getLeaf(root, Parts.SIDEBAR_PART);
		const host = getLeaf(root, Parts.CHATBAR_PART);

		assert.strictEqual(sideBar.visible, false);
		assert.strictEqual(host.visible, true);
		assert.ok(host.size > 0);
	});

	test('small windows do not create negative host surface bounds', () => {
		const descriptor = createOmniGridDescriptor({
			width: 420,
			height: 360,
			titleBarHeight: 30,
			sideBarVisible: true,
			auxiliaryBarVisible: true,
			chatBarVisible: true,
			panelVisible: true,
		});

		const host = getLeaf(descriptor.root as ISerializedNode, Parts.CHATBAR_PART);

		assert.strictEqual(host.size, 0);
	});
});

function getLeaf(root: ISerializedNode, part: Parts) {
	const queue: ISerializedNode[] = [root];
	while (queue.length) {
		const node = queue.shift()!;
		const children = node.data as Array<ISerializedLeafNode | ISerializedNode>;
		for (const child of children) {
			const data = child.data as { readonly type?: Parts };
			if (child.type === 'leaf' && data.type === part) {
				return child;
			}
			if (child.type === 'branch') {
				queue.push(child);
			}
		}
	}

	throw new Error(`Missing layout part ${part}`);
}
