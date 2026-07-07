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
			omniHostVisible: true,
			panelVisible: false,
		});

		const root = descriptor.root as ISerializedNode;
		const sideBar = getLeaf(root, Parts.SIDEBAR_PART);
		const titleBar = getLeaf(root, Parts.TITLEBAR_PART);
		const host = getLeaf(root, Parts.HUCODE_OMNI_HOST_PART);
		const panel = getLeaf(root, Parts.PANEL_PART);

		assert.deepStrictEqual({
			descriptor: {
				width: descriptor.width,
				height: descriptor.height,
			},
			sideBar: {
				visible: sideBar.visible,
				size: sideBar.size,
			},
			titleBar: {
				visible: titleBar.visible,
				size: titleBar.size,
			},
			host: {
				visible: host.visible,
				size: host.size,
			},
			panel: {
				visible: panel.visible,
				size: panel.size,
			},
		}, {
			descriptor: {
				width: 1280,
				height: 800,
			},
			sideBar: {
				visible: true,
				size: 300,
			},
			titleBar: {
				visible: true,
				size: 34,
			},
			host: {
				visible: true,
				size: 600,
			},
			panel: {
				visible: false,
				size: 300,
			},
		});
	});

	test('sidebar toggle keeps host surface visible with bounded width', () => {
		const descriptor = createOmniGridDescriptor({
			width: 1024,
			height: 700,
			titleBarHeight: 30,
			sideBarVisible: false,
			auxiliaryBarVisible: false,
			omniHostVisible: true,
			panelVisible: false,
		});

		const root = descriptor.root as ISerializedNode;
		const sideBar = getLeaf(root, Parts.SIDEBAR_PART);
		const host = getLeaf(root, Parts.HUCODE_OMNI_HOST_PART);

		assert.strictEqual(sideBar.visible, false);
		assert.strictEqual(host.visible, true);
		assert.ok(host.size > 0);
	});

	test('web layout can hide the shell titlebar without reserving height', () => {
		const descriptor = createOmniGridDescriptor({
			width: 1280,
			height: 800,
			titleBarVisible: false,
			titleBarHeight: 0,
			sideBarVisible: true,
			auxiliaryBarVisible: false,
			omniHostVisible: true,
			panelVisible: false,
		});

		const root = descriptor.root as ISerializedNode;
		const titleBar = getLeaf(root, Parts.TITLEBAR_PART);
		const topRight = getBranchContainingLeaf(
			root,
			Parts.HUCODE_OMNI_HOST_PART
		);

		assert.strictEqual(titleBar.visible, false);
		assert.strictEqual(titleBar.size, 0);
		assert.strictEqual(topRight.size, 500);
	});

	test('small windows do not create negative host surface bounds', () => {
		const descriptor = createOmniGridDescriptor({
			width: 420,
			height: 260,
			titleBarHeight: 30,
			sideBarVisible: true,
			auxiliaryBarVisible: true,
			omniHostVisible: true,
			panelVisible: true,
		});

		const root = descriptor.root as ISerializedNode;
		const host = getLeaf(root, Parts.HUCODE_OMNI_HOST_PART);
		const topRight = getBranchContainingLeaf(root, Parts.HUCODE_OMNI_HOST_PART);

		assert.deepStrictEqual({
			hostSize: host.size,
			topRightSize: topRight.size,
		}, {
			hostSize: 0,
			topRightSize: 0,
		});
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

function getBranchContainingLeaf(root: ISerializedNode, part: Parts) {
	const queue: ISerializedNode[] = [root];
	while (queue.length) {
		const node = queue.shift()!;
		const children = node.data as Array<ISerializedLeafNode | ISerializedNode>;
		for (const child of children) {
			const data = child.data as { readonly type?: Parts };
			if (child.type === 'leaf' && data.type === part) {
				return node;
			}
			if (child.type === 'branch') {
				queue.push(child);
			}
		}
	}

	throw new Error(`Missing containing branch for layout part ${part}`);
}
