/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ILogService } from '../../log/common/log.js';
import type { ICodeWindow } from '../../window/electron-main/window.js';
import type { IAuxiliaryWindow } from '../../auxiliaryWindow/electron-main/auxiliaryWindow.js';
import type {
	IBrowserViewBounds,
	IBrowserViewOwner
} from '../common/browserView.js';
import { toBrowserViewWindowBounds } from '../common/browserViewLayout.js';

type BrowserViewHostWindow = ICodeWindow | IAuxiliaryWindow;
type BrowserViewHostWindowResolver =
	(windowId: number | undefined) => BrowserViewHostWindow | undefined;

/**
 * Owns native Electron view attachment, visibility, and host-relative layout.
 */
export class BrowserViewNativeHost {
	private currentWindow: BrowserViewHostWindow | undefined;
	private parentView: Electron.View | undefined;
	private hostedWebContentsId: number | undefined;
	private lastLayoutBounds: IBrowserViewBounds | undefined;
	private hostVisible = true;
	private requestedVisible = true;
	private hasBeenLaidOut = false;

	constructor(
		private readonly view: Electron.WebContentsView,
		ownerWindow: ICodeWindow,
		private readonly logService: ILogService,
	) {
		this.currentWindow = ownerWindow;
		this.parentView = ownerWindow.win?.contentView;
		this.parentView?.addChildView(this.view);
	}

	layout(
		bounds: IBrowserViewBounds,
		hostVisible: boolean,
		resolveWindow: BrowserViewHostWindowResolver
	): void {
		this.lastLayoutBounds = bounds;
		this.doLayout(bounds, hostVisible, resolveWindow);
	}

	setVisible(visible: boolean): void {
		this.requestedVisible = visible;

		if (!visible && this.view.webContents.isFocused()) {
			this.currentWindow?.win?.webContents.focus();
		}

		this.applyVisibility();
	}

	setHostedWebContentsVisible(
		hostedWebContentsId: number,
		visible: boolean,
		resolveWindow: BrowserViewHostWindowResolver
	): void {
		if (this.hostedWebContentsId !== hostedWebContentsId) {
			return;
		}

		this.hostVisible = visible;
		const didRelayout = visible
			&& this.relayoutForHostedWebContents(
				hostedWebContentsId,
				resolveWindow
			);
		if (!didRelayout) {
			this.applyVisibility();
		}
		if (visible) {
			this.bringToFront();
		}
	}

	bringToFrontForHostedWebContents(
		hostedWebContentsId: number,
		resolveWindow: BrowserViewHostWindowResolver
	): void {
		if (this.hostedWebContentsId !== hostedWebContentsId) {
			return;
		}

		this.relayoutForHostedWebContents(hostedWebContentsId, resolveWindow);
		this.bringToFront();
	}

	belongsToHostedWebContents(
		owner: IBrowserViewOwner,
		hostedWebContentsId: number
	): boolean {
		return owner.hostedWebContentsId === hostedWebContentsId
			|| this.hostedWebContentsId === hostedWebContentsId;
	}

	isWindowFocused(): boolean {
		return !!this.currentWindow?.win?.isFocused();
	}

	getWindowRelativeBounds(): Electron.Rectangle {
		return this.view.getBounds();
	}

	getElectronWindow(): Electron.BrowserWindow | undefined {
		return this.currentWindow?.win ?? undefined;
	}

	removeFromParent(): void {
		const currentWin = this.currentWindow?.win;
		if (currentWin && !currentWin.isDestroyed()) {
			this.parentView?.removeChildView(this.view);
		}
	}

	private doLayout(
		bounds: IBrowserViewBounds,
		hostVisible: boolean,
		resolveWindow: BrowserViewHostWindowResolver
	): void {
		const newWindow = resolveWindow(bounds.windowId);
		if (!newWindow?.win) {
			return;
		}

		const parentView = newWindow.win.contentView;
		const hostView = this.resolveHostView(
			parentView,
			bounds.hostedWebContentsId
		);

		if (
			this.currentWindow !== newWindow
			|| this.parentView !== parentView
		) {
			this.parentView?.removeChildView(this.view);
			this.currentWindow = newWindow;
			this.parentView = parentView;
			parentView.addChildView(this.view);
		}
		this.hostedWebContentsId = bounds.hostedWebContentsId;
		this.hostVisible = typeof bounds.hostedWebContentsId === 'number'
			? hostVisible
			: true;

		const hostOffset = hostView
			? this.getWindowRelativeViewOffset(hostView)
			: undefined;

		this.view.setBounds(toBrowserViewWindowBounds(bounds, hostOffset));
		this.hasBeenLaidOut = true;
		this.applyVisibility();
		this.bringToFront();
	}

	private relayoutForHostedWebContents(
		hostedWebContentsId: number,
		resolveWindow: BrowserViewHostWindowResolver
	): boolean {
		if (
			this.lastLayoutBounds?.hostedWebContentsId !== hostedWebContentsId
		) {
			return false;
		}

		this.doLayout(this.lastLayoutBounds, this.hostVisible, resolveWindow);
		return true;
	}

	private resolveHostView(
		contentView: Electron.View,
		hostedWebContentsId: number | undefined
	): Electron.WebContentsView | undefined {
		if (typeof hostedWebContentsId !== 'number') {
			return undefined;
		}

		const hostView = this.findWebContentsView(
			contentView,
			hostedWebContentsId
		);
		if (!hostView) {
			this.logService.warn(
				`[BrowserView] Unable to find hosted WebContentsView ` +
				`${hostedWebContentsId}; falling back to window contentView.`
			);
			return undefined;
		}

		return hostView;
	}

	private findWebContentsView(
		parentView: Electron.View,
		webContentsId: number
	): Electron.WebContentsView | undefined {
		for (const childView of parentView.children) {
			if (isWebContentsView(childView)
				&& childView.webContents.id === webContentsId) {
				return childView;
			}

			const nestedView = this.findWebContentsView(
				childView,
				webContentsId
			);
			if (nestedView) {
				return nestedView;
			}
		}

		return undefined;
	}

	private getWindowRelativeViewOffset(
		targetView: Electron.View
	): { x: number; y: number } | undefined {
		const contentView = this.currentWindow?.win?.contentView;
		if (!contentView) {
			return undefined;
		}

		return this.getViewOffset(contentView, targetView, { x: 0, y: 0 });
	}

	private getViewOffset(
		parentView: Electron.View,
		targetView: Electron.View,
		parentOffset: { x: number; y: number }
	): { x: number; y: number } | undefined {
		if (parentView === targetView) {
			return parentOffset;
		}

		for (const childView of parentView.children) {
			const childBounds = childView.getBounds();
			const childOffset = {
				x: parentOffset.x + childBounds.x,
				y: parentOffset.y + childBounds.y
			};
			const offset = this.getViewOffset(
				childView,
				targetView,
				childOffset
			);
			if (offset) {
				return offset;
			}
		}

		return undefined;
	}

	private applyVisibility(): void {
		const visible = this.requestedVisible && this.hostVisible;
		if (visible && !this.hasBeenLaidOut) {
			// The initial view bounds are on-screen placeholders; defer the
			// first show until a real layout has positioned the view.
			return;
		}
		if (this.view.getVisible() === visible) {
			return;
		}

		this.view.setVisible(visible);
	}

	private bringToFront(): void {
		if (!this.view.getVisible()) {
			return;
		}

		this.parentView?.addChildView(this.view);
	}
}

function isWebContentsView(view: Electron.View): view is Electron.WebContentsView {
	return typeof (view as Partial<Electron.WebContentsView>).webContents?.id
		=== 'number';
}
