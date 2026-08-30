/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EditorMigrationReviewedPlan } from '../../common/migration/editorMigrationPlanning.js';
import {
	EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION,
	EditorMigrationApplyAuthorizationIssuer,
	deriveEditorMigrationAggregateOutcome,
	editorMigrationPublishers,
	reduceEditorMigrationKeybindings,
	reduceEditorMigrationSettings,
	toEditorMigrationTelemetry,
} from '../../common/migration/editorMigrationApply.js';

suite('EditorMigrationApply', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('issues a single-use publisher authorization bound to the plan and exact publisher set', async () => {
		let now = 1_000;
		const issuer = new EditorMigrationApplyAuthorizationIssuer(() => now, () => 'nonce-1');
		const plan = reviewedPlan('plan-a', ['Zed.One', 'alpha.two', 'alpha.three']);
		assert.deepStrictEqual(editorMigrationPublishers(plan), ['alpha', 'zed']);

		const authorization = await issuer.create(plan, [' ZED ', 'alpha']);
		assert.deepStrictEqual(await issuer.consume(plan, authorization), {
			planningSchemaVersion: plan.schemaVersion,
			planFingerprint: 'plan-a',
			publishers: ['alpha', 'zed'],
			publisherSetFingerprint: authorization.publisherSetFingerprint,
			issuedAt: 1_000,
			consumedAt: 1_000,
		});
		await assert.rejects(() => issuer.consume(plan, authorization), /already been consumed/);

		const stale = await issuer.create(plan, ['alpha', 'zed']);
		await assert.rejects(() => issuer.consume(reviewedPlan('plan-b', ['zed.one', 'alpha.two']), stale), /does not match/);
		now += 10 * 60 * 1_000 + 1;
		await assert.rejects(() => issuer.consume(plan, stale), /expired/);
		await assert.rejects(() => issuer.create(plan, ['alpha']), /publisher set does not match/);
	});

	test('requires service authorization even when no extension publishers are selected', async () => {
		const issuer = new EditorMigrationApplyAuthorizationIssuer(() => 5, () => 'empty-nonce');
		const plan = reviewedPlan('empty', []);
		const authorization = await issuer.create(plan, []);
		assert.deepStrictEqual((await issuer.consume(plan, authorization)).publishers, []);
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

	test('derives durable aggregate outcomes and emits only telemetry-safe fields', () => {
		assert.strictEqual(EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION, 1);
		assert.strictEqual(deriveEditorMigrationAggregateOutcome(['completed', 'alreadyPresent']), 'completed');
		assert.strictEqual(deriveEditorMigrationAggregateOutcome(['completed', 'failed'], true), 'recoverable');
		assert.strictEqual(deriveEditorMigrationAggregateOutcome(['completed', 'unavailable']), 'completedWithIssues');

		const telemetry = toEditorMigrationTelemetry({
			operationSchemaVersion: 1,
			planningSchemaVersion: 2,
			aggregateOutcome: 'completedWithIssues',
			phase: 'settled',
			outcomes: ['completed', 'failed'],
			durationMs: 14_000,
		});
		assert.deepStrictEqual(telemetry, {
			operationSchemaVersion: 1,
			planningSchemaVersion: 2,
			aggregateOutcome: 'completedWithIssues',
			phase: 'settled',
			outcomeCounts: { completed: 1, failed: 1 },
			durationBucket: 'underMinute',
		});
		assert.doesNotMatch(JSON.stringify(telemetry), /extension|profile|path|fingerprint|operationId/i);
	});
});

function reviewedPlan(planFingerprint: string, extensionIds: readonly string[]): EditorMigrationReviewedPlan {
	return {
		schemaVersion: 2,
		source: {} as EditorMigrationReviewedPlan['source'],
		target: {} as EditorMigrationReviewedPlan['target'],
		evidence: { registryIgnoredSettings: [], normalizedKeys: {}, keybindingPlatform: '', gallery: [] },
		choices: { selectedCategories: extensionIds.length ? ['extensions'] : ['settings'], decisions: [] },
		operations: extensionIds.map((id, index) => ({
			id: `extensions:${id}`, category: 'extensions', kind: 'installExtension', item: id,
			source: { id, requestedChannel: 'stable', status: 'available', version: `${index + 1}.0.0`, targetPlatform: 'linux-x64', selectedChannel: 'stable', engine: '*', galleryIdentity: 'open-vsx' },
		})),
		exclusions: [], prerequisites: [], warnings: [],
		fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: planFingerprint },
	};
}
