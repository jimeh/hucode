/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import {
	EDITOR_MIGRATION_SETUP_INTENT_POLICY,
	EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
	EDITOR_MIGRATION_SETUP_REVISION_BOUND_INTENTS,
	EditorMigrationSetupIntentType,
	EditorMigrationSetupPhase,
	EditorMigrationSetupIntent,
	EditorMigrationSetupPresentation,
	editorMigrationSetupPhaseAdmits,
	isEditorMigrationSetupPanel,
	isEditorMigrationSetupPresentation,
	isEditorMigrationSetupRevisionBound,
	parseEditorMigrationSetupHostMessage,
	parseEditorMigrationSetupIntent,
	parseEditorMigrationSetupIntentMessage,
} from '../../common/migration/editorMigrationSetupProtocol.js';

/** The smallest snapshot the renderer can actually draw. */
function validPresentation(): EditorMigrationSetupPresentation {
	return {
		revision: 1,
		phase: 'application',
		regionLabel: 'Editor Setup Import',
		title: 'Import Setup from Another Editor',
		steps: [{ id: 'discover', label: 'Discover', current: true }],
		busy: false,
		canceling: false,
		sections: [],
		scopeKey: 'discover||',
		panels: [{ kind: 'message', id: '', heading: 'Import Editor Setup' }],
		footer: { lines: [], actions: [{ id: 'refresh', label: 'Refresh', kind: 'default', disabled: false, intent: { type: 'refreshDiscovery' } }] },
		sectionAnnouncementTemplate: 'Showing {0}.',
	};
}

/** One valid example of every renderer intent variant. */
const EVERY_INTENT: readonly EditorMigrationSetupIntent[] = [
	{ type: 'ready' },
	{ type: 'close' },
	{ type: 'startImport' },
	{ type: 'refreshDiscovery' },
	{ type: 'selectApplication', applicationId: 'cursor' },
	{ type: 'selectSourceProfile', sourceRef: 'cursor-default' },
	{ type: 'continueFromProfile' },
	{ type: 'selectTarget', target: { kind: 'existing', profileId: 'default' } },
	{ type: 'selectTarget', target: { kind: 'proposed', name: 'Imported' } },
	{ type: 'continueFromTarget' },
	{ type: 'rebuildReview' },
	{ type: 'toggleCategory', category: 'settings', selected: false },
	{ type: 'chooseDecision', decisionId: 'settings:editor.fontSize', choice: 'import' },
	{ type: 'chooseAllSettingDifferences', choice: 'preserveTarget' },
	{ type: 'acceptReview' },
	{ type: 'confirmPublishers' },
	{ type: 'requestCancellation' },
	{ type: 'showRecovery', operationId: 'operation' },
	{ type: 'resume', operationId: 'operation' },
	{ type: 'retry', operationId: 'operation' },
	{ type: 'inspectRollback', categories: ['settings', 'snippets'] },
	{ type: 'clearRollbackInspection' },
	{ type: 'rollback', categories: ['settings'], forceCategories: ['settings'] },
	{ type: 'copyReport' },
	{ type: 'acknowledge' },
	{ type: 'back' },
];

suite('EditorMigrationSetupProtocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips every intent variant through the runtime validator', () => {
		for (const intent of EVERY_INTENT) {
			const parsed = parseEditorMigrationSetupIntent(JSON.parse(JSON.stringify(intent)));
			assert.deepStrictEqual(parsed, intent, `expected ${intent.type} to survive the wire`);
		}
	});

	test('rejects malformed payloads, unknown types, and missing identifiers', () => {
		const rejected: unknown[] = [
			undefined,
			null,
			'startImport',
			[],
			{},
			{ type: 'launchTerminal' },
			{ type: 'selectApplication' },
			{ type: 'selectApplication', applicationId: '' },
			{ type: 'selectApplication', applicationId: 7 },
			{ type: 'selectSourceProfile', sourceRef: null },
			{ type: 'selectTarget', target: { kind: 'existing' } },
			{ type: 'selectTarget', target: { kind: 'command', profileId: 'default' } },
			{ type: 'toggleCategory', category: 'settings' },
			{ type: 'toggleCategory', category: 'themes', selected: true },
			{ type: 'chooseDecision', decisionId: 'x', choice: 'overwrite' },
			{ type: 'chooseAllSettingDifferences', choice: 'both' },
			{ type: 'inspectRollback', categories: ['extensions'] },
			{ type: 'rollback', categories: ['settings'] },
			{ type: 'rollback', categories: 'settings', forceCategories: [] },
		];
		for (const value of rejected) {
			assert.strictEqual(parseEditorMigrationSetupIntent(value), undefined, `expected ${JSON.stringify(value)} to be refused`);
		}
	});

	test('refuses an envelope with a foreign protocol version or a malformed revision', () => {
		const intent = { type: 'startImport' };
		assert.ok(parseEditorMigrationSetupIntentMessage({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 4, intent }));
		assert.strictEqual(parseEditorMigrationSetupIntentMessage({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION + 1, revision: 4, intent }), undefined);
		assert.strictEqual(parseEditorMigrationSetupIntentMessage({ revision: 4, intent }), undefined);
		assert.strictEqual(parseEditorMigrationSetupIntentMessage({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: -1, intent }), undefined);
		assert.strictEqual(parseEditorMigrationSetupIntentMessage({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: 1.5, intent }), undefined);
		assert.strictEqual(parseEditorMigrationSetupIntentMessage({ protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, intent }), undefined);
	});

	test('gives every intent a closed phase and busy policy', () => {
		const ALL_PHASES: readonly EditorMigrationSetupPhase[] = [
			'loading', 'recovery', 'application', 'profile', 'target', 'review', 'publishers', 'apply', 'results',
		];
		// Nothing may default to allowed: an intent added without a policy has no entry here, and
		// an entry naming no phase would silently make its control dead.
		const covered = new Set(Object.keys(EDITOR_MIGRATION_SETUP_INTENT_POLICY));
		const declared = new Set(EVERY_INTENT.map(intent => intent.type));
		assert.deepStrictEqual([...covered].sort(), [...declared].sort(), 'every intent variant needs a policy');
		for (const [type, policy] of Object.entries(EDITOR_MIGRATION_SETUP_INTENT_POLICY)) {
			assert.ok(policy.phases.length > 0, `${type} must be usable somewhere`);
			assert.ok(policy.phases.every(phase => ALL_PHASES.includes(phase)), `${type} names a phase that does not exist`);
		}

		// The exact policy, phase by phase, so a future edit has to change this table too.
		const expected: Readonly<Record<EditorMigrationSetupIntentType, { readonly phases: readonly EditorMigrationSetupPhase[]; readonly whileBusy: boolean }>> = {
			ready: { phases: ALL_PHASES, whileBusy: true },
			close: { phases: ALL_PHASES, whileBusy: true },
			startImport: { phases: ['recovery', 'results'], whileBusy: false },
			refreshDiscovery: { phases: ['application'], whileBusy: false },
			selectApplication: { phases: ['application'], whileBusy: false },
			selectSourceProfile: { phases: ['profile'], whileBusy: false },
			continueFromProfile: { phases: ['profile'], whileBusy: false },
			selectTarget: { phases: ['target'], whileBusy: false },
			continueFromTarget: { phases: ['target'], whileBusy: false },
			rebuildReview: { phases: ['review'], whileBusy: false },
			toggleCategory: { phases: ['review'], whileBusy: false },
			chooseDecision: { phases: ['review'], whileBusy: false },
			chooseAllSettingDifferences: { phases: ['review'], whileBusy: false },
			acceptReview: { phases: ['review'], whileBusy: false },
			confirmPublishers: { phases: ['publishers'], whileBusy: false },
			requestCancellation: { phases: ['apply'], whileBusy: true },
			showRecovery: { phases: ['recovery'], whileBusy: false },
			resume: { phases: ['results'], whileBusy: false },
			retry: { phases: ['results'], whileBusy: false },
			inspectRollback: { phases: ['results'], whileBusy: false },
			clearRollbackInspection: { phases: ['results'], whileBusy: true },
			copyReport: { phases: ['results'], whileBusy: true },
			rollback: { phases: ['results'], whileBusy: false },
			acknowledge: { phases: ['results'], whileBusy: false },
			back: { phases: ['profile', 'target', 'review', 'publishers'], whileBusy: true },
		};
		for (const [type, policy] of Object.entries(expected)) {
			for (const phase of ALL_PHASES) {
				for (const busy of [false, true]) {
					assert.strictEqual(
						editorMigrationSetupPhaseAdmits(type as EditorMigrationSetupIntentType, phase, busy),
						policy.phases.includes(phase) && (policy.whileBusy || !busy),
						`${type} in ${phase}${busy ? ' while busy' : ''}`,
					);
				}
			}
		}
	});

	test('keeps the duplicate-press hazards closed and the safe gestures usable', () => {
		// Restarting discovery twice would discard the first run.
		assert.strictEqual(editorMigrationSetupPhaseAdmits('startImport', 'recovery', true), false);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('refreshDiscovery', 'application', true), false);
		// Continuing twice would either skip a phase or read the source twice.
		assert.strictEqual(editorMigrationSetupPhaseAdmits('continueFromProfile', 'target', false), false);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('continueFromProfile', 'profile', true), false);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('continueFromTarget', 'review', false), false);
		// Back moves exactly one phase and stays legal in the phase it lands on, so only the
		// revision binding stops a double press skipping two.
		assert.strictEqual(editorMigrationSetupPhaseAdmits('back', 'target', false), true);
		assert.strictEqual(isEditorMigrationSetupRevisionBound('back'), true);
		// Leaving a screen is how the user abandons the work that screen started, so Back stays
		// admissible while that work is still in flight; the session supersedes it on arrival.
		assert.strictEqual(editorMigrationSetupPhaseAdmits('back', 'review', true), true);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('back', 'profile', true), true);
		// It remains inert where the session offers no destination.
		assert.strictEqual(editorMigrationSetupPhaseAdmits('back', 'apply', true), false);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('back', 'results', false), false);
		// Acknowledgement deletes durable recovery data and is never legal outside Results.
		assert.strictEqual(editorMigrationSetupPhaseAdmits('acknowledge', 'apply', false), false);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('acknowledge', 'results', true), false);
		// Cancelling and closing must survive a working session.
		assert.strictEqual(editorMigrationSetupPhaseAdmits('requestCancellation', 'apply', true), true);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('close', 'apply', true), true);
		// Read-only presentation gestures stay usable rather than becoming dead controls.
		assert.strictEqual(editorMigrationSetupPhaseAdmits('copyReport', 'results', true), true);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('clearRollbackInspection', 'results', true), true);
	});

	test('binds the actions whose decision the phase guard cannot protect', () => {
		for (const type of ['acceptReview', 'confirmPublishers', 'back'] as const) {
			assert.strictEqual(isEditorMigrationSetupRevisionBound(type), true, `${type} must not outlive its snapshot`);
		}
		// Idempotent review actions read only authoritative state and are already confined to
		// Review, so binding them would cost a refusal without protecting anything.
		assert.strictEqual(isEditorMigrationSetupRevisionBound('chooseAllSettingDifferences'), false);
		assert.strictEqual(isEditorMigrationSetupRevisionBound('rebuildReview'), false);
		assert.strictEqual(isEditorMigrationSetupRevisionBound('requestCancellation'), false, 'cancelling must never be refused as stale');
	});

	test('refuses a presentation payload the renderer would crash on', () => {
		assert.strictEqual(isEditorMigrationSetupPresentation(validPresentation()), true);
		// The exact payload shallow validation used to admit.
		assert.strictEqual(isEditorMigrationSetupPresentation({ revision: 1 }), false);
		const required: readonly (keyof EditorMigrationSetupPresentation)[] = [
			'revision', 'phase', 'regionLabel', 'title', 'scopeKey', 'sectionAnnouncementTemplate',
			'busy', 'canceling', 'steps', 'sections', 'panels', 'footer',
		];
		for (const key of required) {
			const withoutKey = { ...validPresentation() } as Record<string, unknown>;
			delete withoutKey[key];
			assert.strictEqual(isEditorMigrationSetupPresentation(withoutKey), false, `${key} must be required`);
		}
	});

	test('refuses a phase the renderer has no panel switch for', () => {
		assert.strictEqual(isEditorMigrationSetupPresentation({ ...validPresentation(), phase: 'onboarding' }), false);
		assert.strictEqual(isEditorMigrationSetupPresentation({ ...validPresentation(), phase: 7 }), false);
		for (const phase of ['loading', 'recovery', 'application', 'profile', 'target', 'review', 'publishers', 'apply', 'results']) {
			assert.strictEqual(isEditorMigrationSetupPresentation({ ...validPresentation(), phase }), true, `${phase} is a real phase`);
		}
	});

	test('refuses revisions and counts the renderer would compute with', () => {
		for (const revision of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', undefined]) {
			assert.strictEqual(isEditorMigrationSetupPresentation({ ...validPresentation(), revision }), false, `${String(revision)} is not a revision`);
		}
		const withSection = (count: unknown) => isEditorMigrationSetupPresentation({
			...validPresentation(),
			sections: [{ id: 's', label: 'Settings', status: 'ok', statusDescription: 'Ready.', count }],
		});
		assert.strictEqual(withSection(3), true);
		assert.strictEqual(withSection(undefined), true, 'a section may legitimately show no count');
		assert.strictEqual(withSection(-1), false);
		assert.strictEqual(withSection(2.5), false);
		// A progress bar drives ARIA value attributes, so its numbers must be real.
		const withProgress = (now: unknown) => isEditorMigrationSetupPresentation({
			...validPresentation(),
			panels: [{ kind: 'loading', id: '', heading: 'Looking...', progress: { text: 'Reading...', min: 0, max: 1, now } }],
		});
		assert.strictEqual(withProgress(0), true);
		assert.strictEqual(withProgress(Number.NaN), false);
		assert.strictEqual(withProgress('0'), false);
	});

	test('refuses a known panel kind that is missing what its component reads', () => {
		const withPanel = (panel: unknown) => isEditorMigrationSetupPresentation({ ...validPresentation(), panels: [panel] });
		// The exact payload the previous kind-and-id check admitted, straight into a `.map`.
		assert.strictEqual(withPanel({ kind: 'applications', id: 'x', heading: 'h' }), false);
		assert.strictEqual(withPanel({ kind: 'applications', id: 'x' }), false, 'every panel needs a heading');
		assert.strictEqual(withPanel({ kind: 'onboarding', id: 'x', heading: 'h' }), false, 'an unknown kind has no component');
		assert.strictEqual(withPanel({ kind: 'loading', id: '', heading: 'h' }), false, 'a loading panel without a progress bar');
		assert.strictEqual(withPanel({ kind: 'groups', id: 'g', heading: 'h', lead: 'l', groups: [{ id: 'x', title: 't', countDescription: 'd' }] }), false, 'a group without a count');
		assert.strictEqual(withPanel({ kind: 'target', id: '', heading: 'h', lead: 'l', groupLabel: 'g', targets: [], newTarget: { label: 'l', placeholder: 'p', actionLabel: 'a' } }), false, 'the new-target draft value is read directly');
		assert.strictEqual(withPanel({ kind: 'restore', id: 'restore', heading: 'h', inspection: { description: 'd', actionLabel: 'a', forced: true, driftedCategories: ['extensions'] } }), false, 'extensions are never a rollback category');
	});

	test('refuses a nested action or option the renderer would post straight back', () => {
		const withFooterAction = (action: unknown) => isEditorMigrationSetupPresentation({
			...validPresentation(),
			footer: { lines: [], actions: [action] },
		});
		assert.strictEqual(withFooterAction({ id: 'a', label: 'b', kind: 'default', disabled: false, intent: { type: 'back' } }), true);
		assert.strictEqual(withFooterAction({ id: 'a', label: 'b', kind: 'default', disabled: false }), false, 'an action with no intent');
		assert.strictEqual(withFooterAction({ id: 'a', label: 'b', kind: 'default', disabled: false, intent: { type: 'launchTerminal' } }), false, 'an intent outside the closed union');
		assert.strictEqual(withFooterAction({ id: 'a', label: 'b', kind: 'default', disabled: false, intent: { type: 'selectApplication' } }), false, 'a well-named intent missing its identifier');
		assert.strictEqual(withFooterAction({ id: 'a', label: 'b', kind: 'shout', disabled: false, intent: { type: 'back' } }), false, 'an action kind with no button variant');
		assert.strictEqual(withFooterAction({ id: 'a', label: 'b', kind: 'default', disabled: 'no', intent: { type: 'back' } }), false);

		// The same closed parsing applies to intents nested inside panels.
		const withOption = (intent: unknown) => isEditorMigrationSetupPresentation({
			...validPresentation(),
			panels: [{
				kind: 'profiles', id: '', heading: 'h', filterLabel: 'f', groupLabel: 'g', noMatchText: 'n',
				profiles: [{ id: 'p', label: 'Default', checked: true, intent }],
			}],
		});
		assert.strictEqual(withOption({ type: 'selectSourceProfile', sourceRef: 'cursor-default' }), true);
		assert.strictEqual(withOption({ type: 'selectSourceProfile' }), false);
		assert.strictEqual(withOption('selectSourceProfile'), false);
	});

	test('accepts a well-formed example of every panel kind', () => {
		const panels: readonly Record<string, unknown>[] = [
			{ kind: 'loading', id: '', heading: 'Looking...', progress: { text: 'Reading...', min: 0, max: 1, now: 0 } },
			{
				kind: 'recovery', id: '', heading: 'Continue', lead: 'l', filterLabel: 'f', listLabel: 'li', emptyText: 'e',
				records: [
					{ id: 'r', title: 't', detail: 'd', action: { id: 'a', label: 'Open', kind: 'default', disabled: false, intent: { type: 'showRecovery', operationId: 'r' } } },
					{ id: 'r2', title: 't2', detail: 'unsupported' },
				],
			},
			{
				kind: 'applications', id: '', heading: 'Which?', lead: 'l', filterLabel: 'f', listLabel: 'li', emptyText: 'e', noMatchText: 'n',
				applications: [{ id: 'cursor', title: 'Cursor', detail: '2 profiles', intent: { type: 'selectApplication', applicationId: 'cursor' } }],
				diagnostics: { id: 'discovery', summary: 'Discovery Details', items: ['x'] },
			},
			{
				kind: 'profiles', id: '', heading: 'Choose', filterLabel: 'f', groupLabel: 'g', noMatchText: 'n',
				profiles: [{ id: 'p', label: 'Default', description: 'Settings: 3 items', checked: true, intent: { type: 'selectSourceProfile', sourceRef: 'p' } }],
				details: { id: 'source-details', summary: 'Profile Details', items: ['x'], remainingText: 'and 1 more.' },
			},
			{
				kind: 'target', id: '', heading: 'Where?', lead: 'l', groupLabel: 'g',
				targets: [{ id: 'default', label: 'Default', checked: true, intent: { type: 'selectTarget', target: { kind: 'existing', profileId: 'default' } } }],
				newTarget: { label: 'l', placeholder: 'p', actionLabel: 'a', value: '', selectedText: undefined },
			},
			{
				kind: 'reviewCategory', id: 'settings', heading: 'Settings', lead: 'l', ownership: 'o',
				include: { label: 'Include', checked: true, category: 'settings' },
				bulkActions: [{ id: 'keep', label: 'Keep All', kind: 'default', disabled: false, intent: { type: 'chooseAllSettingDifferences', choice: 'preserveTarget' } }],
				conflicts: [{
					id: 'c', name: 'n', searchText: 's', currentValue: '13', importedValue: '14', valuesDescription: 'v',
					choices: [{ id: 'c-import', label: 'Use imported', checked: false, intent: { type: 'chooseDecision', decisionId: 'c', choice: 'import' } }],
				}],
				warnings: [{ id: 'w', title: 't', count: 2, countDescription: '2 items.' }],
				additions: { id: 'additions', summary: '2 new settings', items: ['a'] },
			},
			{ kind: 'groups', id: 'notImported', heading: 'Not Imported', lead: 'l', groups: [{ id: 'g', title: 't', count: 1, countDescription: '1 items.', disclosure: { id: 'd', summary: 's', items: [] } }] },
			{ kind: 'applyOverview', id: 'overview', heading: 'Importing...', progress: { text: 'p', min: 0, max: 10, now: 4 }, rows: [{ id: 'settings', label: 'Settings', state: 'Waiting.' }], currentItem: 'Working on Settings.', note: 'n' },
			{ kind: 'applyCategory', id: 'settings', heading: 'Settings', lead: 'l', problems: [{ id: 'p', text: 't', outcome: 'failed', detail: 'd' }], recordedNote: 'r' },
			{ kind: 'resultsOverview', id: 'overview', heading: 'Results', outcome: 'Completed', lead: 'l', placements: [], preserved: { id: 'preserved', summary: 's', items: [] }, rollbackOutcome: { heading: 'h', rows: ['r'], note: 'n' } },
			{ kind: 'resultsCategory', id: 'settings', heading: 'Settings', lead: 'l', problems: [], completed: { id: 'completed', summary: 's', items: [] } },
			{
				kind: 'restore', id: 'restore', heading: 'Undo', lead: 'l',
				selection: { legend: 'l', options: [{ category: 'settings', label: 'Settings' }], inspectLabel: 'Check' },
				inspection: { heading: 'h', description: 'd', actionLabel: 'a', forced: true, driftedCategories: ['settings'] },
			},
			{ kind: 'message', id: '', heading: 'Import Results' },
		];
		const kinds = new Set(panels.map(panel => panel.kind));
		assert.strictEqual(kinds.size, panels.length, 'each kind appears exactly once');
		for (const panel of panels) {
			assert.strictEqual(isEditorMigrationSetupPanel(panel), true, `${String(panel.kind)} should be accepted`);
			assert.strictEqual(isEditorMigrationSetupPresentation({ ...validPresentation(), panels: [panel] }), true, `${String(panel.kind)} in a snapshot`);
		}
	});

	test('refuses a malformed state message at the trust boundary', () => {
		const version = EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION;
		for (const presentation of [{ revision: 1 }, { ...validPresentation(), phase: 'onboarding' }, { ...validPresentation(), panels: [{ kind: 'applications', id: 'x', heading: 'h' }] }]) {
			assert.strictEqual(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'state', revision: 1, presentation }), undefined);
		}
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'state', revision: 1, presentation: validPresentation() }));
	});

	test('marks exactly the identifier-bearing intents as revision bound', () => {
		const identifierBearing = EVERY_INTENT
			.filter(intent => Object.keys(intent).length > 1)
			.map(intent => intent.type)
			// These name something, but read only authoritative state and cannot resolve against a
			// different list, so they are governed by phase alone.
			.filter(type => type !== 'chooseAllSettingDifferences');
		const decisionGates = ['acceptReview', 'confirmPublishers', 'back'] as const;
		assert.deepStrictEqual(
			[...new Set([...identifierBearing, ...decisionGates])].sort(),
			[...EDITOR_MIGRATION_SETUP_REVISION_BOUND_INTENTS].sort(),
		);
		assert.strictEqual(isEditorMigrationSetupRevisionBound('chooseDecision'), true);
		assert.strictEqual(isEditorMigrationSetupRevisionBound('copyReport'), false);
	});

	test('parses every host message variant and refuses anything else', () => {
		const version = EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION;
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'state', revision: 1, presentation: validPresentation() }));
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'accepted', revision: 1, intentType: 'back' }));
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'error', revision: 1, message: '' }));
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'focus', revision: 1, focusId: 'detail' }));
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'disposed' }));
		assert.strictEqual(parseEditorMigrationSetupHostMessage({ protocolVersion: version + 1, type: 'disposed' }), undefined);
		assert.strictEqual(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'state', revision: 1 }), undefined);
		assert.strictEqual(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'state', revision: 1, presentation: { revision: 1 } }), undefined);
		assert.strictEqual(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'focus', revision: 1, focusId: '' }), undefined);
		assert.strictEqual(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'restart' }), undefined);
	});
});
