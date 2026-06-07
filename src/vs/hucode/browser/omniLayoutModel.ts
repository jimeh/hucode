/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ISerializedGrid,
	ISerializedLeafNode,
	ISerializedNode,
	Orientation,
} from '../../base/browser/ui/grid/grid.js';
import { Parts } from '../../workbench/services/layout/browser/layoutService.js';

export interface IOmniLayoutDescriptorOptions {
	readonly width: number;
	readonly height: number;
	readonly titleBarHeight: number;
	readonly sideBarVisible: boolean;
	readonly auxiliaryBarVisible: boolean;
	readonly omniHostVisible: boolean;
	readonly panelVisible: boolean;
}

export function createOmniGridDescriptor(
	options: IOmniLayoutDescriptorOptions
): ISerializedGrid {
	const { width, height } = options;

	const sideBarSize = 300;
	const auxiliaryBarSize = 380;
	const panelSize = 300;
	const titleBarHeight = options.titleBarHeight;
	const rightSectionWidth = Math.max(0, width - sideBarSize);
	const omniHostWidth = Math.max(0, rightSectionWidth - auxiliaryBarSize);
	const contentHeight = height - titleBarHeight;
	const topRightHeight = Math.max(0, contentHeight - panelSize);

	const titleBarNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: Parts.TITLEBAR_PART },
		size: titleBarHeight,
		visible: true,
	};

	const sideBarNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: Parts.SIDEBAR_PART },
		size: sideBarSize,
		visible: options.sideBarVisible,
	};

	const auxiliaryBarNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: Parts.AUXILIARYBAR_PART },
		size: auxiliaryBarSize,
		visible: options.auxiliaryBarVisible,
	};

	const omniHostNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: Parts.HUCODE_OMNI_HOST_PART },
		size: omniHostWidth,
		visible: options.omniHostVisible,
	};

	const panelNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: Parts.PANEL_PART },
		size: panelSize,
		visible: options.panelVisible,
	};

	const topRightSection: ISerializedNode = {
		type: 'branch',
		data: [omniHostNode, auxiliaryBarNode],
		size: topRightHeight,
	};

	const rightSection: ISerializedNode = {
		type: 'branch',
		data: [titleBarNode, topRightSection, panelNode],
		size: rightSectionWidth,
	};

	return {
		root: {
			type: 'branch',
			size: height,
			data: [
				sideBarNode,
				rightSection,
			],
		},
		orientation: Orientation.HORIZONTAL,
		width,
		height,
	};
}
