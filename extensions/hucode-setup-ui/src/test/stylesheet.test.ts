/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const entry = readFileSync(path.join(import.meta.dirname, '..', 'styles', 'setup.css'), 'utf8');
const compiled = readFileSync(path.join(import.meta.dirname, '..', '..', 'media', 'style.css'), 'utf8');

describe('setup stylesheet', () => {
	test('defines all four mode palettes from the body class the webview already sets', () => {
		for (const selector of ['body.vscode-light', 'body.vscode-high-contrast', 'body.vscode-high-contrast-light']) {
			expect(entry).toContain(`${selector} {`);
		}
		expect(entry).toMatch(/:root \{[\s\S]*--hucode-background:/);
	});

	test('binds Tailwind dark utilities to the webview mode instead of the operating system', () => {
		expect(entry).toContain('@custom-variant dark');
		expect(entry).toMatch(/@custom-variant dark \([^\n]*body\.vscode-dark/);
		expect(entry).toMatch(/@custom-variant dark \([^\n]*body\.vscode-high-contrast:not\(\.vscode-high-contrast-light\)/);
		expect(compiled).toContain('body.vscode-dark');
		expect(compiled).toContain('body.vscode-high-contrast:not(.vscode-high-contrast-light)');
		expect(compiled).not.toContain('prefers-color-scheme:dark');
	});

	test('bridges generated selection controls to the Radix checked-state attribute', () => {
		expect(entry).toMatch(/\[data-slot="checkbox"\]\[data-state="checked"\] \{/);
		expect(entry).toMatch(/\[data-slot="radio-group-item"\]\[data-state="checked"\] \{/);
		expect(compiled).toContain('[data-slot=checkbox][data-state=checked]');
		expect(compiled).toContain('[data-slot=radio-group-item][data-state=checked]');
	});

	test('maps workbench colors through semantic tokens with standalone palette fallbacks', () => {
		expect(entry).toContain('--color-background: var(--vscode-editor-background, var(--hucode-background))');
		expect(entry).toContain('--color-primary: var(--vscode-button-background, var(--hucode-accent))');
		expect(entry).toContain('--color-primary-foreground: var(--vscode-button-foreground, var(--hucode-accent-foreground))');
	});

	test('overrides the pre-page body padding, font fallback, and default focus outline', () => {
		expect(entry).toMatch(/body \{[\s\S]*font-family: var\(--hucode-font-sans\)/);
		expect(entry).toMatch(/html,\s*\nbody \{[\s\S]*padding: 0;/);
		expect(entry).toMatch(/a:focus,\s*\ninput:focus,\s*\nselect:focus,\s*\ntextarea:focus \{\s*\n\toutline: none;/);
	});

	test('reintroduces focus only for keyboard interaction', () => {
		expect(entry).toMatch(/:focus-visible \{\s*\n\toutline: 2px solid var\(--vscode-focusBorder, var\(--hucode-ring\)\)/);
		expect(entry).toMatch(/\[data-panel-heading\]:focus,\s*\n\[data-panel-heading\]:focus-visible \{\s*\n\toutline: none;/);
		// Every plain `:focus` rule must clear the platform outline; only `:focus-visible` draws one.
		const focusRules = [...entry.matchAll(/((?:^[^@\n{]*:focus,\s*\n)*^[^@\n{]*:focus) \{([^}]*)\}/gm)];
		expect(focusRules.length).toBeGreaterThan(0);
		for (const [, selector, body] of focusRules) {
			expect(body, selector).toMatch(/outline: none;/);
			expect(body, selector).not.toMatch(/outline: (?!none)/);
		}
	});

	test('honors forced colors and reduced motion', () => {
		expect(entry).toContain('@media (forced-colors: active)');
		expect(entry).toContain('@media (prefers-reduced-motion: reduce)');
	});
});
