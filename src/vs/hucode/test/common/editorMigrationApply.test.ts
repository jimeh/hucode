/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION, EDITOR_MIGRATION_POLICY_VERSION, EditorMigrationReviewedPlan, EditorMigrationTargetSnapshot } from '../../common/migration/editorMigrationPlanning.js';
import { acceptEditorMigrationPlanDraft, createEditorMigrationPlanDraft, editorMigrationKeybindingRowId } from '../../common/migration/editorMigrationPlanner.js';
import { EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, EditorMigrationSourceSnapshot } from '../../common/migration/editorMigrationSource.js';
import { fingerprintEditorMigrationValue } from '../../common/migration/editorMigrationPlanningCanonical.js';
import {
	EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION,
	EDITOR_MIGRATION_OPERATION_INTEGRITY_SCHEMA_VERSION,
	EDITOR_MIGRATION_OPERATION_PLANNING_SCHEMA_VERSION,
	EditorMigrationApplyAuthorizationIssuer,
	EditorMigrationOperation,
	createEditorMigrationOperationIntegrity,
	deriveEditorMigrationAggregateOutcome,
	editorMigrationPublishers,
	reduceEditorMigrationKeybindings,
	reduceEditorMigrationSettings,
	toEditorMigrationTelemetry,
	verifiedEditorMigrationPlanFingerprint,
	verifiedPersistedEditorMigrationPlanFingerprint,
	verifyEditorMigrationOperationIntegrity,
} from '../../common/migration/editorMigrationApply.js';
import { formatEditorMigrationReport } from '../../common/migration/editorMigrationReport.js';

