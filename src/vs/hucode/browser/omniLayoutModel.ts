/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ISerializedGrid,
	ISerializedLeafNode,
	ISerializedNode,
	Orientation,
} from '../../base/browser/ui/grid/grid.js';
import { Parts } from '../../workbench/services/layout/browser/layoutService.js';

/**
 * Inputs describing the Omni window size and which workbench parts are visible,
 * used to build the serialized grid layout.
 */
export interface IOmniLayoutDescriptorOptions {
	readonly width: number;
	readonly height: number;
	readonly titleBarHeight: number;
	readonly titleBarVisible?: boolean;
	readonly sideBarVisible: boolean;
	readonly auxiliaryBarVisible: boolean;
	readonly omniHostVisible: boolean;
	readonly panelVisible: boolean;
}

/**
 * Builds the serialized grid layout for the Omni window from the given size and
 * part-visibility options.
 */
export function createOmniGridDescriptor(
	options: IOmniLayoutDescriptorOptions
): ISerializedGrid {
	const { width, height } = options;

	const sideBarSize = 300;
	const auxiliaryBarSize = 380;
	const panelSize = 300;
	const titleBarVisible = options.titleBarVisible ?? true;
	const titleBarHeight = options.titleBarHeight;
	const rightSectionWidth = Math.max(0, width - sideBarSize);
	const omniHostWidth = Math.max(0, rightSectionWidth - auxiliaryBarSize);
	const contentHeight = height - (titleBarVisible ? titleBarHeight : 0);
	const topRightHeight = Math.max(0, contentHeight - panelSize);

	const titleBarNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: Parts.TITLEBAR_PART },
		size: titleBarHeight,
		visible: titleBarVisible,
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
