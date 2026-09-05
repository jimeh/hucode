/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '@testing-library/jest-dom/vitest';

// jsdom implements no layout, and the Radix primitives probe several of these APIs.
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => { };
}
if (!globalThis.ResizeObserver) {
	// The virtualizer learns its viewport from this callback, so the stub reports the observed
	// element's rect once rather than staying silent and leaving every list unmeasured.
	globalThis.ResizeObserver = class {
		constructor(private readonly callback: ResizeObserverCallback) { }

		observe(target: Element): void {
			this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
		}

		unobserve(): void { }
		disconnect(): void { }
	} as unknown as typeof ResizeObserver;
}
// jsdom never reports the document as focused, so every focus-recovery path would look like the
// workbench had taken the caret. The mounted webview normally does own focus; the test that cares
// about the opposite overrides this.
Object.defineProperty(document, 'hasFocus', { configurable: true, writable: true, value: () => true });

if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => { };
	Element.prototype.releasePointerCapture = () => { };
}
