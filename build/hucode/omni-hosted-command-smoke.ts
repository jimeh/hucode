/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Frame, Locator, Page } from '@playwright/test';

/** Commands exercised from both desktop and serve-web hosted workbenches. */
export const hostedWorkbenchSmokeCommands = Object.freeze({
	switchWorkbench: 'Switch Workbench...',
	previousLoaded: 'Switch to Previous Loaded Workbench',
	nextLoaded: 'Switch to Next Loaded Workbench',
	lastActive: 'Switch to Last Active Workbench',
	quickSwitchLoaded: 'Quick Switch Loaded Workbench',
	unloadCurrent: 'Omni-Window: Unload Current Worktree',
	toggleProjectsSidebar: 'Omni-Window: Toggle Projects Sidebar',
	webHostedFocusProjects: 'Omni-Window: Focus Projects',
	webHostedFocusWorkbench: 'Omni-Window: Focus Workbench',
	reloadDesktop: 'Reload Hosted Workbench',
	reloadWeb: 'Omni-Window: Reload Workbench',
});

/** Renderer surface that can own workbench Quick Input. */
export type HostedWorkbenchCommandSurface = Page | Frame;

/** Transport-neutral Projects row shape used by both runtime smokes. */
export interface IOmniWorkbenchSmokeRow {
	readonly label: string;
	readonly state: string;
	readonly active: boolean;
	readonly ariaLabel?: string;
}

/** Reads the observable lifecycle state of selected Projects rows. */
export async function readOmniWorkbenchSmokeRows(
	shellPage: Page,
	labels: readonly string[]
): Promise<readonly IOmniWorkbenchSmokeRow[]> {
	return shellPage.locator(
		'.monaco-list-row:has(.hucode-project-switcher-workbench)'
	).evaluateAll((elements, expectedLabels) => {
		const rows: IOmniWorkbenchSmokeRow[] = [];
		for (const element of elements) {
			const item = element.querySelector(
				'.hucode-project-switcher-workbench'
			);
			const label = item?.querySelector(
				'.hucode-project-switcher-label'
			)?.textContent?.trim();
			if (!item || !label || !expectedLabels.includes(label)) {
				continue;
			}
			const stateClass = [...item.classList].find(className =>
				className.startsWith('hucode-project-switcher-workbench-')
			);
			const state = stateClass?.slice(
				'hucode-project-switcher-workbench-'.length
			);
			if (!state) {
				continue;
			}
			rows.push({
				label,
				state,
				active: element.getAttribute('aria-current') === 'true',
				ariaLabel: element.getAttribute('aria-label') ?? undefined,
			});
		}
		return rows;
	}, [...labels]);
}

/**
 * Runs an F1-visible command in a hosted workbench and optionally chooses the
 * next Quick Pick item. The keyboard page is the target page on desktop and
 * the containing shell page for a serve-web frame.
 */
export async function runHostedWorkbenchSmokeCommand(
	keyboardPage: Page,
	surface: HostedWorkbenchCommandSurface,
	commandTitle: string,
	timeoutMs: number,
	selectionLabel?: string,
	focusSurface = true
): Promise<void> {
	if (focusSurface) {
		await focusCommandSurface(surface, timeoutMs);
	}
	await keyboardPage.keyboard.press('Control+Shift+P');
	const widget = surface.locator('.quick-input-widget').last();
	await widget.waitFor({ state: 'visible', timeout: timeoutMs });
	const input = widget.locator('input').first();
	await input.fill(`>${commandTitle}`, { timeout: timeoutMs });
	const command = getQuickInputRow(widget, commandTitle);
	await command.waitFor({ state: 'visible', timeout: timeoutMs });
	await command.click({ timeout: timeoutMs });

	if (selectionLabel) {
		const selectionWidget = surface.locator('.quick-input-widget').last();
		await selectionWidget.waitFor({ state: 'visible', timeout: timeoutMs });
		const selection = getQuickInputRow(selectionWidget, selectionLabel);
		await selection.waitFor({ state: 'visible', timeout: timeoutMs });
		await selection.click({ timeout: timeoutMs });
	} else {
		await widget.waitFor({ state: 'hidden', timeout: timeoutMs });
	}
}

