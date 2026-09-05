/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EditorMigrationFlowState } from '../../browser/migration/editorMigrationFlow.js';
import { editorMigrationSetupPresentation } from '../../browser/migration/editorMigrationSetupPresentation.js';
import { EditorMigrationApplyProgress, EditorMigrationItemResult, EditorMigrationOperation } from '../../common/migration/editorMigrationApply.js';
import { createEditorMigrationPlanDraft } from '../../common/migration/editorMigrationPlanner.js';
import {
	EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
	EDITOR_MIGRATION_POLICY_VERSION,
	EditorMigrationDraftDecision,
	EditorMigrationDraftExclusion,
	EditorMigrationPlanDraft,
	EditorMigrationPlanWarning,
	EditorMigrationReviewedPlan,
} from '../../common/migration/editorMigrationPlanning.js';
import { EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, EditorMigrationSourceDescriptor, EditorMigrationSourceSnapshot } from '../../common/migration/editorMigrationSource.js';
import { isEditorMigrationSetupPresentation, type EditorMigrationSetupPanel, type EditorMigrationSetupPresentation } from '../../common/migration/editorMigrationSetupProtocol.js';

suite('EditorMigrationSetupPresentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('offers the application list before profiles and keeps discovery evidence in one disclosure', () => {
		const presentation = editorMigrationSetupPresentation(state({
			phase: 'application',
			applications: [{ id: 'cursor', productName: 'Cursor', channel: 'stable', profiles: [descriptor('Default', 'default', 'cursor-default')] }],
			discoveryDiagnostics: [{ code: 'permissionDeniedOrLocked', severity: 'warning', scope: 'candidate', adapterId: 'vscode', details: { path: '/private/vscode' } }],
		}), 3);

		const panel = panelOf(presentation, 'applications');
		assert.strictEqual(panel.applications.length, 1);
		assert.deepStrictEqual(panel.applications[0].intent, { type: 'selectApplication', applicationId: 'cursor' });
		assert.match(panel.applications[0].detail, /1 profile/);
		assert.ok(panel.diagnostics, 'discovery evidence belongs behind a labeled disclosure');
		assert.match(panel.diagnostics!.items[0], /permission/i);
		assert.strictEqual(presentation.sections.length, 0, 'discovery phases have no section rail');
		assert.strictEqual(presentation.revision, 3);
	});

	test('preselects the Default source profile and the Default target', () => {
		const cursorDefault = descriptor('Default', 'default', 'cursor-default');
		const profiles = editorMigrationSetupPresentation(state({
			phase: 'profile',
			selectedApplicationId: 'cursor',
			selectedSourceRef: { value: 'cursor-default' },
			applications: [{ id: 'cursor', productName: 'Cursor', channel: 'stable', profiles: [cursorDefault, descriptor('Work', 'named', 'cursor-work')] }],
		}), 1);
		const profilePanel = panelOf(profiles, 'profiles');
		assert.deepStrictEqual(profilePanel.profiles.map(profile => [profile.label, profile.checked]), [['Default', true], ['Work', false]]);
		assert.ok(profilePanel.details, 'the selected profile contributes its own details disclosure');

		const targets = editorMigrationSetupPresentation(state({
			phase: 'target',
			targets: [
				{ selection: { kind: 'existing', profileId: 'default' }, name: 'Default', kind: 'default' },
				{ selection: { kind: 'existing', profileId: 'work' }, name: 'Work', kind: 'named' },
			],
			selectedTarget: { kind: 'existing', profileId: 'default' },
		}), 1);
		const targetPanel = panelOf(targets, 'target');
		assert.deepStrictEqual(targetPanel.targets.map(target => target.checked), [true, false]);
		assert.match(targetPanel.targets[0].label, /Recommended/);
	});

	test('opens review on the first section needing attention and summarizes routine additions', () => {
		const draft = reviewDraft();
		const presentation = editorMigrationSetupPresentation(reviewState(draft), 1);

		assert.deepStrictEqual(presentation.sections.map(section => section.id), ['settings', 'keybindings', 'extensions', 'notImported']);
		assert.strictEqual(presentation.defaultSectionId, 'settings');
		assert.strictEqual(presentation.sections[0].status, 'attention');
		assert.match(presentation.sections[0].statusDescription, /Needs attention/);
		const importAction = presentation.footer.actions.find(action => action.intent.type === 'acceptReview');
		assert.strictEqual(importAction?.label, 'Import', 'review acceptance may immediately start the import');

		const settings = reviewPanel(presentation, 'settings');
		assert.strictEqual(settings.conflicts.length, 1);
		assert.strictEqual(settings.conflicts[0].currentValue, '13');
		assert.strictEqual(settings.conflicts[0].importedValue, '14');
		assert.match(settings.conflicts[0].valuesDescription, /Current value 13\. Imported value 14\./);
		assert.strictEqual(settings.bulkActions?.length, 2, 'both bulk setting actions sit beside the conflict summary');
		assert.ok(settings.additions, 'routine additions stay behind a disclosure');
		assert.match(settings.additions!.summary, /2 new settings/);
		assert.match(settings.ownership, /inherited from Default/);
	});

	test('accounts for matching settings separately from imports, conflicts, and exclusions', () => {
		const base = reviewDraft();
		const matching = Object.fromEntries(Array.from({ length: 214 }, (_, index) => [`editor.matching${index}`, index]));
		const excluded = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`cursor.setting${index}`, true]));
		const source = { ...matching, ...excluded, 'hucode.omni.workbenchItemLayout': 'compact', 'hucode.omni.worktreeItemLayout': 'compact' };
		const draft = createEditorMigrationPlanDraft(
			{ ...base.source, categories: [{ category: 'settings', state: 'present', value: source }] },
			{ ...base.target, requestedCategories: ['settings'], categories: [{ category: 'settings', ownership: 'target', state: 'present', value: { ...matching, ...excluded } }] },
			base.evidence,
		);
		for (const phase of ['review', 'publishers'] as const) {
			const result = editorMigrationSetupPresentation({ ...reviewState(draft, ['settings']), phase }, 1);
			const panel = reviewPanel(result, 'settings');
			assert.match(panel.lead, /^2 of 237 will be imported\./);
			assert.match(panel.lead, /214 settings already match\. No changes are needed for those settings\./);
			assert.match(panel.exclusionNote ?? '', /^21 Settings items are held back/);
		}
		assert.doesNotMatch(reviewPanel(editorMigrationSetupPresentation(reviewState(draft, []), 1), 'settings').lead, /already match/);

		const conflictDraft = createEditorMigrationPlanDraft(
			{ ...base.source, categories: [{ category: 'settings', state: 'present', value: { 'editor.fontSize': 14, 'editor.wordWrap': 'on' } }] },
			{ ...base.target, requestedCategories: ['settings'], categories: [{ category: 'settings', ownership: 'target', state: 'present', value: { 'editor.fontSize': 13, 'editor.wordWrap': 'on' } }] },
			base.evidence,
		);
		const kept = reviewPanel(editorMigrationSetupPresentation(reviewState(conflictDraft, ['settings']), 1), 'settings');
		assert.match(kept.lead, /^0 of 2 will be imported\. 1 differ/);
		assert.match(kept.lead, /1 setting already matches\. No changes are needed for that setting\./);
		const replaced = reviewPanel(editorMigrationSetupPresentation({ ...reviewState(conflictDraft, ['settings']), decisions: { 'settings:editor.fontSize': 'import' } }, 2), 'settings');
		assert.match(replaced.lead, /^1 of 2 will be imported\./);
		assert.match(replaced.lead, /1 setting already matches/);
	});

	test('explains an entirely matching settings import without listing every setting', () => {
		const base = reviewDraft();
		const matching = { 'editor.fontSize': 14, '[go]': { 'editor.tabSize': 4, 'editor.insertSpaces': false } };
		const draft = createEditorMigrationPlanDraft(
			{ ...base.source, categories: [{ category: 'settings', state: 'present', value: matching }] },
			{ ...base.target, requestedCategories: ['settings'], categories: [{ category: 'settings', ownership: 'target', state: 'present', value: { '[go]': { 'editor.insertSpaces': false, 'editor.tabSize': 4 }, 'editor.fontSize': 14 } }] },
			base.evidence,
		);
		const panel = reviewPanel(editorMigrationSetupPresentation(reviewState(draft, ['settings']), 1), 'settings');
		assert.strictEqual(panel.lead, '0 of 2 will be imported. 2 settings already match. No changes are needed for those settings.');
		assert.strictEqual(panel.additions, undefined);
		assert.deepStrictEqual(panel.conflicts, []);
	});

	test('shows complete formatted snippet contents rather than truncated internal records', () => {
		const current = { Benchmark: { prefix: 'bench', body: ['func Benchmark(b *testing.B) {', '\t// current implementation', '}'] }, CurrentOnly: { body: ['keep me'] } };
		const incoming = { Benchmark: { prefix: 'bench', body: ['func Benchmark(b *testing.B) {', `\t${'x'.repeat(180)}`, '}'] } };
		const base = reviewDraft();
		const draft: EditorMigrationPlanDraft = {
			...base,
			target: { ...base.target, requestedCategories: ['snippets'] },
			decisions: [{
				id: 'snippets:go.json:hash', item: 'go.json', category: 'snippets', kind: 'conflict', defaultChoice: 'preserveTarget',
				source: { name: 'go.json', contentHash: 'incoming-hash', contents: incoming },
				target: { name: 'go.json', contentHash: 'current-hash', contents: current }
			}],
		};
		for (const phase of ['review', 'publishers'] as const) {
			const result = editorMigrationSetupPresentation({ ...reviewState(draft, ['snippets']), phase }, 1);
			const [row] = reviewPanel(result, 'snippets').conflicts;
			assert.deepStrictEqual([row.currentValue, row.importedValue], [JSON.stringify(current, null, 2), JSON.stringify(incoming, null, 2)]);
			assert.deepStrictEqual([row.comparison?.currentLabel, row.comparison?.importedLabel], ['Current', 'Incoming']);
			assert.match(row.comparison?.note ?? '', /entire file.*only in Current will be removed/);
			if (phase === 'review') {
				assert.deepStrictEqual(row.choices?.map(choice => choice.label), ['Keep Current', 'Use Imported']);
				assert.ok(row.choices?.every(choice => !choice.description?.includes('current-hash')));
			}
			assert.ok(isEditorMigrationSetupPresentation(result), 'snippet comparisons must cross the validated protocol');
		}
	});

	test('states a deselected category as whole-category source items rather than its exclusions again', () => {
		const draft = reviewDraft();
		const presentation = editorMigrationSetupPresentation(reviewState(draft, ['settings', 'keybindings']), 1);

		const extensions = reviewPanel(presentation, 'extensions');
		assert.strictEqual(extensions.include?.checked, false);
		assert.match(extensions.lead, /Not included in this import/);
		assert.strictEqual(extensions.conflicts.length, 0);
		assert.ok(extensions.excludedText);

		const notImported = panelWithId(presentation, 'notImported');
		assert.strictEqual(notImported.kind, 'groups');
		const titles = notImported.kind === 'groups' ? notImported.groups.map(group => group.title) : [];
		assert.strictEqual(titles.filter(title => /Extensions is not included/.test(title)).length, 1);
		assert.strictEqual(titles.filter(title => /gallery/i.test(title)).length, 0, 'a deselected category must not also list its policy exclusions');
	});

	test('freezes review choices behind publisher confirmation while keeping the review rail', () => {
		const draft = reviewDraft();
		const presentation = editorMigrationSetupPresentation(state({
			...reviewState(draft),
			phase: 'publishers',
			publishers: ['publisher'],
			reviewedPlan: reviewedPlan(draft),
		}), 1);

		assert.deepStrictEqual(presentation.sections.map(section => section.id), ['settings', 'keybindings', 'extensions', 'notImported', 'publishers']);
		assert.strictEqual(presentation.sections.at(-1)?.separated, true);
		assert.strictEqual(presentation.defaultSectionId, 'publishers');

		const settings = reviewPanel(presentation, 'settings');
		assert.strictEqual(settings.include, undefined, 'publisher confirmation must not re-open category inclusion');
		assert.strictEqual(settings.bulkActions, undefined);
		assert.strictEqual(settings.conflicts[0].choices, undefined);
		assert.ok(settings.conflicts[0].chosenText);

		const publishers = panelWithId(presentation, 'publishers');
		assert.strictEqual(publishers.kind, 'groups');
		assert.match(presentation.footer.lines[0], /confirmation applies to this import only/);
	});

	test('leads Results with the aggregate outcome and collapses routine successes', () => {
		const presentation = editorMigrationSetupPresentation(state({ phase: 'results', operation: settledOperation() }), 1);

		assert.strictEqual(presentation.defaultSectionId, 'extensions', 'Results opens on the first category with a problem');
		const overview = panelWithId(presentation, 'overview');
		assert.strictEqual(overview.kind, 'resultsOverview');
		if (overview.kind === 'resultsOverview') {
			assert.match(overview.outcome, /completed with issues/i);
			assert.match(overview.lead, /need attention/);
		}
		const extensions = panelWithId(presentation, 'extensions');
		assert.strictEqual(extensions.kind, 'resultsCategory');
		if (extensions.kind === 'resultsCategory') {
			assert.strictEqual(extensions.problems.length, 1);
			assert.match(extensions.problems[0].detail ?? '', /installation failed/i);
			assert.ok(extensions.completed, 'routine successes stay collapsed');
		}
		const actionIds = presentation.footer.actions.map(action => action.id);
		assert.ok(actionIds.includes('results-retry'));
		assert.ok(actionIds.includes('results-copy'));
		assert.ok(actionIds.includes('results-acknowledge'));
		assert.deepStrictEqual(presentation.footer.actions.find(action => action.id === 'results-done')?.intent, { type: 'close' });
	});

	test('offers rollback only for proven file mutations and only forces the drifted categories', () => {
		const operation = settledOperation();
		const withSnapshots = { ...operation, snapshots: [{ category: 'settings', postApplyHash: 'hash' }] } as unknown as EditorMigrationOperation;
		const presentation = editorMigrationSetupPresentation(state({
			phase: 'results',
			operation: withSnapshots,
			rollbackInspection: { operationId: withSnapshots.id, operationRevision: 1, eligibleCategories: ['settings'], driftedCategories: ['settings'], fingerprint: 'x' },
		}), 1);

		const restore = panelWithId(presentation, 'restore');
		assert.strictEqual(restore.kind, 'restore');
		if (restore.kind === 'restore') {
			assert.deepStrictEqual(restore.selection?.options.map(option => option.category), ['settings']);
			assert.strictEqual(restore.inspection?.forced, true);
			assert.deepStrictEqual(restore.inspection?.driftedCategories, ['settings']);
		}

		const withoutMutation = editorMigrationSetupPresentation(state({ phase: 'results', operation }), 1);
		assert.strictEqual(withoutMutation.sections.some(section => section.id === 'restore'), false);
	});

	test('states what each profile offers so profiles can be compared without selecting them', () => {
		const rich = descriptor('Default', 'default', 'cursor-default', [
			{ category: 'settings', state: 'present', itemCount: 42 },
			{ category: 'keybindings', state: 'present', itemCount: 7 },
			{ category: 'extensions', state: 'present', itemCount: 18 },
		]);
		const sparse = descriptor('Work', 'named', 'cursor-work', [
			{ category: 'settings', state: 'present', itemCount: 3 },
			{ category: 'keybindings', state: 'absent', itemCount: 0 },
			{ category: 'extensions', state: 'unreadable', itemCount: 0 },
		]);
		const presentation = editorMigrationSetupPresentation(state({
			phase: 'profile',
			selectedApplicationId: 'cursor',
			applications: [{ id: 'cursor', productName: 'Cursor', channel: 'stable', profiles: [rich, sparse] }],
		}), 1);

		const panel = panelOf(presentation, 'profiles');
		assert.strictEqual(panel.profiles[0].description, 'Settings: 42 items · Keyboard Shortcuts: 7 items · Extensions: 18 items');
		assert.strictEqual(panel.profiles[1].description, 'Settings: 3 items · Keyboard Shortcuts: not found · Extensions: could not be read');
	});

	test('shows every selected category progress state and at most one current item', () => {
		const draft = reviewDraft();
		const plan = reviewedPlan(draft);
		const presentation = editorMigrationSetupPresentation(state({
			phase: 'apply',
			reviewedPlan: plan,
			progress: applyProgress({
				stage: 'applying',
				results: [
					{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 },
					{ id: 'keybindings:add-0', category: 'keybindings', outcome: 'failed', attempts: 1, diagnostic: { code: 'categoryWriteFailed', message: 'denied' } },
				],
			}),
		}), 1);

		const overview = panelWithId(presentation, 'overview');
		assert.strictEqual(overview.kind, 'applyOverview');
		assert.deepStrictEqual(presentation.steps.find(step => step.current), { id: 'apply', label: 'Import', current: true });
		assert.strictEqual(presentation.railTitle, 'Import');
		if (overview.kind !== 'applyOverview') {
			return;
		}
		assert.deepStrictEqual(overview.rows.map(row => row.id), ['settings', 'keybindings', 'extensions']);
		assert.match(overview.rows[0].state, /Complete\. 1 recorded\./);
		assert.match(overview.rows[1].state, /1 recorded, 1 need attention\./);
		assert.match(overview.rows[2].state, /Waiting\./);
		// Settings is complete and keybindings has not reported its own category result yet, so the
		// one named item is the first still-outstanding category.
		assert.strictEqual(overview.currentItem, 'Working on Keyboard Shortcuts.');
	});

	test('names only a durable extension intent while extensions are still resolving', () => {
		const draft = reviewDraft();
		const plan = reviewedPlan(draft);
		const resolving = editorMigrationSetupPresentation(state({
			phase: 'apply',
			reviewedPlan: plan,
			progress: applyProgress({
				stage: 'applying',
				results: [
					{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 },
					{ id: 'keybindings', category: 'keybindings', outcome: 'completed', attempts: 1 },
				],
			}),
		}), 1);
		const resolvingOverview = panelWithId(resolving, 'overview');
		assert.strictEqual(resolvingOverview.kind === 'applyOverview' && resolvingOverview.currentItem, 'Working on Resolving extensions.');

		const installing = editorMigrationSetupPresentation(state({
			phase: 'apply',
			reviewedPlan: plan,
			progress: applyProgress({
				stage: 'applying',
				results: [
					{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 },
					{ id: 'keybindings', category: 'keybindings', outcome: 'completed', attempts: 1 },
				],
				extensionInstallIntents: [{ operationId: 'extensions:publisher.extension-0', applicationScoped: false }],
			}),
		}), 1);
		const installingOverview = panelWithId(installing, 'overview');
		assert.strictEqual(installingOverview.kind === 'applyOverview' && installingOverview.currentItem, 'Working on publisher.extension-0.');
	});

	test('reports durable rollback resource progress instead of forward Apply counts', () => {
		const plan = reviewedPlan(reviewDraft());
		const presentation = editorMigrationSetupPresentation(state({
			phase: 'apply',
			reviewedPlan: plan,
			progress: applyProgress({
				stage: 'rollbackPending',
				results: [{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 }],
				rollback: { categories: ['settings', 'snippets'], restoredResourceCount: 2, resourceCount: 5, mutationStarted: true },
			}),
		}), 1);

		const overview = panelWithId(presentation, 'overview');
		assert.strictEqual(overview.kind, 'applyOverview');
		if (overview.kind !== 'applyOverview') {
			return;
		}
		assert.match(overview.progress.text, /Restoring Settings, Snippets\. 2 of 5 file resources restored\./);
		assert.strictEqual(overview.progress.now, 2);
		assert.strictEqual(overview.progress.max, 5);
		assert.deepStrictEqual(overview.rows, [], 'a rollback replaces the forward per-category rows');
		assert.strictEqual(overview.currentItem, undefined);
	});

	test('summarizes a category that is still in progress against its planned operations', () => {
		const draft = reviewDraft();
		const plan = reviewedPlan(draft);
		const presentation = editorMigrationSetupPresentation(state({
			phase: 'apply',
			reviewedPlan: plan,
			progress: applyProgress({
				stage: 'applying',
				results: [{ id: 'extensions:publisher.extension-0', category: 'extensions', outcome: 'completed', attempts: 1 }],
			}),
		}), 1);

		const category = panelWithId(presentation, 'extensions');
		assert.strictEqual(category.kind, 'applyCategory');
		if (category.kind === 'applyCategory') {
			assert.match(category.lead, /In progress\. 1 of 1 recorded\./);
			assert.match(category.recordedNote ?? '', /1 items recorded so far\./);
		}
	});

	test('emits snapshots the wire validator accepts, for every phase and panel kind', () => {
		const draft = reviewDraft();
		const operation = settledOperation();
		const withSnapshots = { ...operation, snapshots: [{ category: 'settings', postApplyHash: 'hash' }] } as unknown as EditorMigrationOperation;
		const cursor = descriptor('Default', 'default', 'cursor-default');
		const states: readonly [string, EditorMigrationFlowState][] = [
			['loading', state({ phase: 'loading' })],
			['recovery', state({ phase: 'recovery', recoveries: [{ id: 'r', stage: 'settled', createdAt: 1, updatedAt: 2, targetName: 'Default', recoverable: true }, { id: 'r2', stage: 'settled', createdAt: 1, updatedAt: 2, recoverable: false, unsupportedSchemaVersion: 99 }] })],
			['application', state({ phase: 'application', applications: [{ id: 'cursor', productName: 'Cursor', channel: 'stable', profiles: [cursor] }], discoveryDiagnostics: [{ code: 'permissionDeniedOrLocked', severity: 'warning', scope: 'candidate', adapterId: 'vscode', details: { path: '/p' } }] })],
			['profile', state({ phase: 'profile', selectedApplicationId: 'cursor', selectedSourceRef: { value: 'cursor-default' }, applications: [{ id: 'cursor', productName: 'Cursor', channel: 'stable', profiles: [cursor] }] })],
			['target', state({ phase: 'target', targets: [{ selection: { kind: 'existing', profileId: 'default' }, name: 'Default', kind: 'default' }], selectedTarget: { kind: 'proposed', name: 'Imported' } })],
			['review', reviewState(draft)],
			['publishers', state({ ...reviewState(draft), phase: 'publishers', publishers: ['publisher'], reviewedPlan: reviewedPlan(draft) })],
			['apply', state({ phase: 'apply', reviewedPlan: reviewedPlan(draft), progress: applyProgress({ stage: 'applying', results: [{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 }] }) })],
			['results', state({ phase: 'results', operation })],
			['restore', state({ phase: 'results', operation: withSnapshots, rollbackInspection: { operationId: withSnapshots.id, operationRevision: 1, eligibleCategories: ['settings'], driftedCategories: ['settings'], fingerprint: 'x' } })],
		];

		const kinds = new Set<string>();
		for (const [name, value] of states) {
			const presentation = editorMigrationSetupPresentation(value, 1);
			assert.strictEqual(isEditorMigrationSetupPresentation(presentation), true, `${name} must survive its own wire validation`);
			// The snapshot has to survive the JSON round trip the webview boundary performs.
			assert.strictEqual(isEditorMigrationSetupPresentation(JSON.parse(JSON.stringify(presentation))), true, `${name} after serialization`);
			presentation.panels.forEach(panel => kinds.add(panel.kind));
		}
		assert.deepStrictEqual([...kinds].sort(), [
			'applications', 'applyCategory', 'applyOverview', 'groups', 'loading', 'profiles',
			'recovery', 'restore', 'resultsCategory', 'resultsOverview', 'reviewCategory', 'target',
		], 'every panel kind the presenter can emit is covered');
	});

	test('changes the scope key only when the import, draft, or operation changes', () => {
		const draft = reviewDraft();
		const first = editorMigrationSetupPresentation(reviewState(draft), 1).scopeKey;
		assert.strictEqual(editorMigrationSetupPresentation(reviewState(draft, ['settings']), 2).scopeKey, first, 'a category choice keeps local filters');
		const otherDraft = { ...draft, draftFingerprintSeed: 'other' };
		assert.notStrictEqual(editorMigrationSetupPresentation(reviewState(otherDraft), 3).scopeKey, first);
		assert.notStrictEqual(editorMigrationSetupPresentation(state({ phase: 'application' }), 4).scopeKey, first);
	});
});

