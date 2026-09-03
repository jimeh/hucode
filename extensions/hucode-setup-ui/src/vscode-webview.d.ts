/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Minimal surface of the webview bridge the renderer uses. State persistence is not used. */
interface HucodeWebviewApi {
	postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): HucodeWebviewApi;
