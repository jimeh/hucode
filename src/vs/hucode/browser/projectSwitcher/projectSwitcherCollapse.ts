/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface IProjectSwitcherCollapseTree<T> {
	isCollapsible(item: T): boolean;
	isCollapsed(item: T): boolean;
	expand(item: T): unknown;
	collapse(item: T): unknown;
}

/**
 * Toggles a project row and records only collapse changes the tree can apply.
 */
export function toggleProjectTreeItemCollapsed<T>(
	tree: IProjectSwitcherCollapseTree<T>,
	item: T,
	setCollapsed: (collapsed: boolean) => void
): void {
	if (!tree.isCollapsible(item)) {
		return;
	}

	const collapsed = tree.isCollapsed(item);
	if (collapsed) {
		tree.expand(item);
		setCollapsed(false);
		return;
	}

	tree.collapse(item);
	setCollapsed(true);
}
