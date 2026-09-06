/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { SetupShell } from '@/components/SetupShell';
import { presentation, testHost } from '@/test/fixtures';
import type { EditorMigrationSetupDensity, EditorMigrationSetupIntent, EditorMigrationSetupPanel, EditorMigrationSetupPresentation } from '@/generated/editorMigrationSetupProtocol';

afterEach(cleanup);

/** The Meet Omni snapshot for one density, shaped the way core's presentation mapper emits it. */
function meetOmniPresentation(layout: EditorMigrationSetupDensity, revision = 1): EditorMigrationSetupPresentation {
	const compact = layout === 'compact';
	const panel: EditorMigrationSetupPanel = {
		kind: 'meetOmni',
		id: '',
		heading: 'Meet Omni',
		lead: 'Omni is the outer shell.',
		glossary: [
			{ term: 'Project', definition: 'A saved Git repository.' },
			{ term: 'Worktree', definition: 'One checkout belonging to a project.' },
		],
		preview: {
			label: 'Example Projects list',
			densityLabel: compact ? 'Showing compact lists.' : 'Showing default lists.',
			layout,
			rows: compact
				? [
					{ id: 'p', kind: 'project', name: 'hucode', branch: '~/Projects' },
					{ id: 'w1', kind: 'worktree', name: 'local', branch: 'main' },
					{ id: 'b', kind: 'workbench', name: 'notes', path: '~/Documents/notes' },
				]
				: [
					{ id: 'p', kind: 'project', name: 'hucode', branch: '~/Projects' },
					{ id: 'w1', kind: 'worktree', name: 'local', branch: 'main', path: '~/Projects/hucode' },
					{ id: 'b', kind: 'workbench', name: 'notes', branch: 'main', path: '~/Documents/notes' },
				],
		},
		densityToggle: {
			id: 'density',
			label: 'Use compact worktree and workbench lists',
			description: 'Compact lists show one line per row.',
			checked: compact,
			intent: { type: 'setDensity', density: compact ? 'default' : 'compact' },
		},
		shortcuts: [
			{ label: 'Switch Workbench', keybinding: '⌘O', keybindingAriaLabel: 'Command+O' },
			{ label: 'Quick Switch Loaded Workbench', noShortcutText: 'No keyboard shortcut is assigned. Use the Command Palette.' },
		],
	};
	return presentation({
		revision,
		route: 'onboarding',
		phase: 'meetOmni',
		regionLabel: 'Hucode Onboarding',
		title: 'Welcome to Hucode',
		announcement: compact ? 'Showing compact lists.' : undefined,
		steps: [
			{ id: 'bring', label: 'Bring Your Setup', current: false },
			{ id: 'review', label: 'Review', current: false },
			{ id: 'meetOmni', label: 'Meet Omni', current: true },
		],
		scopeKey: 'onboarding|meetOmni|first',
		panels: [panel],
		footer: {
			lines: [],
			actions: [
				{ id: 'add-project', label: 'Add Project', kind: 'default', disabled: false, intent: { type: 'addProject' } },
				{ id: 'open-workbench', label: 'Open Folder as Workbench', kind: 'default', disabled: false, intent: { type: 'openFolderAsWorkbench' } },
				{ id: 'finish', label: 'Finish for Now', kind: 'primary', disabled: false, intent: { type: 'finishForNow' } },
			],
		},
	});
}

function intents(sent: readonly unknown[]): EditorMigrationSetupIntent[] {
	return sent.map(message => (message as { intent: EditorMigrationSetupIntent }).intent);
}

/** The text lines of each preview row, so a test can tell a two-line row from a one-line one. */
function rowLines(container: HTMLElement): string[][] {
	return Array.from(container.querySelectorAll('[data-preview-row]')).map(row =>
		Array.from(row.querySelectorAll(':scope > div > *')).map(line => line.textContent ?? ''));
}