// #region fixtures

function panelOf<K extends EditorMigrationSetupPanel['kind']>(presentation: EditorMigrationSetupPresentation, kind: K): Extract<EditorMigrationSetupPanel, { kind: K }> {
	const panel = presentation.panels.find(candidate => candidate.kind === kind);
	assert.ok(panel, `expected a ${kind} panel`);
	return panel as Extract<EditorMigrationSetupPanel, { kind: K }>;
}

function panelWithId(presentation: EditorMigrationSetupPresentation, id: string): EditorMigrationSetupPanel {
	const panel = presentation.panels.find(candidate => candidate.id === id);
	assert.ok(panel, `expected a panel for section ${id}`);
	return panel;
}

function reviewPanel(presentation: EditorMigrationSetupPresentation, id: string): Extract<EditorMigrationSetupPanel, { kind: 'reviewCategory' }> {
	const panel = panelWithId(presentation, id);
	assert.strictEqual(panel.kind, 'reviewCategory');
	return panel as Extract<EditorMigrationSetupPanel, { kind: 'reviewCategory' }>;
}

function state(overrides: Partial<EditorMigrationFlowState>): EditorMigrationFlowState {
	return {
		phase: 'loading',
		busy: false,
		canceling: false,
		recoveries: [],
		applications: [],
		discoveryDiagnostics: [],
		targets: [],
		selectedCategories: [],
		decisions: {},
		publishers: [],
		reviewNeedsRebuild: false,
		...overrides,
	};
}

