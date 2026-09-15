/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, expect, type Page } from '@playwright/test';
import { parse } from 'jsonc-parser';
import { EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, type EditorMigrationSetupPresentation } from '../../src/vs/hucode/common/migration/editorMigrationSetupProtocol.ts';

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
			{ id: 'continue', label: 'Import', kind: 'primary', disabled: false, intent: { type: 'acceptReview' } },
		],
	},
	sectionAnnouncementTemplate: 'Showing {0}.',
};

async function mountPresentation(page: Page, state = presentation): Promise<void> {
	const [script, style, prePage] = await Promise.all([
		readFile(new URL('index.js', mediaRoot), 'utf8'),
		readFile(new URL('style.css', mediaRoot), 'utf8'),
		readFile(new URL('../../src/vs/workbench/contrib/webview/browser/pre/index.html', import.meta.url), 'utf8'),
	]);
	const defaults = /defaultStyles\.textContent = `([\s\S]*?)`;/.exec(prePage)?.[1];
	assert.ok(defaults, 'load the actual webview default CSS, including its scrollbar and focus rules');
	await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="vscode-dark"><div id="root"></div></body></html>');
	await page.addStyleTag({ content: defaults });
	await page.addStyleTag({ content: style });
	const message = JSON.stringify({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, type: 'state', revision: state.revision, presentation: state });
	await page.addScriptTag({ content: `window.acquireVsCodeApi = () => ({ postMessage: message => {
		document.body.dataset.lastIntent = JSON.stringify(message.intent);
		if (message.intent.type === 'ready') {
			setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: ${message} })), 0);
		}
	} });` });
	await page.addScriptTag({ type: 'module', content: script });
}