describe('MeetOmniPanel', () => {
	test('draws the glossary, the shortcuts, and the finishes, and posts the toggle intent verbatim', async () => {
		const { host, sent, publish } = testHost();
		render(<SetupShell host={host} />);
		await act(async () => publish(meetOmniPresentation('default')));
		const user = userEvent.setup();

		expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Meet Omni');
		expect(screen.getAllByRole('term').map(node => node.textContent)).toEqual(['Project', 'Worktree']);
		expect(screen.getAllByRole('definition').map(node => node.textContent)).toEqual(['A saved Git repository.', 'One checkout belonging to a project.']);
		// A bound chord is a <kbd> with the host's spoken form; an unbound one shows the host's fallback.
		const chord = screen.getByText('⌘O');
		expect(chord.tagName).toBe('KBD');
		expect(chord).toHaveAttribute('aria-label', 'Command+O');
		expect(screen.getByText('No keyboard shortcut is assigned. Use the Command Palette.')).toBeInTheDocument();
		expect(document.querySelectorAll('kbd')).toHaveLength(1);

		const toggle = screen.getByRole('checkbox', { name: 'Use compact worktree and workbench lists' });
		expect(toggle).not.toBeChecked();
		expect(toggle).toHaveAttribute('data-focus-id', 'toggle-density');
		await user.click(toggle);
		await user.click(screen.getByRole('button', { name: 'Add Project' }));
		await user.click(screen.getByRole('button', { name: 'Open Folder as Workbench' }));
		await user.click(screen.getByRole('button', { name: 'Finish for Now' }));
		expect(intents(sent)).toEqual([
			{ type: 'setDensity', density: 'compact' },
			{ type: 'addProject' },
			{ type: 'openFolderAsWorkbench' },
			{ type: 'finishForNow' },
		]);
	});

	test('keeps the preview out of the tab order and names the density in text and in the live region', async () => {
		const { host, publish } = testHost();
		const { container } = render(<SetupShell host={host} />);
		await act(async () => publish(meetOmniPresentation('default')));

		const list = container.querySelector('[data-preview-layout]')!;
		expect(list).toHaveAttribute('role', 'presentation');
		expect(list).toHaveAttribute('aria-hidden', 'true');
		expect(list.querySelectorAll('[tabindex], button, a, input')).toHaveLength(0);
		expect(within(list as HTMLElement).queryAllByRole('listitem')).toHaveLength(0);
		expect(container.querySelector('[data-density-label]')).toHaveTextContent('Showing default lists.');
		expect(container.querySelector('[data-live-region="migration"]')).toHaveTextContent('');

		await act(async () => publish(meetOmniPresentation('compact', 2)));
		expect(screen.getByRole('checkbox', { name: 'Use compact worktree and workbench lists' })).toBeChecked();
		expect(container.querySelector('[data-density-label]')).toHaveTextContent('Showing compact lists.');
		expect(container.querySelector('[data-live-region="migration"]')).toHaveTextContent('Showing compact lists.');
	});

	test('lays worktree and workbench rows out on two lines by default and one line when compact', async () => {
		const { host, publish } = testHost();
		const { container } = render(<SetupShell host={host} />);
		await act(async () => publish(meetOmniPresentation('default')));
		const twoLine = rowLines(container);

		await act(async () => publish(meetOmniPresentation('compact', 2)));
		const oneLine = rowLines(container);

		expect({ twoLine, oneLine }).toEqual({
			// Project rows stay on one line; a worktree keeps its path beside the name and its
			// branch below, and a workbench keeps its branch beside the name and its path below.
			twoLine: [
				['hucode', '~/Projects'],
				['local~/Projects/hucode', 'main'],
				['notesmain', '~/Documents/notes'],
			],
			// Compact rows carry only what the host left in, on one line: name, then the one secondary field.
			oneLine: [
				['hucode', '~/Projects'],
				['local', 'main'],
				['notes', '~/Documents/notes'],
			],
		});
		expect(container.querySelector('[data-preview-layout]')).toHaveAttribute('data-preview-layout', 'compact');
	});
});
