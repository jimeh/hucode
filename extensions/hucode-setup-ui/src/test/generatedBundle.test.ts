/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION } from '@/generated/editorMigrationSetupProtocol';

const bundlePath = path.join(import.meta.dirname, '..', '..', 'media', 'index.js');

/**
 * Exercises the built bundle, not the source entry point.
 *
 * Everything else in this suite imports modules directly, which cannot catch a packaging or
 * bundling defect. This is the one place that loads exactly the file the webview loads and proves
 * it reaches the bridge, so a bundle that never runs fails here instead of in a blank modal.
 */
describe('generated renderer bundle', () => {
	test('mounts into the bootstrap root and posts ready over the webview bridge', async () => {
		expect(existsSync(bundlePath), `expected a built bundle at ${bundlePath}`).toBe(true);

		const posted: unknown[] = [];
		Object.defineProperty(globalThis, 'acquireVsCodeApi', {
			configurable: true,
			value: () => ({ postMessage: (message: unknown) => posted.push(message) }),
		});
		// The host's bootstrap document ships this fallback; React replaces it on mount.
		document.body.innerHTML = '<div id="root"><p class="hucode-setup-bootstrap">Starting the editor setup import...</p></div>';

		await import(pathToFileURL(bundlePath).href);

		expect(posted).toEqual([
			{ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 0, intent: { type: 'ready' } },
		]);
		// `ready` is posted as soon as the module runs; the concurrent root paints a tick later.
		await vi.waitFor(() => {
			expect(document.querySelector('.hucode-setup-bootstrap')).toBeNull();
			expect(document.getElementById('root')?.children.length).toBeGreaterThan(0);
		});
	});
});
