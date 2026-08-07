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
	selectionLabel?: string
): Promise<void> {
	await focusCommandSurface(surface, timeoutMs);
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