function reviewState(draft: EditorMigrationPlanDraft, selectedCategories: readonly ('settings' | 'keybindings' | 'snippets' | 'extensions')[] = ['settings', 'keybindings', 'extensions']): EditorMigrationFlowState {
	return state({ phase: 'review', draft, selectedCategories, decisions: {} });
}

function reviewDraft(): EditorMigrationPlanDraft {
	const decisions: EditorMigrationDraftDecision[] = [
		{ id: 'settings:editor.fontSize', category: 'settings', item: 'editor.fontSize', kind: 'conflict', defaultChoice: 'preserveTarget', source: 14, target: 13 },
		{ id: 'settings:add-0', category: 'settings', item: 'editor.wordWrap', kind: 'add', defaultChoice: 'import', source: 'on' },
		{ id: 'settings:add-1', category: 'settings', item: 'editor.minimap.enabled', kind: 'add', defaultChoice: 'import', source: false },
		{ id: 'keybindings:add-0', category: 'keybindings', item: 'ctrl+k 0', kind: 'add', defaultChoice: 'import', source: { key: 'ctrl+k 0', command: 'command.0' } },
		{ id: 'extensions:publisher.extension-0', category: 'extensions', item: 'publisher.extension-0', kind: 'add', defaultChoice: 'import', source: { id: 'publisher.extension-0', requestedChannel: 'stable', status: 'available', version: '1.0.0', targetPlatform: 'linux-x64', selectedChannel: 'stable', engine: '*', galleryIdentity: 'open-vsx' } },
	];
	const exclusions: EditorMigrationDraftExclusion[] = [
		{ category: 'settings', item: 'machine.secret', reason: 'machineSpecific' },
		{ category: 'extensions', item: 'publisher.missing', reason: 'galleryUnavailable' },
	];
	const warnings: EditorMigrationPlanWarning[] = [{ code: 'defaultProfileBacksOmni' }, { code: 'unknownSettingSchema', item: 'editor.custom' }];
	const source: EditorMigrationSourceSnapshot = {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: 'cursor-default' },
		adapter: { id: 'cursor', productName: 'Cursor', channel: 'stable', order: 2 },
		profile: { id: 'cursor-default', name: 'Default', kind: 'default' },
		categories: [
			{ category: 'settings', state: 'present', value: { 'editor.fontSize': 14, 'editor.wordWrap': 'on', 'editor.minimap.enabled': false, 'machine.secret': 1 } },
			{ category: 'keybindings', state: 'present', value: [{ key: 'ctrl+k 0', command: 'command.0' }] },
			{ category: 'extensions', state: 'present', value: [{ id: 'publisher.extension-0', version: '1.0.0' }, { id: 'publisher.missing', version: '1.0.0' }] },
		],
		diagnostics: [],
		fingerprint: { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, algorithm: 'sha256', categories: ['settings'], entries: [], value: 'fingerprint' },
	};
	return {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		source,
		target: {
			schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
			selection: { kind: 'existing', profileId: 'work' },
			profile: { id: 'work', name: 'Work', kind: 'named' },
			eligible: true,
			catalogFingerprint: 'catalog',
			requestedCategories: ['settings', 'keybindings', 'extensions'],
			categories: [
				{ category: 'settings', ownership: 'default', ownerProfileId: 'default', state: 'present', value: { 'editor.fontSize': 13 } },
				{ category: 'keybindings', ownership: 'target', ownerProfileId: 'work', state: 'present', value: [] },
				{ category: 'extensions', ownership: 'target', ownerProfileId: 'work', state: 'present', value: [] },
			],
			environment: { targetPlatform: 'linux-x64', productVersion: '1.135.0', hucodeVersion: '0.0.78', galleryIdentity: 'open-vsx', policyVersion: EDITOR_MIGRATION_POLICY_VERSION },
			builtIns: [],
			fingerprint: 'target',
		},
		evidence: { registryIgnoredSettings: [], normalizedKeys: {}, keybindingPlatform: 'linux', gallery: [] },
		decisions,
		exclusions,
		prerequisites: [{ kind: 'materializeInheritedResource', category: 'settings', ownerProfileId: 'default', baselineFingerprint: 'baseline' }],
		warnings,
		draftFingerprintSeed: 'draft',
	};
}

