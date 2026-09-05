/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, type EditorMigrationSetupPresentation } from '../../extensions/hucode-setup-ui/src/generated/editorMigrationSetupProtocol.ts';

const mediaRoot = new URL('../../extensions/hucode-setup-ui/media/', import.meta.url);
const artifacts = new URL('../../.build/hucode-smoke-artifacts/', import.meta.url);
const presentation: EditorMigrationSetupPresentation = {
	revision: 1,
	phase: 'review',
	regionLabel: 'Editor Setup Import',
	title: 'Import Setup from Another Editor',
	steps: [{ id: 'review', label: 'Review', current: true }],
	busy: false,
	canceling: false,
	scopeKey: 'review|layout-smoke',
	sections: [{ id: 'settings', label: 'Settings', status: 'attention', statusDescription: 'Needs review', count: 212 }],
	railLabel: 'Review sections',
	railTitle: 'Review',
	panels: [{
		kind: 'reviewCategory', id: 'settings', heading: 'Settings',
		lead: '212 settings will be imported.', ownership: 'Stored directly in Default.',
		conflicts: [],
		warnings: [{
			id: 'schema', title: 'Settings without a registered schema', count: 127, countDescription: '127 settings',
			disclosure: { id: 'schema-items', summary: 'Show 127 items', items: Array.from({ length: 25 }, (_, i) => `editor.unknownSetting${i}`), remainingText: 'and 102 more.' },
		}],
		additions: { id: 'additions', summary: '212 new settings', items: Array.from({ length: 25 }, (_, i) => `editor.newSetting${i}`), remainingText: 'and 187 more.' },
	}],
	footer: {
		lines: ['Default into Default.', '212 items ready to import.'],
		actions: [
			{ id: 'back', label: 'Back', kind: 'default', disabled: false, intent: { type: 'back' } },
			{ id: 'continue', label: 'Continue', kind: 'primary', disabled: false, intent: { type: 'acceptReview' } },
		],
	},
	sectionAnnouncementTemplate: 'Showing {0}.',
};

// Load the shipped assets into the same unstyled mounting element as the webview host. jsdom
// tests cannot detect a broken height chain because they do not calculate layout or scrolling.
test('expanded setup review keeps navigation visible and its last item reachable', { timeout: 30_000 }, async t => {
	const browser = await chromium.launch();
	t.after(() => browser.close());
	const script = await readFile(new URL('index.js', mediaRoot), 'utf8');
	const style = await readFile(new URL('style.css', mediaRoot), 'utf8');
	await mkdir(artifacts, { recursive: true });
	for (const viewport of [{ width: 1000, height: 600 }, { width: 600, height: 400 }, { width: 500, height: 300 }]) {
		await t.test(`${viewport.width}x${viewport.height}`, async () => {
			const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			try {
				await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="vscode-dark"><div id="root"></div></body></html>');
				await page.addStyleTag({ content: style });
				const message = JSON.stringify({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, type: 'state', revision: 1, presentation });
				await page.addScriptTag({ content: `window.acquireVsCodeApi = () => ({ postMessage: message => {
					if (message.intent.type === 'ready') {
						setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: ${message} })), 0);
					}
				} });` });
				await page.addScriptTag({ type: 'module', content: script });
				await page.getByRole('button', { name: 'Show 127 items', exact: true }).click();
				await page.getByRole('button', { name: '212 new settings', exact: true }).click();

				const footer = page.locator('footer');
				const beforeScroll = await footer.boundingBox();
				assert.ok(beforeScroll && beforeScroll.y >= 0 && beforeScroll.y + beforeScroll.height <= viewport.height,
					`footer must stay within the viewport after expansion: ${JSON.stringify(beforeScroll)}`);
				for (const name of ['Back', 'Continue']) {
					await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
				}

				const detail = page.locator('[data-focus-id="detail"]');
				// Exercise keyboard scrolling, not a programmatic scroll that can bypass overflow rules.
				await detail.press('Control+End');
				await expect(page.getByText('and 187 more.', { exact: true })).toBeInViewport({ ratio: 1 });
				assert.ok(await detail.evaluate(element => element.scrollTop > 0), 'the detail pane must scroll');
				assert.deepStrictEqual(await footer.boundingBox(), beforeScroll, 'scrolling content must not move the footer');
				await detail.press('Control+Home');
				await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeInViewport({ ratio: 1 });
				assert.deepStrictEqual(errors, [], 'renderer errors');
			} finally {
				await page.screenshot({ path: new URL(`setup-ui-layout-${viewport.width}x${viewport.height}.png`, artifacts).pathname });
				await page.close();
			}
		});
	}
});
