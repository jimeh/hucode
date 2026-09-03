/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { SetupShell } from '@/components/SetupShell';
import { presentation, profilesPanel, reviewCategoryPanel, conflictRow, testHost } from '@/test/fixtures';
import type { EditorMigrationSetupIntent } from '@/generated/editorMigrationSetupProtocol';

afterEach(cleanup);

function intents(sent: readonly unknown[]): EditorMigrationSetupIntent[] {
	return sent.map(message => (message as { intent: EditorMigrationSetupIntent }).intent);
}

async function mount(initial = presentation()) {
	const { host, sent, publish } = testHost();
	render(<SetupShell host={host} />);
	await act(async () => publish(initial));
	return { sent, publish, user: userEvent.setup() };
}

describe('SetupShell', () => {
	test('shows a loading placeholder until the host answers with a snapshot', () => {
		const { host } = testHost();
		render(<SetupShell host={host} />);
		expect(screen.queryByRole('region')).toBeNull();
	});

	test('asks for the application before the profile and sends the offered intent verbatim', async () => {
		const { sent, user } = await mount();

		expect(screen.getByRole('region', { name: 'Editor Setup Import' })).toBeInTheDocument();
		expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Which Application Should Hucode Import From?');
		expect(screen.queryByRole('radiogroup')).toBeNull();

		await user.click(screen.getByRole('button', { name: /Cursor/ }));
		expect(intents(sent)).toContainEqual({ type: 'selectApplication', applicationId: 'cursor' });
	});

	test('preselects the Default source profile the host marked as checked', async () => {
		await mount(presentation({ phase: 'profile', panels: [profilesPanel()] }));

		const group = screen.getByRole('radiogroup', { name: 'Source profile' });
		expect(within(group).getByRole('radio', { name: 'Default' })).toBeChecked();
		expect(within(group).getByRole('radio', { name: 'Work' })).not.toBeChecked();
	});

	test('carries category selection and both conflict choice paths back as intents', async () => {
		const review = presentation({
			phase: 'review',
			scopeKey: 'review|draft|',
			sections: [
				{ id: 'settings', label: 'Settings', status: 'attention', count: 3, statusDescription: 'Needs attention. 3 items.' },
				{ id: 'notImported', label: 'Not Imported', status: 'neutral', count: 1, statusDescription: '1 items.' },
			],
			defaultSectionId: 'settings',
			railLabel: 'Import sections',
			railTitle: 'Review',
			panels: [
				reviewCategoryPanel(),
				{ kind: 'groups', id: 'notImported', heading: 'Not Imported', lead: '1 items are held back, grouped by reason.', groups: [] },
			],
			footer: { lines: [], actions: [] },
		});
		const { sent, user } = await mount(review);

		await user.click(screen.getByRole('checkbox', { name: 'Include Settings in this import' }));
		expect(intents(sent)).toContainEqual({ type: 'toggleCategory', category: 'settings', selected: false });

		await user.click(screen.getByRole('radio', { name: 'Use imported value 14 for editor.fontSize' }));
		expect(intents(sent)).toContainEqual({ type: 'chooseDecision', decisionId: 'settings:editor.fontSize', choice: 'import' });

		await user.click(screen.getByRole('button', { name: 'Keep All Current Values' }));
		expect(intents(sent)).toContainEqual({ type: 'chooseAllSettingDifferences', choice: 'preserveTarget' });
	});

	test('changes the detail pane from the rail and announces it politely', async () => {
		const review = presentation({
			phase: 'review',
			sections: [
				{ id: 'settings', label: 'Settings', status: 'attention', count: 3, statusDescription: 'Needs attention. 3 items.' },
				{ id: 'notImported', label: 'Not Imported', status: 'neutral', count: 1, statusDescription: '1 items.' },
			],
			defaultSectionId: 'settings',
			railLabel: 'Import sections',
			railTitle: 'Review',
			panels: [
				reviewCategoryPanel(),
				{ kind: 'groups', id: 'notImported', heading: 'Not Imported', lead: '1 items are held back, grouped by reason.', groups: [] },
			],
		});
		const { user } = await mount(review);

		const rail = screen.getByRole('navigation', { name: 'Import sections' });
		expect(within(rail).getByRole('button', { name: /Settings/ })).toHaveAttribute('aria-current', 'true');

		await user.click(within(rail).getByRole('button', { name: /Not Imported/ }));
		expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Not Imported');
		expect(screen.getByRole('status')).toHaveTextContent('Showing Not Imported.');
	});

	test('freezes conflict choices when the host withholds them', async () => {
		const publishers = presentation({
			phase: 'publishers',
			sections: [{ id: 'settings', label: 'Settings', status: 'ok', count: 3, statusDescription: 'Ready. 3 items.' }],
			defaultSectionId: 'settings',
			railLabel: 'Import sections',
			railTitle: 'Review',
			panels: [reviewCategoryPanel({
				include: undefined,
				bulkActions: undefined,
				conflicts: [conflictRow('settings:editor.fontSize', 'editor.fontSize', '13', '14', true)],
			})],
		});
		await mount(publishers);

		expect(screen.queryByRole('radio')).toBeNull();
		expect(screen.queryByRole('checkbox')).toBeNull();
		expect(screen.getByText('Keeping current value')).toBeInTheDocument();
	});

	test('keeps the footer and its actions outside the content scroller', async () => {
		const results = presentation({
			phase: 'results',
			footer: {
				lines: ['Import completed with issues'],
				actions: [
					{ id: 'results-copy', label: 'Copy Report', kind: 'default', disabled: false, intent: { type: 'copyReport' } },
					{ id: 'results-done', label: 'Done', kind: 'primary', disabled: false, intent: { type: 'close' } },
				],
			},
			panels: [{ kind: 'message', id: '', heading: 'Import Results' }],
		});
		const { sent, user } = await mount(results);

		const footer = screen.getByRole('contentinfo');
		const scroller = screen.getByLabelText('Import Results');
		expect(scroller.contains(footer)).toBe(false);

		await user.click(within(footer).getByRole('button', { name: 'Copy Report' }));
		expect(intents(sent)).toContainEqual({ type: 'copyReport' });
		await user.click(within(footer).getByRole('button', { name: 'Done' }));
		expect(intents(sent)).toContainEqual({ type: 'close' });
	});

	test('reports host errors through an alert rather than the polite status region', async () => {
		const { publish } = await mount();
		await act(async () => publish(presentation({ revision: 2, error: 'The source changed while Hucode was reading it.' })));

		expect(screen.getByRole('alert')).toHaveTextContent('The source changed while Hucode was reading it.');
		expect(screen.getByRole('status')).toHaveTextContent('');
	});

	test('lands focus on the new phase heading when a snapshot removes the focused control', async () => {
		const { publish, user } = await mount();
		const cursor = screen.getByRole('button', { name: /Cursor/ });
		await user.click(cursor);
		expect(document.activeElement).toBe(cursor);

		await act(async () => publish(presentation({ revision: 2, phase: 'profile', panels: [profilesPanel()] })));
		expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
	});

	test('keeps focus on a control the next snapshot still offers', async () => {
		const { publish, user } = await mount();
		const refresh = screen.getByRole('button', { name: 'Refresh' });
		await user.click(refresh);

		await act(async () => publish(presentation({ revision: 2 })));
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh' }));
	});

	test('discards local filter state when the presentation scope changes', async () => {
		const many = presentation({
			panels: [{
				kind: 'applications',
				id: '',
				heading: 'Which Application Should Hucode Import From?',
				lead: 'Choose an editor first. You will choose one of its profiles next.',
				filterLabel: 'Filter applications',
				listLabel: 'Source applications',
				emptyText: 'No supported editor profiles were found.',
				noMatchText: 'Nothing matches the current filter.',
				applications: Array.from({ length: 12 }, (_, index) => ({
					id: `editor-${index}`,
					title: `Editor ${index}`,
					detail: '1 profile',
					intent: { type: 'selectApplication' as const, applicationId: `editor-${index}` },
				})),
			}],
		});
		const { publish, user } = await mount(many);

		await user.type(screen.getByLabelText('Filter applications'), 'Editor 11');
		expect(await screen.findByRole('button', { name: /Editor 11/ })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Editor 1 / })).toBeNull();

		await act(async () => publish({ ...many, revision: 2, scopeKey: 'review|draft|' }));
		expect(screen.getByLabelText('Filter applications')).toHaveValue('');
	});
});
