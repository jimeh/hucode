/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as electron from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { IRendererReplyTarget } from '../../../../platform/window/common/window.js';
import { hucodeResolveRendererReplyTargetWithLookup } from '../common/rendererReplyTarget.js';
import type { ICodeWindow } from '../../../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';

export interface IHucodeResolvedRendererReplyTarget {
	readonly ownerWindow: ICodeWindow;
	readonly targetWindow: BrowserWindow;
	readonly targetContents: WebContents;
}

/**
 * Resolves a renderer reply target to its owning window and destination
 * `WebContents`.
 */
export function hucodeResolveRendererReplyTarget(
	windowsMainService: IWindowsMainService,
	target: IRendererReplyTarget
): IHucodeResolvedRendererReplyTarget | undefined {
	return hucodeResolveRendererReplyTargetWithLookup(target, {
		getWindowById: windowId => windowsMainService.getWindowById(windowId),
		getWindow: ownerWindow => ownerWindow.win ?? undefined,
		getWindowWebContents: targetWindow => targetWindow.webContents,
		getWebContentsById: webContentsId =>
			electron.webContents?.fromId(webContentsId),
		isWindowDestroyed: targetWindow => targetWindow.isDestroyed(),
		isWebContentsDestroyed: targetContents => targetContents.isDestroyed(),
	});
}
