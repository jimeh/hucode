/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRendererReplyTarget } from './window.js';

/**
 * Returns a stable human-readable label for a renderer reply target.
 */
export function hucodeGetRendererReplyTargetLabel(target: IRendererReplyTarget): string {
	if (target.kind === 'window') {
		return `window:${target.windowId}`;
	}

	return `webContents:${target.webContentsId}`;
}

/**
 * Returns a stable key for maps and hashes keyed by renderer reply target.
 */
export function hucodeGetRendererReplyTargetKey(target: IRendererReplyTarget): string {
	if (target.kind === 'window') {
		return `window:${target.windowId}`;
	}

	return `webContents:${target.ownerWindowId}:${target.webContentsId}`;
}

/**
 * Returns whether two renderer reply targets address the same renderer.
 */
export function hucodeIsRendererReplyTargetEqual(
	first: IRendererReplyTarget,
	second: IRendererReplyTarget
): boolean {
	return hucodeGetRendererReplyTargetKey(first) ===
		hucodeGetRendererReplyTargetKey(second);
}

export interface IHucodeRendererReplyTargetLookup<TOwnerWindow, TTargetWindow, TTargetContents> {
	getWindowById(windowId: number): TOwnerWindow | undefined;
	getWindow(ownerWindow: TOwnerWindow): TTargetWindow | undefined;
	getWindowWebContents(targetWindow: TTargetWindow): TTargetContents | undefined;
	getWebContentsById(webContentsId: number): TTargetContents | undefined;
	isWindowDestroyed(targetWindow: TTargetWindow): boolean;
	isWebContentsDestroyed(targetContents: TTargetContents): boolean;
}

export interface IHucodeResolvedRendererReplyTargetWithLookup<TOwnerWindow, TTargetWindow, TTargetContents> {
	readonly ownerWindow: TOwnerWindow;
	readonly targetWindow: TTargetWindow;
	readonly targetContents: TTargetContents;
}

/**
 * Resolves a renderer reply target using an environment-specific lookup.
 */
export function hucodeResolveRendererReplyTargetWithLookup<TOwnerWindow, TTargetWindow, TTargetContents>(
	target: IRendererReplyTarget,
	lookup: IHucodeRendererReplyTargetLookup<TOwnerWindow, TTargetWindow, TTargetContents>
): IHucodeResolvedRendererReplyTargetWithLookup<TOwnerWindow, TTargetWindow, TTargetContents> | undefined {
	const ownerWindow = lookup.getWindowById(
		target.kind === 'window' ? target.windowId : target.ownerWindowId
	);
	const targetWindow = ownerWindow && lookup.getWindow(ownerWindow);
	if (!ownerWindow || !targetWindow || lookup.isWindowDestroyed(targetWindow)) {
		return undefined;
	}

	const targetContents = target.kind === 'window'
		? lookup.getWindowWebContents(targetWindow)
		: lookup.getWebContentsById(target.webContentsId);
	if (!targetContents || lookup.isWebContentsDestroyed(targetContents)) {
		return undefined;
	}

	return { ownerWindow, targetWindow, targetContents };
}
