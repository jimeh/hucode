/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BrowserView } from './browserView.js';

/**
 * Tracks integrated browser views owned by hosted Omni workbench webContents.
 */
export class BrowserViewHostedWebContents {
	private readonly visibility = new Map<number, boolean>();

	isVisible(hostedWebContentsId: number | undefined): boolean {
		if (typeof hostedWebContentsId !== 'number') {
			return true;
		}

		return this.visibility.get(hostedWebContentsId) ?? true;
	}

	setVisible(
		hostedWebContentsId: number,
		visible: boolean,
		views: Iterable<BrowserView>
	): void {
		this.visibility.set(hostedWebContentsId, visible);
		for (const view of views) {
			view.setHostedWebContentsVisible(hostedWebContentsId, visible);
		}
	}

	bringToFront(
		hostedWebContentsId: number,
		views: Iterable<BrowserView>
	): void {
		for (const view of views) {
			view.bringToFrontForHostedWebContents(hostedWebContentsId);
		}
	}

	delete(hostedWebContentsId: number): void {
		this.visibility.delete(hostedWebContentsId);
	}

	getOwnedViewIds(
		hostedWebContentsId: number,
		views: Iterable<[string, BrowserView]>
	): string[] {
		return Array.from(views)
			.filter(([, view]) =>
				view.belongsToHostedWebContents(hostedWebContentsId)
			)
			.map(([id]) => id);
	}
}
