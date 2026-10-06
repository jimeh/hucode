/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { SetupShell } from '@/components/SetupShell';
import { presentation, testHost } from '@/test/fixtures';
import type { EditorMigrationSetupIntent, EditorMigrationSetupPanel, EditorMigrationSetupPresentation } from '@/generated/editorMigrationSetupProtocol';

afterEach(cleanup);

/** The Meet Omni snapshot, shaped the way core's presentation mapper emits it. */
function meetOmniPresentation(): EditorMigrationSetupPresentation {
	const panel: EditorMigrationSetupPanel = {
		kind: 'meetOmni',
		id: '',
		heading: 'Meet Omni',
		lead: 'Omni is the outer shell.',
		glossary: [
			{ term: 'Project', definition: 'A saved Git repository.' },
			{ term: 'Worktree', definition: 'One checkout belonging to a project.' },
			{ term: 'Workbench', definition: 'A VS Code window hosted inside Omni.' },
		],
		shortcuts: [
			{ label: 'Switch Workbench', keybinding: '⌘O', keybindingAriaLabel: 'Command+O' },
			{ label: 'Quick Switch Loaded Workbench', noShortcutText: 'No keyboard shortcut is assigned. Use the Command Palette.' },
		],
	};
	return presentation({
		route: 'onboarding',
		phase: 'meetOmni',
		regionLabel: 'Hucode Onboarding',
		title: 'Welcome to Hucode',
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
				{ id: 'finish', label: 'Finish', kind: 'primary', disabled: false, intent: { type: 'finishForNow' } },
			],
		},
	});
}

function intents(sent: readonly unknown[]): EditorMigrationSetupIntent[] {
	return sent.map(message => (message as { intent: EditorMigrationSetupIntent }).intent);
}

describe('MeetOmniPanel', () => {
	test('draws the glossary and the shortcuts, and posts each finish verbatim', async () => {
		const { host, sent, publish } = testHost();
		const { container } = render(<SetupShell host={host} />);
		await act(async () => publish(meetOmniPresentation()));
		const user = userEvent.setup();

		expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Meet Omni');
		expect(screen.getAllByRole('term').map(node => node.textContent)).toEqual(['Project', 'Worktree', 'Workbench']);
		expect(screen.getAllByRole('definition').map(node => node.textContent)).toEqual(['A saved Git repository.', 'One checkout belonging to a project.', 'A VS Code window hosted inside Omni.']);
		// A bound chord is a <kbd> with the host's spoken form; an unbound one shows the host's fallback.
		const chord = screen.getByText('⌘O');
		expect(chord.tagName).toBe('KBD');
		expect(chord).toHaveAttribute('aria-label', 'Command+O');
		expect(screen.getByText('No keyboard shortcut is assigned. Use the Command Palette.')).toBeInTheDocument();
		expect(document.querySelectorAll('kbd')).toHaveLength(1);
		// The content carries no controls of its own: the finishes live in the footer.
		expect(container.querySelectorAll('[data-focus-id="detail"] button, [data-focus-id="detail"] input')).toHaveLength(0);

		await user.click(screen.getByRole('button', { name: 'Add Project' }));
		await user.click(screen.getByRole('button', { name: 'Open Folder as Workbench' }));
		await user.click(screen.getByRole('button', { name: 'Finish' }));
		expect(intents(sent)).toEqual([
			{ type: 'addProject' },
			{ type: 'openFolderAsWorkbench' },
			{ type: 'finishForNow' },
		]);
	});
});
