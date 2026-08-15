/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from
	'../../../base/test/common/utils.js';
import {
	HUCODE_WEB_VERSION_MISMATCH_BLOCKER_ID,
	showHucodeWebVersionMismatchBlocker,
} from '../../browser/hucodeWebVersionMismatch.js';

suite('HucodeWebVersionMismatch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		document.getElementById(HUCODE_WEB_VERSION_MISMATCH_BLOCKER_ID)?.remove();
	});

	test('shows one blocking alertdialog and reloads the browser tab', () => {
		let reloads = 0;
		const existingContent = document.createElement('main');
		document.body.append(existingContent);
		const previousInert = Array.from(document.body.children).map(child => [
			child,
			(child as HTMLElement).inert,
		] as const);
		const first = showHucodeWebVersionMismatchBlocker(
			mainWindow,
			() => reloads++
		);
		const second = showHucodeWebVersionMismatchBlocker(
			mainWindow,
			() => reloads++
		);

		assert.strictEqual(second, first);
		assert.strictEqual(
			document.querySelectorAll(
				`#${HUCODE_WEB_VERSION_MISMATCH_BLOCKER_ID}`
			).length,
			1
		);
		assert.strictEqual(first.getAttribute('role'), 'alertdialog');
		assert.strictEqual(first.getAttribute('aria-modal'), 'true');
		assert.strictEqual(first.style.position, 'fixed');
		assert.strictEqual(first.style.pointerEvents, 'auto');
		assert.strictEqual(existingContent.inert, true);
		assert.strictEqual(
			first.querySelector('h1')?.textContent,
			'Reload Hucode to continue'
		);
		assert.strictEqual(
			first.querySelector('p')?.textContent,
			'The Omni shell and hosted workbench are running different versions ' +
			'of Hucode. Reload the browser tab to continue.'
		);
		const button = first.querySelector('button');
		assert.ok(button);
		assert.strictEqual(button.textContent, 'Reload Hucode');
		assert.strictEqual(document.activeElement, button);
		button.click();
		assert.strictEqual(reloads, 1);
		for (const [child, inert] of previousInert) {
			(child as HTMLElement).inert = inert;
		}
		existingContent.remove();
	});
});