/** Opens a fixture file through workbench Quick Open and returns its editor. */
export async function openHostedWorkbenchSmokeFile(
	keyboardPage: Page,
	surface: HostedWorkbenchCommandSurface,
	fileName: string,
	timeoutMs: number
): Promise<Locator> {
	await focusCommandSurface(surface, timeoutMs);
	await keyboardPage.keyboard.press('Control+P');
	const widget = surface.locator('.quick-input-widget').last();
	await widget.waitFor({ state: 'visible', timeout: timeoutMs });
	await widget.locator('input').first().fill(fileName, { timeout: timeoutMs });
	const file = getQuickInputRow(widget, fileName);
	await file.waitFor({ state: 'visible', timeout: timeoutMs });
	await file.click({ timeout: timeoutMs });
	await widget.waitFor({ state: 'hidden', timeout: timeoutMs });

	const editor = surface.locator(
		`.editor-instance .monaco-editor[data-uri$="${
			escapeCssAttributeValue(fileName)
		}"]`
	).last();
	await editor.waitFor({ state: 'visible', timeout: timeoutMs });
	return editor;
}

/** Replaces the complete observable contents of a one-line fixture editor. */
export async function replaceHostedWorkbenchSmokeEditorContents(
	keyboardPage: Page,
	editor: Locator,
	contents: string,
	timeoutMs: number
): Promise<void> {
	await focusHostedWorkbenchSmokeEditor(editor, timeoutMs);
	await keyboardPage.keyboard.press('Control+A');
	if (contents) {
		await keyboardPage.keyboard.insertText(contents);
	} else {
		await keyboardPage.keyboard.press('Backspace');
	}
	await waitForHostedWorkbenchSmokeEditorContents(
		editor,
		contents,
		timeoutMs
	);
}

/** Selects the complete fixture editor contents without changing them. */
export async function selectAllHostedWorkbenchSmokeEditorContents(
	keyboardPage: Page,
	editor: Locator,
	timeoutMs: number
): Promise<void> {
	await focusHostedWorkbenchSmokeEditor(editor, timeoutMs);
	await keyboardPage.keyboard.press('Control+A');
}

/** Waits until the one-line fixture editor renders the exact expected text. */
export async function waitForHostedWorkbenchSmokeEditorContents(
	editor: Locator,
	expected: string,
	timeoutMs: number
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastObserved = '<not observed>';
	while (Date.now() < deadline) {
		try {
			lastObserved = (await editor.locator('.view-lines').textContent()) ?? '';
			if (lastObserved === expected) {
				return;
			}
		} catch (error) {
			lastObserved = error instanceof Error ? error.message : String(error);
		}
		await delay(50);
	}
	throw new Error(
		`Timed out waiting for hosted editor contents ${JSON.stringify(expected)}; ` +
		`last observed ${JSON.stringify(lastObserved)}`
	);
}

/** Focuses the real Projects surface before shell command or clipboard input. */
export async function focusOmniProjectsSmokeSurface(
	shellPage: Page,
	timeoutMs: number
): Promise<void> {
	await shellPage.locator(
		'.hucode-omni-projects-view .monaco-list'
	).focus({ timeout: timeoutMs });
	await waitForOmniProjectsSmokeSurfaceFocus(shellPage, timeoutMs);
}

/** Waits until keyboard focus is observably inside the Omni Projects surface. */
export async function waitForOmniProjectsSmokeSurfaceFocus(
	shellPage: Page,
	timeoutMs: number
): Promise<void> {
	const projects = shellPage.locator('.hucode-omni-projects-view');
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await projects.evaluate(element =>
			element.contains(element.ownerDocument.activeElement))) {
			return;
		}
		await delay(50);
	}
	throw new Error('Timed out waiting for focus in the Omni Projects surface');
}

/** Waits until a hosted page or frame owns document keyboard focus. */
export async function waitForHostedWorkbenchSmokeSurfaceFocus(
	surface: HostedWorkbenchCommandSurface,
	timeoutMs: number
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await surface.evaluate(() => (
			globalThis as unknown as {
				readonly document: { hasFocus(): boolean };
			}
		).document.hasFocus())) {
			return;
		}
		await delay(50);
	}
	throw new Error('Timed out waiting for hosted workbench focus');
}

/** Waits for the real Omni Projects sidebar to become visible or hidden. */
export async function waitForOmniProjectsSidebarVisibility(
	shellPage: Page,
	visible: boolean,
	timeoutMs: number
): Promise<void> {
	await shellPage.locator('[id="workbench.parts.sidebar"]').waitFor({
		state: visible ? 'visible' : 'hidden',
		timeout: timeoutMs,
	});
}

/**
 * Exercises copy/cut forwarding and paste delivery with both the hosted editor
 * and the shell Projects surface focused, asserting the real editor contents.
 */
