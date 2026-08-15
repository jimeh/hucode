/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';

export const HUCODE_WEB_VERSION_MISMATCH_BLOCKER_ID =
	'hucode-web-version-mismatch-blocker';

/**
 * Shows the one non-dismissible blocker used when an Omni web shell and its
 * hosted workbench do not come from the same Hucode build.
 */
export function showHucodeWebVersionMismatchBlocker(
	sourceWindow: Window = mainWindow,
	reload?: () => void
): HTMLElement {
	let targetWindow = sourceWindow;
	let targetDocument = sourceWindow.document;
	try {
		if (sourceWindow.top) {
			targetDocument = sourceWindow.top.document;
			targetWindow = sourceWindow.top;
		}
	} catch {
		// A cross-origin embed cannot reach its top document. Blocking the current
		// document still fails closed and leaves the full reload action available.
	}

	const container = targetDocument.body ?? targetDocument.documentElement;
	const existing = Array.from(container.children).find(child =>
		child.id === HUCODE_WEB_VERSION_MISMATCH_BLOCKER_ID
	) as HTMLElement | undefined;
	if (existing) {
		return existing;
	}

	const overlay = targetDocument.createElement('div');
	overlay.id = HUCODE_WEB_VERSION_MISMATCH_BLOCKER_ID;
	overlay.setAttribute('role', 'alertdialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-labelledby', `${overlay.id}-title`);
	overlay.setAttribute('aria-describedby', `${overlay.id}-description`);
	overlay.style.cssText = [
		'position:fixed',
		'inset:0',
		'z-index:2147483647',
		'display:flex',
		'align-items:center',
		'justify-content:center',
		'box-sizing:border-box',
		'padding:32px',
		'background:var(--vscode-editor-background,#1e1e1e)',
		'color:var(--vscode-foreground,#f0f0f0)',
		'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
		'pointer-events:auto',
		'user-select:none',
	].join(';');

	const content = targetDocument.createElement('div');
	content.style.cssText = 'max-width:520px;text-align:center';

	const title = targetDocument.createElement('h1');
	title.id = `${overlay.id}-title`;
	title.textContent = 'Reload Hucode to continue';
	title.style.cssText = 'margin:0 0 12px;font-size:20px;font-weight:600';

	const description = targetDocument.createElement('p');
	description.id = `${overlay.id}-description`;
	description.textContent =
		'The Omni shell and hosted workbench are running different versions ' +
		'of Hucode. Reload the browser tab to continue.';
	description.style.cssText = 'margin:0 0 20px;line-height:1.5';

	const button = targetDocument.createElement('button');
	button.type = 'button';
	button.textContent = 'Reload Hucode';
	button.style.cssText = [
		'border:1px solid transparent',
		'border-radius:2px',
		'padding:6px 14px',
		'background:var(--vscode-button-background,#0e639c)',
		'color:var(--vscode-button-foreground,#fff)',
		'font:inherit',
		'cursor:pointer',
	].join(';');
	button.addEventListener('click', () => {
		if (reload) {
			reload();
		} else {
			targetWindow.location.reload();
		}
	});

	content.append(title, description, button);
	overlay.append(content);
	setSiblingElementsInert(container, overlay);
	container.append(overlay);
	const observer = new MutationObserver(() => {
		if (!overlay.isConnected) {
			observer.disconnect();
			return;
		}
		setSiblingElementsInert(container, overlay);
	});
	observer.observe(container, { childList: true });
	button.focus();
	return overlay;
}

function setSiblingElementsInert(
	container: Element,
	overlay: HTMLElement
): void {
	for (const child of container.children) {
		if (child !== overlay) {
			(child as HTMLElement).inert = true;
		}
	}
}
