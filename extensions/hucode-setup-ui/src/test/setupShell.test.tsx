/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { SetupShell } from '@/components/SetupShell';
import { presentation, profilesPanel, reviewCategoryPanel, restorePanel, targetPanel, conflictRow, manyConflicts, testHost } from '@/test/fixtures';
import {
	EDITOR_MIGRATION_SETUP_HEADING_FOCUS_ID,
	EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
	type EditorMigrationSetupIntent,
} from '@/generated/editorMigrationSetupProtocol';

afterEach(cleanup);

function intents(sent: readonly unknown[]): EditorMigrationSetupIntent[] {
	return sent.map(message => (message as { intent: EditorMigrationSetupIntent }).intent);
}

async function mount(initial = presentation()) {
	const { host, sent, publish, deliverHostMessage } = testHost();
	render(<SetupShell host={host} />);
	await act(async () => publish(initial));
	return { sent, publish, deliverHostMessage, user: userEvent.setup() };
}

/** The review sections and panels both phases share, so only the phase differs between them. */
const REVIEW_SECTIONS = [
	{ id: 'settings', label: 'Settings', status: 'attention' as const, count: 3, statusDescription: 'Needs attention. 3 items.' },
	{ id: 'notImported', label: 'Not Imported', status: 'neutral' as const, count: 1, statusDescription: '1 items.' },
];

