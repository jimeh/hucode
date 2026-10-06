/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { SetupShell } from '@/components/SetupShell';
import { presentation, testHost } from '@/test/fixtures';
import type { EditorMigrationSetupIntent, EditorMigrationSetupPresentation, EditorMigrationSetupThemeGroup } from '@/generated/editorMigrationSetupProtocol';

afterEach(cleanup);

/** Enough themes that the list shows its filter; below the virtualization threshold, which jsdom cannot lay out. */
function themeGroup(scheme: 'light' | 'dark', selectedId: string, count: number): EditorMigrationSetupThemeGroup {
	const label = scheme === 'light' ? 'Light' : 'Dark';
	return {
		label: `Preferred ${scheme} theme`,
		filterLabel: `Filter ${scheme} themes`,
		listLabel: `${label} themes`,
		noMatchText: 'Nothing matches the current filter.',
		selectedId,
		themes: Array.from({ length: count }, (_, index) => ({ id: `${label} ${index}`, label: `${label} Theme ${index}` })),
	};
}

/** The appearance snapshot, shaped the way core's presentation mapper emits it. */
function appearancePresentation(): EditorMigrationSetupPresentation {
	return presentation({
		route: 'onboarding',
		phase: 'appearance',
		regionLabel: 'Hucode Onboarding',
		title: 'Welcome to Hucode',
		steps: [
			{ id: 'bring', label: 'Bring Your Setup', current: true },
			{ id: 'review', label: 'Review', current: false },
			{ id: 'meetOmni', label: 'Meet Omni', current: false },
		],
		scopeKey: 'onboarding|appearance|first',
		panels: [{
			kind: 'appearance',
			id: '',
			heading: 'Choose How Hucode Looks',
			lead: 'These values are written to the Default profile.',
			paragraphs: ['Nothing you have already configured is removed.'],
			modeGroupLabel: 'Appearance mode',
			modes: [
				{ id: 'system', label: 'System', description: 'Follow the operating system.', checked: false, intent: { type: 'selectMode', mode: 'system' } },
				{ id: 'light', label: 'Light', checked: false, intent: { type: 'selectMode', mode: 'light' } },
				{ id: 'dark', label: 'Dark', checked: true, intent: { type: 'selectMode', mode: 'dark' } },
			],
			light: themeGroup('light', 'Light 2', 12),
			dark: themeGroup('dark', 'Dark 0', 3),
		}],
		footer: {
			lines: [],
			actions: [
				{ id: 'back', label: 'Back', kind: 'default', disabled: false, intent: { type: 'back' } },
				{ id: 'appearance-continue', label: 'Continue', kind: 'primary', disabled: false, intent: { type: 'continueStage' } },
			],
		},
	});
}

function intents(sent: readonly unknown[]): EditorMigrationSetupIntent[] {
	return sent.map(message => (message as { intent: EditorMigrationSetupIntent }).intent);
}

describe('AppearancePanel', () => {
	test('renders the host copy, marks the staged choices, and posts a mode change verbatim', async () => {
		const { host, sent, publish } = testHost();
		render(<SetupShell host={host} />);
		await act(async () => publish(appearancePresentation()));
		const user = userEvent.setup();

		expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Choose How Hucode Looks');
		expect(screen.getByText('These values are written to the Default profile.')).toBeInTheDocument();
		expect(screen.getByText('Nothing you have already configured is removed.')).toHaveClass('text-xs');
		const modes = screen.getByRole('radiogroup', { name: 'Appearance mode' });
		// Each tile is one radio named by its label alone, with the description as its accessible description.
		expect(within(modes).getAllByRole('radio').map(tile => tile.getAttribute('aria-label') ?? tile.getAttribute('aria-labelledby'))).toEqual(['mode-system-label', 'mode-light-label', 'mode-dark-label']);
		expect(within(modes).getByRole('radio', { name: 'Dark' })).toBeChecked();
		expect(within(modes).getByRole('radio', { name: 'System' })).toHaveAttribute('data-focus-id', 'mode-system');
		expect(within(modes).getByRole('radio', { name: 'System' })).toHaveAccessibleDescription('Follow the operating system.');
		const light = screen.getByRole('radiogroup', { name: 'Light themes' });
		expect(within(light).getByRole('radio', { name: 'Light Theme 2' })).toBeChecked();
		expect(within(light).getAllByRole('radio')).toHaveLength(12);
		const dark = screen.getByRole('radiogroup', { name: 'Dark themes' });
		expect(within(dark).getByRole('radio', { name: 'Dark Theme 0' })).toBeChecked();
		// Short lists have no filter to type into; the light list is long enough to offer one.
		expect(screen.queryByLabelText('Filter dark themes')).toBeNull();
		expect(screen.getByLabelText('Filter light themes')).toBeInTheDocument();

		await user.click(within(modes).getByRole('radio', { name: 'System' }));
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(intents(sent)).toEqual([{ type: 'selectMode', mode: 'system' }, { type: 'continueStage' }]);
	});

	test('posts the identifier of a chosen theme for its own scheme', async () => {
		const { host, sent, publish } = testHost();
		render(<SetupShell host={host} />);
		await act(async () => publish(appearancePresentation()));
		const user = userEvent.setup();

		const dark = screen.getByRole('radiogroup', { name: 'Dark themes' });
		expect(within(dark).getByRole('radio', { name: 'Dark Theme 2' })).toHaveAttribute('data-focus-id', 'theme-dark-Dark 2');
		await user.click(within(dark).getByRole('radio', { name: 'Dark Theme 2' }));
		await user.click(within(screen.getByRole('radiogroup', { name: 'Light themes' })).getByRole('radio', { name: 'Light Theme 7' }));
		expect(intents(sent)).toEqual([
			{ type: 'selectPreferredTheme', scheme: 'dark', themeId: 'Dark 2' },
			{ type: 'selectPreferredTheme', scheme: 'light', themeId: 'Light 7' },
		]);
	});

	test('narrows a theme list by its filter and reports an empty result', async () => {
		const { host, publish } = testHost();
		render(<SetupShell host={host} />);
		await act(async () => publish(appearancePresentation()));
		const user = userEvent.setup();

		await user.type(screen.getByLabelText('Filter light themes'), 'Theme 1');
		const light = screen.getByRole('radiogroup', { name: 'Light themes' });
		expect(within(light).getAllByRole('radio').map(radio => radio.getAttribute('data-focus-id'))).toEqual([
			'theme-light-Light 1', 'theme-light-Light 10', 'theme-light-Light 11',
		]);
		// The other list keeps its own filter state.
		expect(within(screen.getByRole('radiogroup', { name: 'Dark themes' })).getAllByRole('radio')).toHaveLength(3);

		await user.type(screen.getByLabelText('Filter light themes'), 'zzz');
		expect(screen.queryByRole('radiogroup', { name: 'Light themes' })).toBeNull();
		expect(screen.getByText('Nothing matches the current filter.')).toHaveAttribute('role', 'status');
	});
});
