/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import {
	EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
	EDITOR_MIGRATION_SETUP_REVISION_BOUND_INTENTS,
	EditorMigrationSetupIntent,
	EditorMigrationSetupPresentation,
	editorMigrationSetupPhaseAdmits,
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

	test('binds the phase-advancing and bulk actions to the snapshot they were formed against', () => {
		for (const type of ['acceptReview', 'confirmPublishers', 'chooseAllSettingDifferences', 'rebuildReview'] as const) {
			assert.strictEqual(isEditorMigrationSetupRevisionBound(type), true, `${type} must not outlive its snapshot`);
		}
		// A second click landing after the first has advanced the phase describes a screen that is
		// already gone, which is what stops it starting a second import or cancelling the first.
		assert.strictEqual(editorMigrationSetupPhaseAdmits('confirmPublishers', 'publishers', false), true);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('confirmPublishers', 'publishers', true), false, 'a running confirmation admits no duplicate');
		assert.strictEqual(editorMigrationSetupPhaseAdmits('confirmPublishers', 'apply', false), false);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('acceptReview', 'review', false), true);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('acceptReview', 'publishers', false), false);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('chooseAllSettingDifferences', 'review', false), true);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('chooseAllSettingDifferences', 'publishers', false), false, 'the reviewed plan has already frozen these decisions');
		assert.strictEqual(editorMigrationSetupPhaseAdmits('chooseDecision', 'publishers', false), false);
		// Cancelling and going back stay available at every point, including while busy.
		assert.strictEqual(editorMigrationSetupPhaseAdmits('requestCancellation', 'apply', true), true);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('back', 'review', true), true);
		assert.strictEqual(editorMigrationSetupPhaseAdmits('close', 'apply', true), true);
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
		assert.strictEqual(isEditorMigrationSetupPresentation({ ...validPresentation(), panels: [{ id: 'x' }] }), false, 'a panel without a kind is unrenderable');
		assert.strictEqual(isEditorMigrationSetupPresentation({ ...validPresentation(), footer: { lines: 'nope', actions: [] } }), false);
		assert.strictEqual(isEditorMigrationSetupPresentation({ ...validPresentation(), footer: { lines: [], actions: [{ id: 'a', label: 'b', kind: 'default' }] } }), false, 'an action the renderer cannot post back is malformed');
		assert.strictEqual(isEditorMigrationSetupPresentation({ ...validPresentation(), sections: [{ id: 's' }] }), false);

		// The trust boundary itself refuses it, so the renderer never sees it.
		assert.strictEqual(parseEditorMigrationSetupHostMessage({
			protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
			type: 'state',
			revision: 1,
			presentation: { revision: 1 },
		}), undefined);
		assert.ok(parseEditorMigrationSetupHostMessage({
			protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION,
			type: 'state',
			revision: 1,
			presentation: validPresentation(),
		}));
	});

	test('marks exactly the identifier-bearing intents as revision bound', () => {
		const identifierBearing = EVERY_INTENT
			.filter(intent => Object.keys(intent).length > 1)
			.map(intent => intent.type);
		// Everything that names something from a snapshot, plus the actions that advance or rewrite
		// the phase without naming anything.
		const phaseAdvancing = ['acceptReview', 'confirmPublishers', 'rebuildReview'] as const;
		assert.deepStrictEqual(
			[...new Set([...identifierBearing, ...phaseAdvancing])].sort(),
			[...EDITOR_MIGRATION_SETUP_REVISION_BOUND_INTENTS].sort(),
		);
		assert.strictEqual(isEditorMigrationSetupRevisionBound('chooseDecision'), true);
		assert.strictEqual(isEditorMigrationSetupRevisionBound('back'), false, 'going back describes no particular screen');
		assert.strictEqual(isEditorMigrationSetupRevisionBound('requestCancellation'), false, 'cancelling must never be refused as stale');
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