suite('EditorMigrationApply', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('issues a single-use publisher authorization bound to the plan and exact publisher set', async () => {
		let now = 1_000;
		const issuer = new EditorMigrationApplyAuthorizationIssuer(() => now, () => 'nonce-1');
		const plan = await reviewedPlan(['Zed.One', 'alpha.two', 'alpha.three']);
		assert.deepStrictEqual(editorMigrationPublishers(plan), ['alpha', 'zed']);

		const authorization = await issuer.create(plan, [' ZED ', 'alpha']);
		assert.deepStrictEqual(await issuer.consume(plan, authorization), {
			planningSchemaVersion: plan.schemaVersion,
			planFingerprint: plan.fingerprints.plan,
			publishers: ['alpha', 'zed'],
			publisherSetFingerprint: authorization.publisherSetFingerprint,
			issuedAt: 1_000,
			consumedAt: 1_000,
		});
		await assert.rejects(() => issuer.consume(plan, authorization), /already been consumed/);

		const stale = await issuer.create(plan, ['alpha', 'zed']);
		await assert.rejects(async () => issuer.consume(await reviewedPlan(['zed.one', 'alpha.two']), stale), /does not match/);
		const first = plan.operations[0];
		assert.strictEqual(first.kind, 'installExtension');
		const mutated = { ...plan, operations: [...plan.operations, { ...first, id: 'extensions:zed.changed', item: 'zed.changed', source: { ...first.source, id: 'zed.changed' } }] } as EditorMigrationReviewedPlan;
		await assert.rejects(() => issuer.create(mutated, ['alpha', 'zed']), /non-canonical, stale, or corrupt/);
		const forgedOperations = [...plan.operations, { ...first, id: 'extensions:zed.changed', item: 'zed.changed', source: { ...first.source, id: 'zed.changed' } }];
		const forgedPlan = {
			...plan,
			operations: forgedOperations,
			fingerprints: {
				...plan.fingerprints,
				plan: await fingerprintEditorMigrationValue({
					schemaVersion: plan.schemaVersion,
					fingerprints: {
						source: plan.fingerprints.source,
						target: plan.fingerprints.target,
						choices: plan.fingerprints.choices,
						policy: plan.fingerprints.policy,
						gallery: plan.fingerprints.gallery,
					},
					operations: forgedOperations,
					prerequisites: plan.prerequisites,
				}),
			},
		} as EditorMigrationReviewedPlan;
		await assert.rejects(() => verifiedEditorMigrationPlanFingerprint(forgedPlan), /non-canonical/);
		now += 10 * 60 * 1_000 + 1;
		await assert.rejects(() => issuer.consume(plan, stale), /expired/);
		await assert.rejects(() => issuer.create(plan, ['alpha']), /publisher set does not match/);
	});

	test('requires service authorization even when no extension publishers are selected', async () => {
		const issuer = new EditorMigrationApplyAuthorizationIssuer(() => 5, () => 'empty-nonce');
		const plan = await reviewedPlan([]);
		const authorization = await issuer.create(plan, []);
		assert.deepStrictEqual((await issuer.consume(plan, authorization)).publishers, []);
	});

	test('validates persisted aggregates independently of current planner regeneration', async () => {
		const plan = await reviewedPlan([]);
		const changedSource = {
			...plan,
			source: {
				...plan.source,
				categories: [{ category: 'settings' as const, state: 'present' as const, value: { 'editor.wordWrap': 'off' } }],
			},
		};
		await assert.rejects(() => verifiedEditorMigrationPlanFingerprint(changedSource), /non-canonical, stale, or corrupt/);
		assert.strictEqual(await verifiedPersistedEditorMigrationPlanFingerprint(changedSource), plan.fingerprints.plan);
		const integrity = await createEditorMigrationOperationIntegrity(changedSource);
		await verifyEditorMigrationOperationIntegrity(changedSource, integrity);
		await assert.rejects(() => verifyEditorMigrationOperationIntegrity(plan, integrity), /plan integrity is corrupt/);
		await assert.rejects(() => verifiedPersistedEditorMigrationPlanFingerprint({
			...changedSource,
			fingerprints: { ...changedSource.fingerprints, plan: 'tampered' },
		}), /aggregate fingerprint is corrupt/);
		assert.strictEqual(EDITOR_MIGRATION_OPERATION_PLANNING_SCHEMA_VERSION, 2);
		assert.strictEqual(EDITOR_MIGRATION_OPERATION_INTEGRITY_SCHEMA_VERSION, 1);
	});

	test('reduces settings and exact indexed keybinding replacements without touching unrelated rows', () => {
		const settings = reduceEditorMigrationSettings('{\n\t// keep\n\t"editor.fontSize": 12\n}\n', [
			{ id: 'settings:editor.wordWrap', category: 'settings', kind: 'setSetting', item: 'editor.wordWrap', source: 'on' },
		]);
		assert.match(settings, /\/\/ keep/);
		assert.match(settings, /"editor.wordWrap": "on"/);

		const evidence = { registryIgnoredSettings: [], normalizedKeys: {}, keybindingPlatform: 'linux', gallery: [] };
		const input = '[\n\t// first\n\t{ "key": "ctrl+k", "command": "old" },\n\t{ "key": "ctrl+x", "command": "unrelated" }\n]\n';
		const result = reduceEditorMigrationKeybindings(input, evidence, [{
			id: 'replace', category: 'keybindings', kind: 'replaceKeybinding', item: 'replacement',
			source: { key: 'ctrl+k', command: 'new' },
			relatedTargetIds: ['{"identity":"{\\"args\\":null,\\"command\\":\\"old\\",\\"key\\":\\"ctrl+k\\",\\"when\\":\\"\\"}","index":0}'],
		}]);
		assert.match(result, /\/\/ first/);
		assert.match(result, /"command": "new"/);
		assert.match(result, /"command": "unrelated"/);
		assert.doesNotMatch(result, /"command": "old"/);
	});

	test('applies interleaved multi-row keybinding replacements against the reviewed array', () => {
		const evidence = { registryIgnoredSettings: [], normalizedKeys: {}, keybindingPlatform: 'linux', gallery: [] };
		const input = JSON.stringify([
			{ key: 'ctrl+a', command: 'old.a' },
			{ key: 'ctrl+u', command: 'keep.one' },
			{ key: 'ctrl+b', command: 'old.b' },
			{ key: 'ctrl+v', command: 'keep.two' },
			{ key: 'ctrl+c', command: 'old.c' },
		]);
		const parsed = JSON.parse(input);
		const rowId = (index: number) => editorMigrationKeybindingRowId(parsed[index], evidence, index);
		const result = reduceEditorMigrationKeybindings(input, evidence, [
			{ id: 'replace-ac', category: 'keybindings', kind: 'replaceKeybinding', item: 'replacement-ac', source: { key: 'ctrl+x', command: 'new.ac' }, relatedTargetIds: [rowId(0), rowId(4)] },
			{ id: 'replace-b', category: 'keybindings', kind: 'replaceKeybinding', item: 'replacement-b', source: { key: 'ctrl+y', command: 'new.b' }, relatedTargetIds: [rowId(2), rowId(3)] },
		]);

		assert.deepStrictEqual(JSON.parse(result), [
			{ key: 'ctrl+x', command: 'new.ac' },
			{ key: 'ctrl+u', command: 'keep.one' },
			{ key: 'ctrl+y', command: 'new.b' },
		]);
	});

	test('derives durable aggregate outcomes and emits only telemetry-safe fields', () => {
		assert.strictEqual(EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION, 2);
		assert.strictEqual(deriveEditorMigrationAggregateOutcome(['completed', 'alreadyPresent']), 'completed');
		assert.strictEqual(deriveEditorMigrationAggregateOutcome(['completed', 'failed'], true), 'recoverable');
		assert.strictEqual(deriveEditorMigrationAggregateOutcome(['completed', 'unavailable']), 'completedWithIssues');

		const telemetry = toEditorMigrationTelemetry({
			operationSchemaVersion: 2,
			planningSchemaVersion: 2,
			aggregateOutcome: 'completedWithIssues',
			phase: 'settled',
			outcomes: ['completed', 'failed'],
			durationMs: 14_000,
		});
		assert.deepStrictEqual(telemetry, {
			operationSchemaVersion: 2,
			planningSchemaVersion: 2,
			aggregateOutcome: 'completedWithIssues',
			phase: 'settled',
			outcomeCounts: { completed: 1, failed: 1 },
			durationBucket: 'underMinute',
		});
		assert.doesNotMatch(JSON.stringify(telemetry), /extension|profile|path|fingerprint|operationId/i);
	});

	test('formats a useful report without private values, keybinding arguments, paths, or fingerprints', async () => {
		const base = await reviewedPlan([]);
		const secret = 'private-token-value';
		const keybindingId = `keybindings:{"args":{"token":"${secret}"},"command":"example.run","key":"ctrl+k","when":""}`;
		const plan = {
			...base,
			choices: { selectedCategories: ['settings', 'keybindings'] as const, decisions: [{ id: 'settings:editor.wordWrap', choice: 'preserveTarget' as const }] },
			operations: [{ id: keybindingId, category: 'keybindings' as const, kind: 'addKeybinding' as const, item: keybindingId.slice('keybindings:'.length), source: { key: 'ctrl+k', command: 'example.run', args: { token: secret } }, relatedTargetIds: [] }],
		} as EditorMigrationReviewedPlan;
		const operation: EditorMigrationOperation = {
			schemaVersion: EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION,
			id: 'report-operation', revision: 7, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000,
			plan,
			integrity: { schemaVersion: EDITOR_MIGRATION_OPERATION_INTEGRITY_SCHEMA_VERSION, algorithm: 'sha256', planDigest: 'private-fingerprint' },
			authorization: { planningSchemaVersion: 2, planFingerprint: 'private-plan-fingerprint', publishers: [], publisherSetFingerprint: 'private-publisher-fingerprint', issuedAt: 1, consumedAt: 2 },
			stage: 'settled', cancellationRequested: false,
			target: { state: 'attached', profileId: 'default', profileName: 'Default' },
			snapshots: [{ category: 'settings', state: 'present', ownership: 'target', resource: '/Users/private/settings.json', snapshotPath: '/private/snapshot', byteHash: 'private-byte-fingerprint' }],
			snapshotCompletedCategories: ['settings'], extensionInstallIntents: [], retryItemIds: [], rollbackDriftSnapshots: [],
			results: [{ id: keybindingId, category: 'keybindings', outcome: 'completed', attempts: 1, diagnostic: { code: 'safeCode', message: '/Users/private/error' } }],
			aggregateOutcome: 'completed', acknowledged: false,
		};

		const report = formatEditorMigrationReport(operation);
		assert.match(report, /Visual Studio Code \/ Default/);
		assert.match(report, /Target: Default/);
		assert.match(report, /Keybinding change 1: completed \[safeCode\]/);
		assert.match(report, /Setting editor\.wordWrap/);
		assert.doesNotMatch(report, /private-token-value|Users\/private|private-fingerprint|private-plan-fingerprint|private-byte-fingerprint/);
	});
});