function reviewedPlan(draft: EditorMigrationPlanDraft): EditorMigrationReviewedPlan {
	return {
		...draft,
		choices: {
			selectedCategories: ['settings', 'keybindings', 'extensions'],
			decisions: draft.decisions.filter(decision => decision.kind === 'conflict').map(decision => ({ id: decision.id, choice: 'preserveTarget' as const })),
		},
		operations: draft.decisions
			.filter(decision => decision.category === 'extensions')
			.map(decision => ({
				id: decision.id,
				category: 'extensions' as const,
				kind: 'installExtension' as const,
				item: decision.item,
				source: decision.source as Extract<EditorMigrationReviewedPlan['operations'][number], { readonly kind: 'installExtension' }>['source'],
			})),
		fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' },
	};
}

function settledOperation(): EditorMigrationOperation {
	const plan = reviewedPlan(reviewDraft());
	const results: EditorMigrationItemResult[] = [
		{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 },
		{ id: 'keybindings', category: 'keybindings', outcome: 'completed', attempts: 1 },
		{ id: 'extensions:publisher.extension-0', category: 'extensions', outcome: 'failed', attempts: 2, diagnostic: { code: 'extensionInstallFailed', message: 'install failed' } },
		{ id: 'extensions', category: 'extensions', outcome: 'completed', attempts: 1 },
	];
	return {
		id: 'operation',
		stage: 'settled',
		aggregateOutcome: 'completedWithIssues',
		plan,
		results,
		snapshots: [],
		extensionInstallIntents: plan.operations.map(operation => ({ operationId: operation.id, applicationScoped: false })),
	} as unknown as EditorMigrationOperation;
}

