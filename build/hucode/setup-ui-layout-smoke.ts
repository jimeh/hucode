/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, expect, type Page } from '@playwright/test';
import { parse } from 'jsonc-parser';
import {
	EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
	type EditorMigrationSetupDensity,
	type EditorMigrationSetupListPreviewRow,
	type EditorMigrationSetupPanel,
	type EditorMigrationSetupPresentation,
} from '../../src/vs/hucode/common/migration/editorMigrationSetupProtocol.ts';

const mediaRoot = new URL('../../extensions/hucode-setup-ui/media/', import.meta.url);
const artifacts = new URL('../../.build/hucode-smoke-artifacts/', import.meta.url);
const presentation: EditorMigrationSetupPresentation = {
	revision: 1,
	route: 'import',
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

async function assertControlContrast(page: Page, expectedControls = 5): Promise<void> {
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
	assert.equal(ratios.length, expectedControls, 'measure every radio, checkbox, and footer button the panel draws');
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

// #region onboarding

type OnboardingStage = 'bring' | 'appearance' | 'meetOmni';

/**
 * Wraps one onboarding panel the way `onboardingPresentation()` does: the onboarding identity and
 * step header, no rail, and the footer the stage owns. The strings mirror the core presentation so
 * the screenshots read as the real stages.
 */
function onboardingSnapshot(stage: OnboardingStage, panel: EditorMigrationSetupPanel, mode: 'firstRun' | 'rerun' = 'firstRun'): EditorMigrationSetupPresentation {
	const action = (id: string, label: string, intent: EditorMigrationSetupPresentation['footer']['actions'][number]['intent'], kind: 'default' | 'primary' = 'default') =>
		({ id, label, kind, disabled: false, intent });
	const back = action('back', 'Back', { type: 'back' });
	const footers: Record<OnboardingStage, EditorMigrationSetupPresentation['footer']> = {
		bring: { lines: [], actions: [action('skip', 'Skip', { type: 'skip' }), action('later', 'Do This Later', { type: 'close' })] },
		appearance: { lines: [], actions: [back, action('appearance-continue', 'Continue', { type: 'continueStage' }, 'primary')] },
		meetOmni: {
			lines: [],
			actions: [
				back,
				action('add-project', 'Add Project', { type: 'addProject' }),
				action('open-workbench', 'Open Folder as Workbench', { type: 'openFolderAsWorkbench' }),
				action('finish', 'Finish for Now', { type: 'finishForNow' }, 'primary'),
			],
		},
	};
	const current = stage === 'meetOmni' ? 'meetOmni' : 'bring';
	return {
		revision: 1,
		route: 'onboarding',
		phase: stage,
		regionLabel: 'Hucode Onboarding',
		title: 'Welcome to Hucode',
		steps: [
			{ id: 'bring', label: 'Bring Your Setup', current: current === 'bring' },
			{ id: 'review', label: 'Review', current: false },
			{ id: 'meetOmni', label: 'Meet Omni', current: current === 'meetOmni' },
		],
		busy: false,
		canceling: false,
		sections: [],
		scopeKey: `onboarding|${stage}|${mode}`,
		panels: [panel],
		footer: footers[stage],
		sectionAnnouncementTemplate: 'Showing {0}.',
	};
}

function bringSnapshot(mode: 'firstRun' | 'rerun'): EditorMigrationSetupPresentation {
	const choices = [
		{
			id: 'migrate' as const,
			label: mode === 'rerun' ? 'Start a New Import' : 'Import from Another Editor',
			detail: 'Bring settings, keyboard shortcuts, snippets, and extensions from a supported editor installed on this machine. You review everything before anything is written.',
		},
		{ id: 'skipImport' as const, label: 'Skip Import', detail: 'Continue without importing from another editor. Nothing you have already configured is removed.' },
	];
	return onboardingSnapshot('bring', mode === 'rerun'
		? {
			kind: 'bring', id: '', heading: 'Onboarding Is Already Complete',
			lead: 'You completed onboarding 3 days ago without importing from another editor. Reopening it changes nothing on its own.',
			paragraphs: ['Nothing runs on its own. Choose a route to go through onboarding again, or leave: Skip records that you chose not to, and Do This Later closes this window and keeps your existing choice.'],
			choices,
		}
		: {
			kind: 'bring', id: '', heading: 'Bring Your Setup to Hucode',
			lead: 'Import settings, keyboard shortcuts, snippets, and extensions from another editor, or continue without importing.',
			paragraphs: ['Do This Later keeps your place, so onboarding reopens on this step when you come back to it. You can reopen it at any time with the Hucode: Open Onboarding command in the Command Palette.'],
			choices,
		}, mode);
}

const themeCount = 200;

function appearanceSnapshot(): EditorMigrationSetupPresentation {
	const themes = (scheme: 'light' | 'dark') => Array.from({ length: themeCount }, (_, i) => ({ id: `${scheme}-${i}`, label: `${scheme === 'light' ? 'Light' : 'Dark'} Theme ${i}` }));
	const mode = (id: 'system' | 'light' | 'dark', label: string, description: string, checked: boolean) =>
		({ id, label, description, checked, intent: { type: 'selectMode' as const, mode: id } });
	return onboardingSnapshot('appearance', {
		kind: 'appearance', id: '', heading: 'Choose How Hucode Looks',
		lead: 'Choose whether Hucode follows your system, and which light and dark themes it uses. These values are written to the Default profile, which the Omni shell uses.',
		paragraphs: [
			'Nothing you have already configured is removed. Continue writes only the values you change here.',
			'You can still bring settings, keyboard shortcuts, snippets, and extensions from another editor at any time with the Import Setup from Another Editor command in the Command Palette.',
		],
		modeGroupLabel: 'Appearance mode',
		modes: [
			mode('system', 'System', 'Follow the operating system\'s light or dark setting, using the preferred themes below.', true),
			mode('light', 'Light', 'Always use the preferred light theme.', false),
			mode('dark', 'Dark', 'Always use the preferred dark theme.', false),
		],
		light: { label: 'Preferred light theme', filterLabel: 'Filter light themes', listLabel: 'Light themes', noMatchText: 'Nothing matches the current filter.', selectedId: 'light-0', themes: themes('light') },
		dark: { label: 'Preferred dark theme', filterLabel: 'Filter dark themes', listLabel: 'Dark themes', noMatchText: 'Nothing matches the current filter.', selectedId: 'dark-0', themes: themes('dark') },
	});
}

/**
 * The preview rows exactly as `getProjectSwitcherPresentationFields()` resolves the core
 * presentation's synthetic items: `default` keeps a worktree's path and a workbench's branch, and
 * `compact` drops them.
 */
function previewRows(density: EditorMigrationSetupDensity): EditorMigrationSetupListPreviewRow[] {
	const compact = density === 'compact';
	return [
		{ id: 'project', kind: 'project', name: 'hucode', branch: '~/Projects' },
		{ id: 'worktree-main', kind: 'worktree', name: 'local', branch: 'main', path: compact ? undefined : '~/Projects/hucode' },
		{ id: 'worktree-linked', kind: 'worktree', name: 'login-form', branch: 'feature/login-form', path: compact ? undefined : '~/Projects/hucode.worktrees/login-form' },
		{ id: 'workbench', kind: 'workbench', name: 'notes', branch: compact ? undefined : 'main', path: '~/Documents/notes' },
	];
}

function meetOmniSnapshot(density: EditorMigrationSetupDensity): EditorMigrationSetupPresentation {
	const compact = density === 'compact';
	return onboardingSnapshot('meetOmni', {
		kind: 'meetOmni', id: '', heading: 'Meet Omni',
		lead: 'Omni is Hucode\'s outer shell. It keeps your projects and their worktrees in one sidebar and switches between loaded workbenches without opening another window.',
		glossary: [
			{ term: 'Project', definition: 'A saved Git repository. Hucode discovers its worktrees and nests them beneath it.' },
			{ term: 'Worktree', definition: 'One checkout belonging to a project. Selecting it opens or activates a workbench for that checkout.' },
			{ term: 'Workbench', definition: 'A VS Code window hosted inside Omni for one folder, or any saved folder that is not a project worktree.' },
			{ term: 'Loaded', definition: 'A workbench running in memory, visible or hidden, ready to switch to at once.' },
			{ term: 'Dormant', definition: 'A workbench Omni intends to keep available but has released; activating it loads it again.' },
			{ term: 'Suspend', definition: 'Release a workbench\'s resources while keeping it dormant and eligible to be restored.' },
			{ term: 'Unload', definition: 'Release a workbench and mark it as explicitly closed. Its project or catalog entry stays.' },
		],
		preview: {
			label: 'Example Projects list',
			densityLabel: compact ? 'Showing compact lists.' : 'Showing default lists.',
			rows: previewRows(density),
			layout: density,
		},
		densityToggle: {
			id: 'density',
			label: 'Use compact worktree and workbench lists',
			description: 'Compact lists show one line per row. Finishing writes this choice to both Omni layout settings.',
			checked: compact,
			intent: { type: 'setDensity', density: compact ? 'default' : 'compact' },
		},
		shortcuts: [
			{ label: 'Switch Workbench', keybinding: 'Ctrl+Shift+Alt+P', keybindingAriaLabel: 'Control+Shift+Alt+P' },
			{ label: 'Quick Switch Loaded Workbench', keybinding: 'Ctrl+Alt+`', keybindingAriaLabel: 'Control+Alt+`' },
			{ label: 'Switch to Next Loaded Workbench', noShortcutText: 'No keyboard shortcut is assigned. Use the Command Palette.' },
			{ label: 'Switch to Previous Loaded Workbench', noShortcutText: 'No keyboard shortcut is assigned. Use the Command Palette.' },
		],
	});
}

const onboardingViewports = [{ width: 1400, height: 600 }, { width: 600, height: 400 }, { width: 500, height: 300 }];

async function lastIntent(page: Page): Promise<unknown> {
	return JSON.parse((await page.locator('body').getAttribute('data-last-intent'))!);
}

async function focusedId(page: Page): Promise<string | null> {
	return page.locator('body').evaluate(body => {
		const active = body.ownerDocument.activeElement;
		return active?.closest('[data-focus-id]')?.getAttribute('data-focus-id') ?? active?.textContent ?? null;
	});
}

/** Every element that has scrolled; the detail pane must be the only one. */
async function scrolledElements(page: Page): Promise<string[]> {
	return page.locator('body').evaluate(body => [...body.ownerDocument.querySelectorAll('*')]
		.filter(element => element.scrollTop > 0)
		.map(element => element.getAttribute('data-focus-id') ?? element.tagName.toLowerCase()));
}

async function assertFooterFixed(page: Page, viewport: { width: number; height: number }, actions: string[]): Promise<{ x: number; y: number; width: number; height: number }> {
	const bounds = await page.locator('footer').boundingBox();
	assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, `footer must stay within the viewport: ${JSON.stringify(bounds)}`);
	for (const name of actions) {
		await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
	}
	return bounds;
}

test('onboarding bring stage offers both routes to the keyboard and the pointer', { timeout: 30_000 }, async t => {
	const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
	t.after(() => browser.close());
	await mkdir(artifacts, { recursive: true });
	for (const mode of ['firstRun', 'rerun'] as const) {
		await t.test(mode, async () => {
			const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, reducedMotion: 'reduce' });
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			try {
				await mountPresentation(page, bringSnapshot(mode));
				const migrate = page.locator('[data-focus-id="route-migrate"]');
				const skipImport = page.locator('[data-focus-id="route-skipImport"]');
				await expect(page.getByRole('heading', { name: mode === 'rerun' ? 'Onboarding Is Already Complete' : 'Bring Your Setup to Hucode', exact: true })).toBeVisible();
				await expect(migrate).toContainText(mode === 'rerun' ? 'Start a New Import' : 'Import from Another Editor');
				await expect(skipImport).toContainText('Skip Import');

				// Keyboard only: from the content region the choices come first, then the footer.
				await page.locator('[data-focus-id="detail"]').focus();
				const order: (string | null)[] = [];
				for (let i = 0; i < 4; i++) {
					await page.keyboard.press('Tab');
					order.push(await focusedId(page));
				}
				assert.deepStrictEqual(order, ['route-migrate', 'route-skipImport', 'skip', 'later']);
				await page.keyboard.press('Shift+Tab');
				await page.keyboard.press('Shift+Tab');
				assert.equal(await focusedId(page), 'route-skipImport');
				await expect(skipImport).toHaveCSS('outline-style', 'solid');
				await page.keyboard.press('Enter');
				assert.deepStrictEqual(await lastIntent(page), { type: 'chooseRoute', route: 'skipImport' });

				await migrate.click();
				assert.deepStrictEqual(await lastIntent(page), { type: 'chooseRoute', route: 'migrate' });
				await expect(migrate).toHaveCSS('outline-style', 'none');
				assert.deepStrictEqual(errors, [], 'renderer errors');
			} finally {
				await page.screenshot({ path: new URL(`onboarding-bring-${mode}.png`, artifacts).pathname });
				await page.close();
			}
		});
	}
});