// Load the shipped assets into the same unstyled mounting element as the webview host. jsdom
// tests cannot detect a broken height chain because they do not calculate layout or scrolling.
test('expanded setup review keeps navigation visible and its last item reachable', { timeout: 30_000 }, async t => {
	const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
	t.after(() => browser.close());
	await mkdir(artifacts, { recursive: true });
	for (const viewport of [{ width: 1400, height: 600 }, { width: 600, height: 400 }, { width: 500, height: 300 }]) {
		await t.test(`${viewport.width}x${viewport.height}`, async () => {
			const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			try {
				await mountPresentation(page);
				await page.getByRole('button', { name: 'Show 127 items', exact: true }).click();
				await page.getByRole('button', { name: '212 new settings', exact: true }).click();

				const footer = page.locator('footer');
				const beforeScroll = await footer.boundingBox();
				assert.ok(beforeScroll && beforeScroll.y >= 0 && beforeScroll.y + beforeScroll.height <= viewport.height,
					`footer must stay within the viewport after expansion: ${JSON.stringify(beforeScroll)}`);
				for (const name of ['Back', 'Import']) {
					await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
				}

				const detail = page.locator('[data-focus-id="detail"]');
				for (const content of [page.locator('header > div'), detail.locator('..'), footer.locator(':scope > div')]) {
					const bounds = await content.boundingBox();
					assert.ok(bounds && bounds.x <= 24 && bounds.x + bounds.width >= viewport.width - 24,
						`content must fill the modal with only edge padding: ${JSON.stringify(bounds)}`);
				}
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

async function themeColors(file: URL): Promise<Record<string, string>> {
	const theme: { include?: string; colors?: Record<string, string> } = parse(await readFile(file, 'utf8'));
	return { ...(theme.include ? await themeColors(new URL(theme.include, file)) : {}), ...theme.colors };
}

test('setup owns its palette with visible controls, scrollbars, and keyboard-only focus', { timeout: 30_000 }, async t => {
	// Playwright's headless defaults hide native scrollbars even when their computed CSS is valid.
	const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
	t.after(() => browser.close());
	const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, reducedMotion: 'reduce' });
	await mountPresentation(page, {
		...presentation,
		panels: presentation.panels.map(panel => panel.kind !== 'reviewCategory' ? panel : {
			...panel,
			include: { label: 'Include Settings', category: 'settings', checked: false },
			conflicts: [{
				id: 'fontSize', name: 'editor.fontSize', searchText: 'editor.fontSize', currentValue: '13', importedValue: '14', valuesDescription: 'Current 13, incoming 14',
				choices: [
					{ id: 'keep', label: 'Keep Current', checked: true, intent: { type: 'chooseDecision', decisionId: 'fontSize', choice: 'preserveTarget' } },
					{ id: 'import', label: 'Use Imported', checked: false, intent: { type: 'chooseDecision', decisionId: 'fontSize', choice: 'import' } },
				],
			}],
		}),
	});
	const disclosure = page.getByRole('button', { name: 'Show 127 items', exact: true });
	await disclosure.click();
	await expect(disclosure).toHaveCSS('outline-style', 'none');
	await page.mouse.move(1, 1);
	const detail = page.locator('[data-focus-id="detail"]');
	assert.ok(await detail.evaluate(element => element.scrollHeight > element.clientHeight));
	assert.equal(await detail.evaluate(element => element.offsetWidth - element.clientWidth), 10, 'reserve a visible native scrollbar gutter');
	await mkdir(artifacts, { recursive: true });
	for (const [name, mode] of [
		['2026-dark', 'vscode-dark'], ['2026-light', 'vscode-light'],
		['hc_black', 'vscode-high-contrast'], ['hc_light', 'vscode-high-contrast vscode-high-contrast-light'],
		['fallback', 'vscode-dark'],
	]) {
		const colors = name === 'fallback' ? {} : await themeColors(new URL(`../../extensions/theme-defaults/themes/${name}.json`, import.meta.url));
		await page.locator('html').evaluate((element, { colors, mode }) => {
			element.removeAttribute('style');
			for (const [key, value] of Object.entries(colors)) {
				element.style.setProperty(`--vscode-${key.replaceAll('.', '-')}`, value);
			}
			element.ownerDocument.body.className = mode;
		}, { colors, mode });
		await expect(async () => {
			const actual = await detail.evaluate(element => {
				const document = element.ownerDocument;
				const view = document.defaultView!;
				const probe = document.createElement('span');
				probe.style.setProperty('transition', 'none', 'important');
				document.body.append(probe);
				const resolve = (value: string) => {
					probe.style.color = value;
					return view.getComputedStyle(probe).color;
				};
				const result = {
					background: view.getComputedStyle(document.body).backgroundColor,
					expectedBackground: resolve('var(--hucode-background)'),
					thumb: view.getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
					expectedThumb: resolve('var(--hucode-muted-foreground)'),
				};
				probe.remove();
				return result;
			});
			assert.equal(actual.background, actual.expectedBackground, `${name}: page uses the built-in palette`);
			assert.equal(actual.thumb, actual.expectedThumb, `${name}: scrollbar uses the built-in palette`);
			assert.notEqual(actual.thumb, 'rgba(0, 0, 0, 0)', `${name}: scrollbar must not be transparent`);
		}).toPass({ timeout: 2_000 });
		await assertControlContrast(page);
		await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeInViewport({ ratio: 1 });
		await page.screenshot({ path: new URL(`setup-ui-theme-${name}.png`, artifacts).pathname });
	}
	const bounds = await detail.boundingBox();
	assert.ok(bounds);
	const thumbHeight = await detail.evaluate(element => element.clientHeight ** 2 / element.scrollHeight);
	await page.mouse.move(bounds.x + bounds.width - 5, bounds.y + thumbHeight / 2);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width - 5, bounds.y + thumbHeight / 2 + 80, { steps: 5 });
	await page.mouse.up();
	assert.ok(await detail.evaluate(element => element.scrollTop > 0), 'the native thumb must be draggable');
	await detail.press('Control+Home');
	await page.mouse.move(1, 1);
	// A theme with invisible controls must not leak into the renderer, even on a live update.
	await page.locator('html').evaluate(element => {
		element.style.setProperty('--vscode-button-background', '#123456');
		element.style.setProperty('--vscode-button-foreground', '#fedcba');
		element.style.setProperty('--vscode-focusBorder', '#abcdef');
		element.style.setProperty('--vscode-input-border', 'transparent');
		element.style.setProperty('--vscode-widget-border', 'transparent');
		element.style.setProperty('--vscode-scrollbarSlider-background', 'transparent');
		element.style.setProperty('--vscode-scrollbarSlider-hoverBackground', 'transparent');
		element.style.setProperty('--vscode-scrollbarSlider-activeBackground', 'transparent');
	});
	const importButton = page.getByRole('button', { name: 'Import', exact: true });
	await expect(importButton).toHaveCSS('background-color', 'rgb(91, 141, 239)');
	await expect(importButton).toHaveCSS('color', 'rgb(13, 16, 20)');
	await assertControlContrast(page);
	assert.equal(await detail.evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor), 'rgb(147, 155, 165)');
	await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
	await page.keyboard.press('Tab');
	await importButton.focus();
	await expect(importButton).toHaveCSS('outline-style', 'solid');
	await expect(importButton).toHaveCSS('outline-color', 'rgb(122, 165, 245)');
});

async function assertControlContrast(page: Page): Promise<void> {
	const ratios = await page.locator('body').evaluate(body => {
		const document = body.ownerDocument;
		const view = document.defaultView!;
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const context = canvas.getContext('2d')!;
		const background = view.getComputedStyle(body).backgroundColor;
		const luminance = (...layers: string[]) => {
			context.clearRect(0, 0, 1, 1);
			for (const color of [background, ...layers]) {
				context.fillStyle = color;
				context.fillRect(0, 0, 1, 1);
			}
			const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
				const channel = value / 255;
				return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
			});
			return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
		};
		const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
		return [...document.querySelectorAll('[data-slot="checkbox"], [data-slot="radio-group-item"], footer button')].map(element => {
			const style = view.getComputedStyle(element);
			const textButton = element.getAttribute('data-slot') === 'button';
			const checked = element.getAttribute('data-state') === 'checked';
			return {
				label: element.getAttribute('data-slot'),
				minimum: textButton ? 4.5 : 3,
				ratio: textButton
					? contrast(luminance(style.backgroundColor, style.color), luminance(style.backgroundColor))
					: Math.min(contrast(luminance(style.borderColor), luminance()), checked
						? contrast(luminance(style.backgroundColor, style.color), luminance(style.backgroundColor))
						: contrast(luminance(style.borderColor), luminance(style.backgroundColor))),
			};
		});
	});
	assert.equal(ratios.length, 5, 'check both radio states, the unchecked checkbox, and both footer buttons');
	for (const { label, minimum, ratio } of ratios) {
		assert.ok(ratio >= minimum, `${label}: contrast ${ratio.toFixed(2)} must be at least ${minimum}`);
	}
}