const NOT_IMPORTED_PANEL = {
	kind: 'groups' as const,
	id: 'notImported',
	heading: 'Not Imported',
	lead: '1 items are held back, grouped by reason.',
	groups: [],
};

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

	test('moves off a review category when publisher confirmation arrives on the same scope', async () => {
		const scopeKey = 'review|draft-1|';
		const review = presentation({
			phase: 'review',
			scopeKey,
			sections: REVIEW_SECTIONS,
			defaultSectionId: 'settings',
			railLabel: 'Import sections',
			railTitle: 'Review',
			panels: [reviewCategoryPanel({ conflicts: manyConflicts() }), NOT_IMPORTED_PANEL],
		});
		const { publish, user } = await mount(review);

		// The user parks the rail on a category that publisher confirmation also offers.
		await user.click(within(screen.getByRole('navigation', { name: 'Import sections' })).getByRole('button', { name: /Not Imported/ }));
		expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Not Imported');

		await act(async () => publish(presentation({
			revision: 2,
			phase: 'publishers',
			// Deliberately the same scope: review and publisher confirmation describe one draft.
			scopeKey,
			sections: [...REVIEW_SECTIONS, { id: 'publishers', label: 'Publishers', status: 'attention', count: 1, separated: true, statusDescription: 'Needs attention. 1 items.' }],
			defaultSectionId: 'publishers',
			railLabel: 'Import sections',
			railTitle: 'Review',
			panels: [
				reviewCategoryPanel({ include: undefined, bulkActions: undefined, conflicts: [conflictRow('settings:editor.fontSize', 'editor.fontSize', '13', '14', true), ...manyConflicts()] }),
				NOT_IMPORTED_PANEL,
				{ kind: 'groups', id: 'publishers', heading: 'Confirm Extension Publishers', lead: 'These publishers provide extensions in the reviewed import.', groups: [{ id: 'publisher:acme', title: 'acme provides 2 extensions in this import.', count: 2, countDescription: '2 items.' }] },
			],
			footer: { lines: [], actions: [{ id: 'publishers-confirm', label: 'Confirm Publishers and Import', kind: 'primary', disabled: false, intent: { type: 'confirmPublishers' } }] },
		})));

		expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Confirm Extension Publishers');
		expect(screen.getByText('acme provides 2 extensions in this import.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Confirm Publishers and Import' })).toBeInTheDocument();
	});

	test('keeps filters and disclosures across the review to publishers transition', async () => {
		const scopeKey = 'review|draft-1|';
		const review = presentation({
			phase: 'review',
			scopeKey,
			sections: REVIEW_SECTIONS,
			defaultSectionId: 'settings',
			railLabel: 'Import sections',
			railTitle: 'Review',
			panels: [reviewCategoryPanel({ conflicts: manyConflicts() }), NOT_IMPORTED_PANEL],
		});
		const { publish, user } = await mount(review);
		await user.type(screen.getByLabelText('Filter Settings differences'), 'conflict-3');

		await act(async () => publish({ ...review, revision: 2, phase: 'publishers' }));

		// The rail moved to the phase default, but the typed filter belongs to the draft, not the phase.
		await user.click(within(screen.getByRole('navigation', { name: 'Import sections' })).getByRole('button', { name: /Settings/ }));
		expect(screen.getByLabelText('Filter Settings differences')).toHaveValue('conflict-3');
	});

	test('takes the host focus request into the panel heading', async () => {
		const { deliverHostMessage } = await mount();
		expect(document.activeElement).toBe(document.body);

		await act(async () => deliverHostMessage({
			protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
			type: 'focus',
			revision: 1,
			focusId: EDITOR_MIGRATION_SETUP_HEADING_FOCUS_ID,
		}));

		expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
	});

	test('compares profiles by what each one actually offers', async () => {
		await mount(presentation({
			phase: 'profile',
			panels: [{
				...(profilesPanel() as Extract<ReturnType<typeof profilesPanel>, { kind: 'profiles' }>),
				profiles: [
					{ id: 'cursor-default', label: 'Default', description: 'Settings: 42 items · Keyboard Shortcuts: 7 items · Extensions: 18 items', checked: true, intent: { type: 'selectSourceProfile', sourceRef: 'cursor-default' } },
					{ id: 'cursor-work', label: 'Work', description: 'Settings: 3 items · Keyboard Shortcuts: not found · Extensions: could not be read', checked: false, intent: { type: 'selectSourceProfile', sourceRef: 'cursor-work' } },
				],
			}],
		}));

		expect(screen.getByText('Settings: 42 items · Keyboard Shortcuts: 7 items · Extensions: 18 items')).toBeInTheDocument();
		expect(screen.getByText('Settings: 3 items · Keyboard Shortcuts: not found · Extensions: could not be read')).toBeInTheDocument();
	});

	test('lets an explicitly emptied new-profile name stay empty', async () => {
		const { user } = await mount(presentation({ phase: 'target', panels: [targetPanel('Imported')] }));
		const input = screen.getByLabelText('New profile name');
		expect(input).toHaveValue('Imported');

		await user.clear(input);

		expect(input).toHaveValue('');
		expect(screen.getByRole('button', { name: 'Use New Profile' })).toBeDisabled();
	});

	test('keeps the last rollback category unchecked across a later snapshot', async () => {
		const results = presentation({
			phase: 'results',
			scopeKey: 'results||operation-1',
			sections: [{ id: 'restore', label: 'Undo File Changes', status: 'neutral', statusDescription: '' }],
			defaultSectionId: 'restore',
			railLabel: 'Import sections',
			railTitle: 'Results',
			panels: [restorePanel()],
		});
		const { publish, user } = await mount(results);

		await user.click(screen.getByRole('checkbox', { name: 'Settings' }));
		await user.click(screen.getByRole('checkbox', { name: 'Snippets' }));
		expect(screen.getByRole('checkbox', { name: 'Settings' })).not.toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'Snippets' })).not.toBeChecked();
		expect(screen.getByRole('button', { name: 'Check File Rollback' })).toBeDisabled();

		await act(async () => publish({ ...results, revision: 2 }));

		expect(screen.getByRole('checkbox', { name: 'Settings' })).not.toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'Snippets' })).not.toBeChecked();
	});

	test('does not carry a rail announcement into a later host announcement', async () => {
		const review = presentation({
			phase: 'review',
			sections: REVIEW_SECTIONS,
			defaultSectionId: 'settings',
			railLabel: 'Import sections',
			railTitle: 'Review',
			panels: [reviewCategoryPanel(), NOT_IMPORTED_PANEL],
		});
		const { publish, user } = await mount(review);

		await user.click(within(screen.getByRole('navigation', { name: 'Import sections' })).getByRole('button', { name: /Not Imported/ }));
		expect(screen.getByRole('status')).toHaveTextContent('Showing Not Imported.');

		await act(async () => publish({ ...review, revision: 2, announcement: 'Importing selected items. 4 of 10 items recorded.' }));

		expect(screen.getByRole('status')).toHaveTextContent('Importing selected items. 4 of 10 items recorded.');
		expect(screen.getByRole('status').textContent).not.toMatch(/Showing/);
	});

	test('surfaces a refused gesture as an alert alongside the refreshed state', async () => {
		const { publish, deliverHostMessage } = await mount();

		await act(async () => {
			publish(presentation({ revision: 2 }));
			deliverHostMessage({
				protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
				type: 'error',
				revision: 2,
				message: 'That choice is no longer available. The screen has been refreshed with the current options.',
			});
		});

		expect(screen.getByRole('alert')).toHaveTextContent('That choice is no longer available.');
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