test('onboarding appearance stage virtualizes 400 themes behind a fixed footer', { timeout: 60_000 }, async t => {
	const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
	t.after(() => browser.close());
	await mkdir(artifacts, { recursive: true });
	for (const viewport of onboardingViewports) {
		await t.test(`${viewport.width}x${viewport.height}`, async () => {
			const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			try {
				await mountPresentation(page, appearanceSnapshot());
				const detail = page.locator('[data-focus-id="detail"]');
				const lightList = page.getByRole('radiogroup', { name: 'Light themes' });
				const darkList = page.getByRole('radiogroup', { name: 'Dark themes' });
				const footerBounds = await assertFooterFixed(page, viewport, ['Back', 'Continue']);

				// 200 rows each, of which only a viewport's worth is mounted.
				const mounted = await lightList.locator('[data-virtual-index]').count();
				assert.ok(mounted > 0 && mounted < themeCount, `light list must virtualize, mounted ${mounted}`);
				assert.equal(await lightList.getAttribute('aria-label'), 'Light themes');

				await page.getByRole('radio', { name: 'Dark', exact: true }).click();
				assert.deepStrictEqual(await lastIntent(page), { type: 'selectMode', mode: 'dark' });

				// Filtering narrows the list; the dark list is untouched.
				const filter = page.getByLabel('Filter light themes', { exact: true });
				await filter.fill('Light Theme 12');
				await expect(lightList.getByRole('radio')).toHaveCount(11);
				await filter.fill('nothing here');
				await expect(page.getByRole('status').filter({ hasText: 'Nothing matches the current filter.' })).toHaveCount(1);
				await filter.fill('');
				await expect(lightList.locator('[data-virtual-index]')).not.toHaveCount(0);

				// Arrow keys and Tab travel the lists; only the detail pane scrolls to follow.
				// Radix moves roving focus in a timeout and selects the landing radio only while the arrow
				// key is still held, so hold each press the way a hand does and wait for focus to land.
				await lightList.getByRole('radio').first().click();
				for (let i = 1; i <= 6; i++) {
					await page.keyboard.press('ArrowDown', { delay: 60 });
					await expect(page.locator(':focus')).toHaveAttribute('data-focus-id', `theme-light-light-${i}`);
				}
				await expect(page.locator(':focus')).toBeInViewport({ ratio: 1 });
				assert.deepStrictEqual(await lastIntent(page), { type: 'selectPreferredTheme', scheme: 'light', themeId: 'light-6' });
				await page.keyboard.press('Tab');
				await expect(page.getByLabel('Filter dark themes', { exact: true })).toBeFocused();
				await page.keyboard.press('Tab');
				assert.equal(await focusedId(page), 'theme-dark-dark-0');
				await expect(page.locator(':focus')).toBeInViewport({ ratio: 1 });
				assert.deepStrictEqual(await scrolledElements(page), ['detail']);
				assert.deepStrictEqual(await page.locator('footer').boundingBox(), footerBounds, 'keyboard travel must not move the footer');

				await detail.press('Control+End');
				await expect(page.getByText('Command Palette.', { exact: false })).toBeInViewport({ ratio: 1 });
				assert.deepStrictEqual(await scrolledElements(page), ['detail']);
				assert.deepStrictEqual(await page.locator('footer').boundingBox(), footerBounds);
				assert.ok(await darkList.locator('[data-virtual-index]').count() < themeCount, 'dark list must virtualize');
				await detail.press('Control+Home');
				assert.deepStrictEqual(errors, [], 'renderer errors');
			} finally {
				await page.screenshot({ path: new URL(`onboarding-appearance-${viewport.width}x${viewport.height}.png`, artifacts).pathname });
				await page.close();
			}
		});
	}
});

