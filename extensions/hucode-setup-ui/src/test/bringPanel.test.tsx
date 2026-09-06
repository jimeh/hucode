/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { SetupShell } from '@/components/SetupShell';
import { presentation, testHost } from '@/test/fixtures';
import type { EditorMigrationSetupIntent, EditorMigrationSetupPresentation } from '@/generated/editorMigrationSetupProtocol';

afterEach(cleanup);

/** The onboarding route's first snapshot, shaped the way core's presentation mapper emits it. */
function bringPresentation(): EditorMigrationSetupPresentation {
	return presentation({
		route: 'onboarding',
		phase: 'bring',
		regionLabel: 'Hucode Onboarding',
		title: 'Welcome to Hucode',
		steps: [
			{ id: 'bring', label: 'Bring Your Setup', current: true },
			{ id: 'review', label: 'Review', current: false },
			{ id: 'meetOmni', label: 'Meet Omni', current: false },
		],
		scopeKey: 'onboarding|bring|first',
		panels: [{
			kind: 'bring',
			id: '',
			heading: 'Bring Your Setup to Hucode',
			lead: 'Import from another editor, or continue without importing.',
			paragraphs: ['The import choices are not available yet.', 'Do This Later keeps your place.'],
		}],
		footer: {
			lines: [],
			actions: [
				{ id: 'skip', label: 'Skip', kind: 'default', disabled: false, intent: { type: 'skip' } },
				{ id: 'later', label: 'Do This Later', kind: 'default', disabled: false, intent: { type: 'close' } },
			],
		},
	});
}

function intents(sent: readonly unknown[]): EditorMigrationSetupIntent[] {
	return sent.map(message => (message as { intent: EditorMigrationSetupIntent }).intent);
}

describe('BringPanel', () => {
	test('renders the host copy and posts the footer intents verbatim', async () => {
		const { host, sent, publish } = testHost();
		render(<SetupShell host={host} />);
		await act(async () => publish(bringPresentation()));
		const user = userEvent.setup();

		expect(screen.getByRole('region', { name: 'Hucode Onboarding' })).toBeInTheDocument();
		const heading = screen.getByRole('heading', { level: 2 });
		expect(heading).toHaveTextContent('Bring Your Setup to Hucode');
		expect(heading).toHaveAttribute('data-panel-heading');
		expect(screen.getByText('Import from another editor, or continue without importing.')).toBeInTheDocument();
		expect(screen.getByText('The import choices are not available yet.')).toBeInTheDocument();
		expect(screen.getByText('Do This Later keeps your place.')).toBeInTheDocument();
		expect(screen.getByText('Bring Your Setup').closest('li')).toHaveAttribute('aria-current', 'step');
		expect(screen.queryByRole('navigation')).toBeNull();

		await user.click(screen.getByRole('button', { name: 'Skip' }));
		await user.click(screen.getByRole('button', { name: 'Do This Later' }));
		expect(intents(sent)).toEqual([{ type: 'skip' }, { type: 'close' }]);
	});
});