export async function runHostedWorkbenchClipboardBridgeSmoke(options: {
	readonly keyboardPage: Page;
	readonly shellPage: Page;
	readonly surface: HostedWorkbenchCommandSurface;
	readonly fileName: string;
	readonly timeoutMs: number;
	readonly readClipboardText: () => Promise<string>;
	readonly writeClipboardText: (text: string) => Promise<void>;
}): Promise<Locator> {
	const editor = await openHostedWorkbenchSmokeFile(
		options.keyboardPage,
		options.surface,
		options.fileName,
		options.timeoutMs
	);
	const focusedPasteMarker = 'hucode-focused-paste-marker';
	const shellPasteMarker = 'hucode-shell-paste-marker';

	await replaceHostedWorkbenchSmokeEditorContents(
		options.keyboardPage,
		editor,
		focusedPasteMarker,
		options.timeoutMs
	);
	await selectAllHostedWorkbenchSmokeEditorContents(
		options.keyboardPage,
		editor,
		options.timeoutMs
	);
	await focusOmniProjectsSmokeSurface(
		options.shellPage,
		options.timeoutMs
	);
	await options.shellPage.keyboard.press('Control+C');
	await waitForClipboardText(
		options.readClipboardText,
		focusedPasteMarker,
		options.timeoutMs
	);
	await options.writeClipboardText(focusedPasteMarker);
	await replaceHostedWorkbenchSmokeEditorContents(
		options.keyboardPage,
		editor,
		'',
		options.timeoutMs
	);
	await options.keyboardPage.keyboard.press('Control+V');
	await waitForHostedWorkbenchSmokeEditorContents(
		editor,
		focusedPasteMarker,
		options.timeoutMs
	);

	await replaceHostedWorkbenchSmokeEditorContents(
		options.keyboardPage,
		editor,
		shellPasteMarker,
		options.timeoutMs
	);
	await selectAllHostedWorkbenchSmokeEditorContents(
		options.keyboardPage,
		editor,
		options.timeoutMs
	);
	await focusOmniProjectsSmokeSurface(
		options.shellPage,
		options.timeoutMs
	);
	await options.shellPage.keyboard.press('Control+X');
	await waitForHostedWorkbenchSmokeEditorContents(
		editor,
		'',
		options.timeoutMs
	);
	await waitForClipboardText(
		options.readClipboardText,
		shellPasteMarker,
		options.timeoutMs
	);
	await options.writeClipboardText(shellPasteMarker);
	await focusOmniProjectsSmokeSurface(
		options.shellPage,
		options.timeoutMs
	);
	await options.shellPage.keyboard.press('Control+V');
	await waitForHostedWorkbenchSmokeEditorContents(
		editor,
		shellPasteMarker,
		options.timeoutMs
	);
	await focusHostedWorkbenchSmokeEditor(editor, options.timeoutMs);
	await options.keyboardPage.keyboard.press('Control+S');
	return editor;
}

async function waitForClipboardText(
	readClipboardText: () => Promise<string>,
	expected: string,
	timeoutMs: number
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastObserved = '<not observed>';
	while (Date.now() < deadline) {
		try {
			lastObserved = await readClipboardText();
			if (lastObserved === expected) {
				return;
			}
		} catch (error) {
			lastObserved = error instanceof Error ? error.message : String(error);
		}
		await delay(50);
	}
	throw new Error(
		`Timed out waiting for clipboard text ${JSON.stringify(expected)}; ` +
		`last observed ${JSON.stringify(lastObserved)}`
	);
}

/** Proves a command is present in the hosted workbench command palette. */
export async function assertHostedWorkbenchSmokeCommandVisible(
	keyboardPage: Page,
	surface: HostedWorkbenchCommandSurface,
	commandTitle: string,
	timeoutMs: number
): Promise<void> {
	await focusCommandSurface(surface, timeoutMs);
	await keyboardPage.keyboard.press('Control+Shift+P');
	const widget = surface.locator('.quick-input-widget').last();
	await widget.waitFor({ state: 'visible', timeout: timeoutMs });
	await widget.locator('input').first().fill(`>${commandTitle}`, {
		timeout: timeoutMs,
	});
	await getQuickInputRow(widget, commandTitle).waitFor({
		state: 'visible',
		timeout: timeoutMs,
	});
	await keyboardPage.keyboard.press('Escape');
	await widget.waitFor({ state: 'hidden', timeout: timeoutMs });
}

function getQuickInputRow(widget: Locator, label: string): Locator {
	return widget.locator('.quick-input-list .monaco-list-row').filter({
		hasText: new RegExp(escapeRegExp(label)),
	}).first();
}

async function focusCommandSurface(
	surface: HostedWorkbenchCommandSurface,
	timeoutMs: number
): Promise<void> {
	await surface.locator('.monaco-workbench').click({
		position: { x: 320, y: 180 },
		timeout: timeoutMs,
	});
}

async function focusHostedWorkbenchSmokeEditor(
	editor: Locator,
	timeoutMs: number
): Promise<void> {
	await editor.locator('.view-lines').click({ timeout: timeoutMs });
}

function escapeCssAttributeValue(value: string): string {
	return value.replace(/["\\]/g, character => `\\${character}`);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