async function reviewedPlan(extensionIds: readonly string[]): Promise<EditorMigrationReviewedPlan> {
	const selectedCategories = extensionIds.length ? ['extensions'] as const : ['settings'] as const;
	const sourceCategories: EditorMigrationSourceSnapshot['categories'] = extensionIds.length
		? [{ category: 'extensions', state: 'present', value: extensionIds.map((id, index) => ({ id, version: `${index + 1}.0.0` })) }]
		: [{ category: 'settings', state: 'present', value: { 'editor.wordWrap': 'on' } }];
	const source: EditorMigrationSourceSnapshot = {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: 'source-v1:apply-common-test' },
		adapter: { id: 'vscode', productName: 'Visual Studio Code', channel: 'stable', order: 0 },
		profile: { id: 'default', name: 'Default', kind: 'default' },
		categories: sourceCategories,
		diagnostics: [],
		fingerprint: { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, algorithm: 'sha256', categories: selectedCategories, entries: [], value: 'apply-common-source' },
	};
	const gallery = extensionIds.map((id, index) => ({
		id, requestedChannel: 'stable' as const, status: 'available' as const, version: `${index + 1}.0.0`, targetPlatform: 'linux-x64', selectedChannel: 'stable' as const, engine: '*', galleryIdentity: 'open-vsx',
	}));
	const target: EditorMigrationTargetSnapshot = {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		selection: { kind: 'existing' as const, profileId: 'default' },
		profile: { id: 'default', name: 'Default', kind: 'default' as const },
		eligible: true,
		catalogFingerprint: 'catalog',
		requestedCategories: selectedCategories,
		categories: extensionIds.length
			? [{ category: 'extensions' as const, ownership: 'target' as const, ownerProfileId: 'default', state: 'absent' as const, contentHash: 'absent', semanticHash: 'empty', value: [] }]
			: [{ category: 'settings' as const, ownership: 'target' as const, ownerProfileId: 'default', state: 'absent' as const, contentHash: 'absent', value: {} }],
		environment: { targetPlatform: 'linux-x64', productVersion: '1.135.0', hucodeVersion: '0.0.1', galleryIdentity: 'open-vsx', policyVersion: EDITOR_MIGRATION_POLICY_VERSION },
		builtIns: [], fingerprint: 'target',
	};
	const draft = createEditorMigrationPlanDraft(source, target, { registryIgnoredSettings: [], normalizedKeys: {}, keybindingPlatform: '', gallery });
	const reviewed = await acceptEditorMigrationPlanDraft(draft, { selectedCategories, decisions: [] });
	assert.strictEqual(await verifiedEditorMigrationPlanFingerprint(reviewed), reviewed.fingerprints.plan);
	return reviewed;
}
