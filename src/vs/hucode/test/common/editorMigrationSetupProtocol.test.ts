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
	isEditorMigrationSetupRevisionBound,
	parseEditorMigrationSetupHostMessage,
	parseEditorMigrationSetupIntent,
	parseEditorMigrationSetupIntentMessage,
} from '../../common/migration/editorMigrationSetupProtocol.js';

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

	test('marks exactly the identifier-bearing intents as revision bound', () => {
		const identifierBearing = EVERY_INTENT
			.filter(intent => Object.keys(intent).length > 1)
			.map(intent => intent.type)
			// Bulk and per-decision choices are the same user gesture class, but only the one that
			// names a decision can resolve against a different list.
			.filter(type => type !== 'chooseAllSettingDifferences');
		assert.deepStrictEqual(
			[...new Set(identifierBearing)].sort(),
			[...EDITOR_MIGRATION_SETUP_REVISION_BOUND_INTENTS].sort(),
		);
		assert.strictEqual(isEditorMigrationSetupRevisionBound('chooseDecision'), true);
		assert.strictEqual(isEditorMigrationSetupRevisionBound('acceptReview'), false);
	});

	test('parses every host message variant and refuses anything else', () => {
		const version = EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION;
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'state', revision: 1, presentation: { revision: 1 } }));
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'accepted', revision: 1, intentType: 'back' }));
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'error', revision: 1, message: '' }));
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'focus', revision: 1, focusId: 'detail' }));
		assert.ok(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'disposed' }));
		assert.strictEqual(parseEditorMigrationSetupHostMessage({ protocolVersion: version + 1, type: 'disposed' }), undefined);
		assert.strictEqual(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'state', revision: 1 }), undefined);
		assert.strictEqual(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'focus', revision: 1, focusId: '' }), undefined);
		assert.strictEqual(parseEditorMigrationSetupHostMessage({ protocolVersion: version, type: 'restart' }), undefined);
	});
});
