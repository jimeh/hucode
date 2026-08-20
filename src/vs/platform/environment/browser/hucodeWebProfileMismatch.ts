/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../base/browser/window.js';
import { localize } from '../../../nls.js';

export const HUCODE_WEB_PROFILE_MISMATCH_BLOCKER_ID =
	'hucode-web-profile-mismatch-blocker';

/** Shows a non-dismissible startup blocker for an invalid Omni profile owner. */
export function showHucodeWebProfileMismatchBlocker(
	sourceWindow: Window = mainWindow
): HTMLElement {
	let targetDocument = sourceWindow.document;
	try {
		if (sourceWindow.top) {
			targetDocument = sourceWindow.top.document;
		}
	} catch {
		// A cross-origin parent cannot be modified. The current document still
		// fails closed below.
	}

	const container = targetDocument.body ?? targetDocument.documentElement;
	const existing = Array.from(container.children).find(child =>
		child.id === HUCODE_WEB_PROFILE_MISMATCH_BLOCKER_ID
	);
	if (existing) {
		return existing as HTMLElement;
	}

	const overlay = targetDocument.createElement('div');
	overlay.id = HUCODE_WEB_PROFILE_MISMATCH_BLOCKER_ID;
	overlay.setAttribute('role', 'alert');
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
		'text-align:center',
	].join(';');

	const content = targetDocument.createElement('div');
	content.style.cssText = 'max-width:520px';
	const title = targetDocument.createElement('h1');
	title.textContent = localize(
		'hucodeWebProfileMismatchTitle',
		'Unable to open this Omni profile'
	);
	title.style.cssText = 'margin:0 0 12px;font-size:20px;font-weight:600';
	const description = targetDocument.createElement('p');
	description.textContent = localize(
		'hucodeWebProfileMismatchDescription',
		'The selected profile is unavailable or does not match the Omni shell. Close this page and open the profile again from Hucode.'
	);
	description.style.cssText = 'margin:0;line-height:1.5';
	content.append(title, description);
	overlay.append(content);
	for (const child of container.children) {
		(child as HTMLElement).inert = true;
	}
	container.append(overlay);
	return overlay;
}