test('snippet comparisons expand in the main pane with horizontal choices and fixed navigation', { timeout: 30_000 }, async t => {
	const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
	t.after(() => browser.close());
	const current = JSON.stringify({ Benchmark: { prefix: 'bench', body: ['func Benchmark(b *testing.B) {', ...Array.from({ length: 20 }, (_, i) => `\t// current line ${i}`), '}'] }, CurrentOnly: { body: ['kept only with current file'] } }, null, 2);
	const imported = JSON.stringify({ Benchmark: { prefix: 'benchmark', description: 'Measure allocations', body: ['func Benchmark(b *testing.B) {', '\tb.ReportAllocs()', '\tfor b.Loop() {', `\t\t${'longFunctionName'.repeat(40)}()`, '\t}', '}'] } }, null, 2);
	const state: EditorMigrationSetupPresentation = {
		...presentation, defaultSectionId: 'snippets',
		footer: { ...presentation.footer, lines: ['Default into Default.', 'Current snippet file will be kept.'] },
		sections: [{ id: 'snippets', label: 'Snippets', status: 'attention', statusDescription: 'One file differs', count: 0 }],
		panels: [{
			kind: 'reviewCategory', id: 'snippets', heading: 'Snippets', lead: 'One snippet file differs.', ownership: 'Stored directly in Default.', warnings: [],
			conflicts: [{
				id: 'snippet', name: 'go.json', searchText: 'go.json', currentValue: current, importedValue: imported, valuesDescription: 'Snippet contents',
				comparison: { currentLabel: 'Current', importedLabel: 'Incoming', expandLabel: 'Show Full Comparison', collapseLabel: 'Show Less', note: 'Use Imported replaces this entire file. Snippets found only in Current will be removed.' },
				choices: [
					{ id: 'keep', label: 'Keep Current', checked: true, intent: { type: 'chooseDecision', decisionId: 'snippet', choice: 'preserveTarget' } },
					{ id: 'replace', label: 'Use Imported', checked: false, intent: { type: 'chooseDecision', decisionId: 'snippet', choice: 'import' } },
				],
			}],
		}],
	};
	await mkdir(artifacts, { recursive: true });
	for (const viewport of [{ width: 1100, height: 780 }, { width: 500, height: 400 }]) {
		await t.test(`${viewport.width}x${viewport.height}`, async () => {
			const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
			t.after(() => page.close());
			await mountPresentation(page, state);
			const footer = page.locator('footer');
			await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeInViewport({ ratio: 1 });
			const footerBounds = await footer.boundingBox();
			const keep = page.getByRole('radio', { name: 'Keep Current' });
			const replace = page.getByRole('radio', { name: 'Use Imported' });
			await keep.scrollIntoViewIfNeeded();
			const keepBounds = await keep.boundingBox();
			const replaceBounds = await replace.boundingBox();
			assert.ok(keepBounds && replaceBounds && Math.abs(keepBounds.y - replaceBounds.y) < 2 && replaceBounds.x > keepBounds.x, 'choices share one horizontal row');
			await replace.click();
			assert.deepStrictEqual(JSON.parse((await page.locator('body').getAttribute('data-last-intent'))!), { type: 'chooseDecision', decisionId: 'snippet', choice: 'import' });
			await page.getByRole('button', { name: 'Show Full Comparison' }).click();
			assert.equal(await page.getByLabel('Current', { exact: true }).textContent(), current);
			assert.equal(await page.getByLabel('Incoming', { exact: true }).textContent(), imported);
			await page.locator('[data-focus-id="detail"]').press('Control+End');
			await expect(replace).toBeInViewport({ ratio: 1 });
			assert.deepStrictEqual(await footer.boundingBox(), footerBounds);
			assert.ok(await page.locator('[data-focus-id="detail"]').evaluate(element => element.scrollWidth <= element.clientWidth), 'long code wraps instead of widening the page');
			await page.getByRole('button', { name: 'Show Less' }).click();
			await page.locator('[data-focus-id="detail"]').press('Control+Home');
			await page.screenshot({ path: new URL(`setup-ui-snippets-${viewport.width}.png`, artifacts).pathname });
		});
	}
});