const focusableSelector = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

test('onboarding meet omni previews both densities outside the tab order', { timeout: 60_000 }, async t => {
	const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
	t.after(() => browser.close());
	await mkdir(artifacts, { recursive: true });
	const densityLabels: Record<string, string> = {};
	for (const density of ['default', 'compact'] as const) {
		for (const viewport of onboardingViewports) {
			await t.test(`${density} ${viewport.width}x${viewport.height}`, async () => {
				const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
				const errors: string[] = [];
				page.on('pageerror', error => errors.push(error.message));
				try {
					await mountPresentation(page, meetOmniSnapshot(density));
					const preview = page.locator('[data-preview-layout]');
					await expect(preview).toHaveAttribute('data-preview-layout', density);
					await expect(preview.locator('[data-preview-row]')).toHaveCount(4);
					assert.equal(await preview.locator(focusableSelector).count(), 0, 'preview rows must not be focusable');
					densityLabels[density] = (await page.locator('[data-density-label]').textContent())!;

					// The one switch is the first stop after the content region.
					await page.locator('[data-focus-id="detail"]').focus();
					await page.keyboard.press('Tab');
					assert.equal(await focusedId(page), 'toggle-density');
					const toggle = page.getByRole('checkbox', { name: 'Use compact worktree and workbench lists' });
					await expect(toggle).toHaveAttribute('data-state', density === 'compact' ? 'checked' : 'unchecked');
					await page.keyboard.press('Space');
					assert.deepStrictEqual(await lastIntent(page), { type: 'setDensity', density: density === 'compact' ? 'default' : 'compact' });

					await expect(page.locator('kbd')).toHaveText(['Ctrl+Shift+Alt+P', 'Ctrl+Alt+`']);
					await expect(page.getByText('No keyboard shortcut is assigned. Use the Command Palette.', { exact: true })).toHaveCount(2);
					await assertFooterFixed(page, viewport, ['Back', 'Add Project', 'Open Folder as Workbench', 'Finish for Now']);
					assert.deepStrictEqual(errors, [], 'renderer errors');
				} finally {
					await page.screenshot({ path: new URL(`onboarding-meet-omni-${density}-${viewport.width}x${viewport.height}.png`, artifacts).pathname });
					await page.close();
				}
			});
		}
	}
	assert.equal(densityLabels.default, 'Showing default lists.');
	assert.equal(densityLabels.compact, 'Showing compact lists.');
});

test('onboarding meet omni keeps control contrast across palettes under reduced motion', { timeout: 60_000 }, async t => {
	const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
	t.after(() => browser.close());
	await mkdir(artifacts, { recursive: true });
	for (const density of ['default', 'compact'] as const) {
		await t.test(density, async () => {
			const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, reducedMotion: 'reduce' });
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			try {
				await mountPresentation(page, meetOmniSnapshot(density));
				assert.equal(await page.locator('body').evaluate(body => body.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)').matches), true);
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
					// One checkbox in the density's state and the four footer actions.
					await assertControlContrast(page, 5);
					await page.screenshot({ path: new URL(`onboarding-meet-omni-theme-${name}-${density}.png`, artifacts).pathname });
				}
				assert.deepStrictEqual(errors, [], 'renderer errors');
			} finally {
				await page.close();
			}
		});
	}
});

// #endregion
