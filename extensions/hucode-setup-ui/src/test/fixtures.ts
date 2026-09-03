/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
	type EditorMigrationSetupPanel,
	type EditorMigrationSetupPresentation,
} from '@/generated/editorMigrationSetupProtocol';
import { SetupHost } from '@/lib/host';

/**
 * Wire-shaped presentation fixtures.
 *
 * Core owns every string, so the tests assert on the copy they supply here rather than on any
 * literal the renderer could have invented.
 */
export function presentation(overrides: Partial<EditorMigrationSetupPresentation> = {}): EditorMigrationSetupPresentation {
	return {
		revision: 1,
		phase: 'application',
		regionLabel: 'Editor Setup Import',
		title: 'Import Setup from Another Editor',
		steps: [
			{ id: 'discover', label: 'Discover', current: true },
			{ id: 'review', label: 'Review', current: false },
			{ id: 'apply', label: 'Apply', current: false },
			{ id: 'results', label: 'Results', current: false },
		],
		busy: false,
		canceling: false,
		sections: [],
		scopeKey: 'discover||',
		panels: [applicationsPanel()],
		footer: { lines: ['2 applications found.'], actions: [{ id: 'refresh', label: 'Refresh', kind: 'default', disabled: false, intent: { type: 'refreshDiscovery' } }] },
		sectionAnnouncementTemplate: 'Showing {0}.',
		...overrides,
	};
}

export function applicationsPanel(): EditorMigrationSetupPanel {
	return {
		kind: 'applications',
		id: '',
		heading: 'Which Application Should Hucode Import From?',
		lead: 'Choose an editor first. You will choose one of its profiles next.',
		filterLabel: 'Filter applications',
		listLabel: 'Source applications',
		emptyText: 'No supported editor profiles were found.',
		noMatchText: 'Nothing matches the current filter.',
		applications: [
			{ id: 'cursor', title: 'Cursor', detail: '2 profiles', intent: { type: 'selectApplication', applicationId: 'cursor' } },
			{ id: 'vscode', title: 'Visual Studio Code', detail: '1 profile', intent: { type: 'selectApplication', applicationId: 'vscode' } },
		],
	};
}

export function profilesPanel(): EditorMigrationSetupPanel {
	return {
		kind: 'profiles',
		id: '',
		heading: 'Choose a Cursor Profile',
		filterLabel: 'Filter profiles',
		groupLabel: 'Source profile',
		noMatchText: 'Nothing matches the current filter.',
		profiles: [
			{ id: 'cursor-default', label: 'Default', checked: true, intent: { type: 'selectSourceProfile', sourceRef: 'cursor-default' } },
			{ id: 'cursor-work', label: 'Work', checked: false, intent: { type: 'selectSourceProfile', sourceRef: 'cursor-work' } },
		],
	};
}

export function reviewCategoryPanel(overrides: Partial<Extract<EditorMigrationSetupPanel, { kind: 'reviewCategory' }>> = {}): EditorMigrationSetupPanel {
	return {
		kind: 'reviewCategory',
		id: 'settings',
		heading: 'Settings',
		lead: '3 of 5 will be imported. 1 differ from your current values.',
		include: { label: 'Include Settings in this import', checked: true, category: 'settings' },
		ownership: 'Stored directly in Work.',
		differencesHeading: '1 differ from your current values',
		bulkActions: [
			{ id: 'keep-all-settings', label: 'Keep All Current Values', kind: 'default', disabled: false, intent: { type: 'chooseAllSettingDifferences', choice: 'preserveTarget' } },
			{ id: 'import-all-settings', label: 'Use Imported Values for All', kind: 'default', disabled: false, intent: { type: 'chooseAllSettingDifferences', choice: 'import' } },
		],
		conflictFilterLabel: 'Filter Settings differences',
		conflicts: [conflictRow('settings:editor.fontSize', 'editor.fontSize', '13', '14')],
		warnings: [],
		...overrides,
	} as EditorMigrationSetupPanel;
}

export function conflictRow(id: string, name: string, current: string, imported: string, readOnly = false) {
	return {
		id,
		name,
		searchText: name,
		currentValue: current,
		importedValue: imported,
		valuesDescription: `Current value ${current}. Imported value ${imported}.`,
		choices: readOnly ? undefined : [
			{ id: `decision-${id}-preserveTarget`, label: 'Keep', description: `Keep current value ${current} for ${name}`, checked: false, intent: { type: 'chooseDecision' as const, decisionId: id, choice: 'preserveTarget' as const } },
			{ id: `decision-${id}-import`, label: 'Use imported', description: `Use imported value ${imported} for ${name}`, checked: false, intent: { type: 'chooseDecision' as const, decisionId: id, choice: 'import' as const } },
		],
		chosenText: readOnly ? 'Keeping current value' : undefined,
	};
}

/** A host bound to in-memory transport, so a test can drive both directions. */
export function testHost(): { readonly host: SetupHost; readonly sent: unknown[]; publish(presentation: EditorMigrationSetupPresentation): void } {
	const sent: unknown[] = [];
	let deliver: ((message: unknown) => void) | undefined;
	const host = new SetupHost(
		message => sent.push(message),
		listener => {
			deliver = listener;
			return () => { deliver = undefined; };
		},
	);
	return {
		host,
		sent,
		publish(next) {
			deliver?.({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, type: 'state', revision: next.revision, presentation: next });
		},
	};
}