function applyProgress(overrides: Partial<EditorMigrationApplyProgress>): EditorMigrationApplyProgress {
	return {
		operationId: 'operation',
		revision: 1,
		stage: 'applying',
		target: { profileId: 'work', name: 'Work' },
		selectedItemCount: 10,
		results: [],
		cancellationRequested: false,
		...overrides,
	} as unknown as EditorMigrationApplyProgress;
}

function descriptor(
	name: string,
	kind: 'default' | 'named',
	ref: string,
	categories: EditorMigrationSourceDescriptor['categories'] = [{ category: 'settings', state: 'present', itemCount: 1 }],
): EditorMigrationSourceDescriptor {
	return {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: ref },
		adapter: { id: 'cursor', productName: 'Cursor', channel: 'stable', order: 2 },
		profile: { id: ref, name, kind },
		localPaths: { userData: `/private/${ref}`, extensions: `/private/${ref}/extensions` },
		categories,
		diagnostics: [],
		ranking: { completeness: 1, newestModificationTime: 1, stableChannelPreference: 1, adapterOrder: 2, normalizedProfileName: name.toLowerCase(), canonicalReference: ref },
		discoveryFingerprint: { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, algorithm: 'sha256', categories: ['settings'], entries: [], value: `fingerprint-${ref}` },
	};
}

// #endregion
