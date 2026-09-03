/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationError } from '../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { IUserDataProfilesService } from '../../../platform/userDataProfile/common/userDataProfile.js';
import {
	EditorMigrationFlowSession,
	chooseAllEditorMigrationSettingDifferences,
	defaultEditorMigrationSourceProfile,
	groupEditorMigrationSources,
} from '../../browser/migration/editorMigrationFlow.js';
import { EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION, EditorMigrationApplyError, EditorMigrationApplyProgress, EditorMigrationOperation, EditorMigrationRollbackInspection, IEditorMigrationApplyService } from '../../common/migration/editorMigrationApply.js';
import { EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION, EditorMigrationPlanDraft, EditorMigrationReviewedPlan, EditorMigrationTargetSelection, EditorMigrationTargetSnapshot, IEditorMigrationPlanningService } from '../../common/migration/editorMigrationPlanning.js';
import { EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, EditorMigrationSourceDescriptor, EditorMigrationSourceProfileRef, EditorMigrationSourceSnapshot, IEditorMigrationSourceService } from '../../common/migration/editorMigrationSource.js';

suite('EditorMigrationFlow', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('groups applications first and preselects each application Default profile', () => {
		const cursorNamed = descriptor('cursor', 'Cursor', 'Work', 'named', 'cursor-work');
		const vscodeDefault = descriptor('vscode', 'Visual Studio Code', 'Default', 'default', 'vscode-default');
		const cursorDefault = descriptor('cursor', 'Cursor', 'Default', 'default', 'cursor-default');
		const groups = groupEditorMigrationSources([vscodeDefault, cursorDefault, cursorNamed]);

		assert.deepStrictEqual(groups.map(group => [group.id, group.profiles.map(profile => profile.profile.name)]), [
			['vscode', ['Default']],
			['cursor', ['Default', 'Work']],
		]);
		assert.strictEqual(defaultEditorMigrationSourceProfile(groups[1])?.ref.value, 'cursor-default');
		assert.strictEqual(defaultEditorMigrationSourceProfile({ ...groups[1], profiles: [cursorNamed] }), undefined);
	});

	test('deletes recovery data once for a rapid double acknowledgement', async () => {
		const acknowledged: string[] = [];
		const acknowledgement = new DeferredPromise<void>();
		const sourceDescriptor = descriptor('cursor', 'Cursor', 'Default', 'default', 'cursor-default');
		const draft = reviewDraft(snapshot(sourceDescriptor));
		const plan: EditorMigrationReviewedPlan = {
			...draft,
			choices: { selectedCategories: ['settings'], decisions: [] },
			operations: [],
			fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' },
		};
		const settled = { ...operation(plan), stage: 'settled' as const, aggregateOutcome: 'completed' as const };
		const applyService = {
			listRecoverableOperations: async () => [],
			getOperation: async () => settled,
			acknowledge: async (operationId: string) => {
				acknowledged.push(operationId);
				await acknowledgement.p;
			},
		} as unknown as IEditorMigrationApplyService;
		const session = disposables.add(new EditorMigrationFlowSession(
			{ discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources: [], diagnostics: [] }) } as unknown as IEditorMigrationSourceService,
			{} as IEditorMigrationPlanningService,
			applyService,
			{ defaultProfile: { id: 'default', name: 'Default', isDefault: true }, profiles: [] } as unknown as IUserDataProfilesService,
			{ writeText: async () => { } } as unknown as IClipboardService,
			new NullLogService(),
		));
		await session.showRecovery(settled.id);
		assert.strictEqual(session.state.phase, 'results');

		// Acknowledgement reaches the journal before it publishes anything, so a second press
		// inside that window is invisible to the webview host's phase and busy guard.
		const first = session.acknowledge();
		const second = session.acknowledge();
		assert.deepStrictEqual(acknowledged, [settled.id], 'recovery data must be deleted exactly once');

		acknowledgement.complete();
		await Promise.all([first, second]);
		assert.deepStrictEqual(acknowledged, [settled.id]);

		// The guard releases, so a later deliberate acknowledgement still works.
		await session.showRecovery(settled.id);
		await session.acknowledge();
		assert.deepStrictEqual(acknowledged, [settled.id, settled.id]);
	});

	test('binds rollback inspection completion to the latest requested category set', async () => {
		const sourceDescriptor = descriptor('cursor', 'Cursor', 'Default', 'default', 'cursor-default');
		const draft = reviewDraft(snapshot(sourceDescriptor));
		const plan: EditorMigrationReviewedPlan = {
			...draft,
			choices: { selectedCategories: ['settings', 'snippets'], decisions: [] },
			operations: [],
			fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' },
		};
		const recoveredOperation = { ...operation(plan), stage: 'settled' as const, aggregateOutcome: 'completed' as const };
		const inspections = [new DeferredPromise<EditorMigrationRollbackInspection>(), new DeferredPromise<EditorMigrationRollbackInspection>(), new DeferredPromise<EditorMigrationRollbackInspection>()];
		const requested: string[][] = [];
		const applyService = {
			listRecoverableOperations: async () => [{ id: recoveredOperation.id, stage: 'settled', aggregateOutcome: 'completed', createdAt: 1, updatedAt: 2, targetName: 'Default', recoverable: true }],
			getOperation: async () => recoveredOperation,
			inspectRollback: async (_operationId: string, categories: readonly string[]) => {
				requested.push([...categories]);
				return await inspections[requested.length - 1].p;
			},
		} as unknown as IEditorMigrationApplyService;
		const session = disposables.add(new EditorMigrationFlowSession(
			{} as IEditorMigrationSourceService,
			{} as IEditorMigrationPlanningService,
			applyService,
			{ defaultProfile: { id: 'hucode-default', name: 'Default', isDefault: true }, profiles: [] } as unknown as IUserDataProfilesService,
			{ writeText: async () => { } } as unknown as IClipboardService,
			new NullLogService(),
		));
		await session.initialize();
		await session.showRecovery(recoveredOperation.id);

		const settingsRequest = session.inspectRollback(['settings']);
		const snippetsRequest = session.inspectRollback(['snippets']);
		inspections[0].complete({ operationId: recoveredOperation.id, operationRevision: 1, eligibleCategories: ['settings', 'snippets'], driftedCategories: ['settings'], fingerprint: 'settings' });
		await settingsRequest;
		assert.strictEqual(session.state.rollbackInspection, undefined, 'an older category request must not overwrite the current request');
		inspections[1].complete({ operationId: recoveredOperation.id, operationRevision: 1, eligibleCategories: ['settings', 'snippets'], driftedCategories: ['snippets'], fingerprint: 'snippets' });
		await snippetsRequest;
		assert.strictEqual((session.state.rollbackInspection as EditorMigrationRollbackInspection | undefined)?.fingerprint, 'snippets');

		const changedSelectionRequest = session.inspectRollback(['settings', 'snippets']);
		session.clearRollbackInspection();
		inspections[2].complete({ operationId: recoveredOperation.id, operationRevision: 1, eligibleCategories: ['settings', 'snippets'], driftedCategories: [], fingerprint: 'both' });
		await changedSelectionRequest;
		assert.strictEqual(session.state.rollbackInspection, undefined, 'changing the category selection must invalidate pending evidence');
		assert.deepStrictEqual(requested, [['settings'], ['snippets'], ['settings', 'snippets']]);
	});

	test('moves through application, profile, Default target, and review without writing', async () => {
		const sourceDescriptor = descriptor('cursor', 'Cursor', 'Default', 'default', 'cursor-default');
		const namedSourceDescriptor = descriptor('cursor', 'Cursor', 'Work', 'named', 'cursor-work');
		const vscodeSourceDescriptor = descriptor('vscode', 'Visual Studio Code', 'Default', 'default', 'vscode-default');
		const sourceSnapshot = snapshot(sourceDescriptor);
		let discoveryReads = 0;
		let sourceReads = 0;
		let targetReads = 0;
		let draftReads = 0;
		let applyCalls = 0;
		const sourceService = {
			discoverSources: async () => { discoveryReads++; return { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: discoveryReads, sources: [sourceDescriptor, namedSourceDescriptor, vscodeSourceDescriptor], diagnostics: [] }; },
			readSourceProfile: async (ref: EditorMigrationSourceProfileRef) => {
				sourceReads++;
				return ref.value === sourceDescriptor.ref.value ? sourceSnapshot : snapshot(ref.value === namedSourceDescriptor.ref.value ? namedSourceDescriptor : vscodeSourceDescriptor);
			},
		} as unknown as IEditorMigrationSourceService;
		const draft = reviewDraft(sourceSnapshot);
		const planningService = {
			inspectTarget: async (selection: EditorMigrationTargetSelection) => { targetReads++; return { ...draft.target, selection }; },
			createDraftFromCurrentEvidence: async (source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot) => { draftReads++; return { ...draft, source, target }; },
			acceptDraft: async () => ({ ...draft, choices: { selectedCategories: ['settings'], decisions: [{ id: 'settings:editor.fontSize', choice: 'preserveTarget' }] }, operations: [], fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' } }),
			verifyPlan: async () => ({ status: 'unchanged', reasons: [] }),
		} as unknown as IEditorMigrationPlanningService;
		const applyService = {
			listRecoverableOperations: async () => [],
			createApplyAuthorization: async () => ({ nonce: 'nonce', publisherSetFingerprint: 'publishers' }),
			apply: async () => { applyCalls++; throw new Error('not expected'); },
		} as unknown as IEditorMigrationApplyService;
		const profilesService = {
			defaultProfile: { id: 'hucode-default', name: 'Default', isDefault: true },
			profiles: [
				{ id: 'hucode-default', name: 'Default', isDefault: true },
				{ id: 'named', name: 'Named', isDefault: false },
				{ id: 'internal', name: 'Internal', isInternal: true },
				{ id: 'transient', name: 'Transient', isTransient: true },
			],
		} as unknown as IUserDataProfilesService;
		const clipboard = { writeText: async () => { } } as unknown as IClipboardService;
		const session = disposables.add(new EditorMigrationFlowSession(sourceService, planningService, applyService, profilesService, clipboard, new NullLogService()));

		await session.initialize();
		assert.strictEqual(session.state.phase, 'application');
		session.selectApplication('cursor');
		assert.deepStrictEqual([session.state.phase, session.state.selectedSourceRef?.value], ['profile', 'cursor-default']);
		await session.continueFromProfile();
		assert.deepStrictEqual([session.state.phase, session.state.selectedTarget], ['target', { kind: 'existing', profileId: 'hucode-default' }]);
		assert.deepStrictEqual(session.state.targets.map(target => target.name), ['Default', 'Named']);
		await session.continueFromTarget();
		assert.strictEqual(session.state.phase, 'review');
		assert.strictEqual(session.state.decisions['settings:editor.fontSize'], 'preserveTarget');
		const originalDraft = session.state.draft;
		session.chooseDecision('settings:editor.fontSize', 'import');
		session.back();
		await session.continueFromTarget();
		assert.strictEqual(session.state.draft, originalDraft);
		assert.strictEqual(session.state.decisions['settings:editor.fontSize'], 'import');
		assert.deepStrictEqual({ targetReads, draftReads }, { targetReads: 1, draftReads: 1 });

		session.back();
		session.back();
		await session.continueFromProfile();
		assert.strictEqual(session.state.phase, 'target');
		assert.deepStrictEqual(session.state.selectedTarget, { kind: 'existing', profileId: 'hucode-default' });
		assert.strictEqual(sourceReads, 1);
		await session.continueFromTarget();
		assert.strictEqual(session.state.decisions['settings:editor.fontSize'], 'import');

		session.back();
		session.back();
		session.back();
		session.selectApplication('cursor');
		assert.strictEqual(session.state.selectedSourceRef?.value, 'cursor-default');
		assert.strictEqual(session.state.source, sourceSnapshot);
		await session.continueFromProfile();
		assert.strictEqual(sourceReads, 1);
		assert.deepStrictEqual({ discoveryReads, sourceReads, targetReads, draftReads, applyCalls }, { discoveryReads: 1, sourceReads: 1, targetReads: 1, draftReads: 1, applyCalls: 0 });
		session.selectTarget({ kind: 'existing', profileId: 'named' });
		assert.strictEqual(session.state.source, sourceSnapshot);
		assert.strictEqual(session.state.draft, undefined);
		assert.deepStrictEqual(session.state.decisions, {});
		await session.continueFromTarget();
		assert.deepStrictEqual({ sourceReads, targetReads, draftReads }, { sourceReads: 1, targetReads: 2, draftReads: 2 });
		session.back();
		session.back();
		session.selectSourceProfile(namedSourceDescriptor.ref);
		assert.strictEqual(session.state.source, undefined);
		assert.strictEqual(session.state.draft, undefined);
		assert.deepStrictEqual(session.state.selectedCategories, []);
		await session.continueFromProfile();
		assert.strictEqual(sourceReads, 2);
		session.back();
		session.back();
		session.selectApplication('vscode');
		assert.strictEqual(session.state.selectedSourceRef?.value, 'vscode-default');
		assert.strictEqual(session.state.source, undefined);
		assert.strictEqual(session.state.draft, undefined);
	});

	test('bulk setting choices include filtered-out differences and leave exclusions untouched', () => {
		const sourceDescriptor = descriptor('vscode', 'Visual Studio Code', 'Default', 'default', 'vscode-default');
		const draft = reviewDraft(snapshot(sourceDescriptor));
		const decisions = chooseAllEditorMigrationSettingDifferences(draft, {
			'settings:editor.fontSize': 'preserveTarget',
			'settings:editor.wordWrap': 'preserveTarget',
			'keybindings:test': 'preserveTarget',
		}, 'import');

		assert.deepStrictEqual(decisions, {
			'settings:editor.fontSize': 'import',
			'settings:editor.wordWrap': 'import',
			'keybindings:test': 'preserveTarget',
		});
		assert.deepStrictEqual(draft.exclusions, [{ category: 'settings', item: 'machine.secret', reason: 'machineSpecific' }]);
	});

	test('Back cancels an in-flight source read and ignores its stale completion', async () => {
		const sourceDescriptor = descriptor('cursor', 'Cursor', 'Default', 'default', 'cursor-default');
		const sourceRead = new DeferredPromise<EditorMigrationSourceSnapshot>();
		let readCanceled = false;
		const sourceService = {
			discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources: [sourceDescriptor], diagnostics: [] }),
			readSourceProfile: async (_ref: unknown, _categories: unknown, token: { readonly isCancellationRequested: boolean }) => {
				await sourceRead.p;
				readCanceled = token.isCancellationRequested;
				return snapshot(sourceDescriptor);
			},
		} as unknown as IEditorMigrationSourceService;
		const session = disposables.add(new EditorMigrationFlowSession(
			sourceService,
			{} as IEditorMigrationPlanningService,
			{ listRecoverableOperations: async () => [] } as unknown as IEditorMigrationApplyService,
			{ defaultProfile: { id: 'default', name: 'Default', isDefault: true }, profiles: [] } as unknown as IUserDataProfilesService,
			{ writeText: async () => { } } as unknown as IClipboardService,
			new NullLogService(),
		));

		await session.initialize();
		session.selectApplication('cursor');
		const continuePromise = session.continueFromProfile();
		session.back();
		sourceRead.complete(snapshot(sourceDescriptor));
		await continuePromise;

		assert.strictEqual(readCanceled, true);
		assert.strictEqual(session.state.phase, 'application');
		assert.strictEqual(session.state.source, undefined);
	});

	test('Back during an in-flight review build cancels it and leaves Review unentered', async () => {
		const sourceDescriptor = descriptor('cursor', 'Cursor', 'Default', 'default', 'cursor-default');
		const sourceSnapshot = snapshot(sourceDescriptor);
		const draftBuild = new DeferredPromise<void>();
		let buildCanceled: boolean | undefined;
		const sourceService = {
			discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources: [sourceDescriptor], diagnostics: [] }),
			readSourceProfile: async () => sourceSnapshot,
		} as unknown as IEditorMigrationSourceService;
		const planningService = {
			inspectTarget: async () => reviewDraft(sourceSnapshot).target,
			createDraftFromCurrentEvidence: async (_source: unknown, _target: unknown, token: { readonly isCancellationRequested: boolean }) => {
				await draftBuild.p;
				buildCanceled = token.isCancellationRequested;
				return reviewDraft(sourceSnapshot);
			},
		} as unknown as IEditorMigrationPlanningService;
		const session = disposables.add(new EditorMigrationFlowSession(
			sourceService,
			planningService,
			{ listRecoverableOperations: async () => [] } as unknown as IEditorMigrationApplyService,
			// The target list comes from `profiles`, not `defaultProfile`, so an empty list leaves
			// nothing for Target to preselect and Continue never reaches the review build.
			{ defaultProfile: { id: 'hucode-default', name: 'Default', isDefault: true }, profiles: [{ id: 'hucode-default', name: 'Default', isDefault: true }] } as unknown as IUserDataProfilesService,
			{ writeText: async () => { } } as unknown as IClipboardService,
			new NullLogService(),
		));

		await session.initialize();
		session.selectApplication('cursor');
		await session.continueFromProfile();
		assert.strictEqual(session.state.phase, 'target');
		assert.ok(session.state.selectedTarget, 'Target must preselect Default before Continue can build a review');

		const reviewPromise = session.continueFromTarget();
		assert.strictEqual(session.state.busy, true, 'the build publishes busy before its first await');

		// The presenter leaves Back enabled here on purpose: leaving the screen is how the user
		// abandons the build it started.
		session.back();
		assert.strictEqual(session.state.phase, 'profile');
		assert.strictEqual(session.state.busy, false);

		draftBuild.complete();
		await reviewPromise;

		assert.strictEqual(buildCanceled, true, 'Back must cancel the work it supersedes');
		assert.strictEqual(session.state.phase, 'profile', 'a superseded build must not drag the user into Review');
		assert.strictEqual(session.state.draft, undefined);
	});

	test('acknowledgement cannot delete a recovery record while rollback holds it', async () => {
		const acknowledged: string[] = [];
		const inspection = new DeferredPromise<EditorMigrationRollbackInspection>();
		const sourceDescriptor = descriptor('cursor', 'Cursor', 'Default', 'default', 'cursor-default');
		const draft = reviewDraft(snapshot(sourceDescriptor));
		const plan: EditorMigrationReviewedPlan = {
			...draft,
			choices: { selectedCategories: ['settings'], decisions: [] },
			operations: [],
			fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' },
		};
		const settled = {
			...operation(plan),
			stage: 'settled' as const,
			aggregateOutcome: 'completed' as const,
			snapshots: [{ category: 'settings', postApplyHash: 'hash' }],
		} as unknown as EditorMigrationOperation;
		const applyService = {
			listRecoverableOperations: async () => [],
			getOperation: async () => settled,
			inspectRollback: async () => await inspection.p,
			rollback: async () => { },
			acknowledge: async (operationId: string) => { acknowledged.push(operationId); },
		} as unknown as IEditorMigrationApplyService;
		const session = disposables.add(new EditorMigrationFlowSession(
			{ discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources: [], diagnostics: [] }) } as unknown as IEditorMigrationSourceService,
			{} as IEditorMigrationPlanningService,
			applyService,
			{ defaultProfile: { id: 'default', name: 'Default', isDefault: true }, profiles: [] } as unknown as IUserDataProfilesService,
			{ writeText: async () => { } } as unknown as IClipboardService,
			new NullLogService(),
		));
		await session.showRecovery(settled.id);

		// Rollback inspects the record before `runRecovery` publishes anything, so nothing about the
		// session's phase or busy flag reveals that it already owns this record.
		const rollbackPromise = session.rollback(['settings']);
		assert.strictEqual(session.state.phase, 'results');
		assert.strictEqual(session.state.busy, false);

		await session.acknowledge();
		assert.deepStrictEqual(acknowledged, [], 'the journal must not be deleted beneath an in-flight rollback');

		inspection.complete({ operationId: settled.id, operationRevision: 1, eligibleCategories: ['settings'], driftedCategories: [], fingerprint: 'fingerprint' });
		await rollbackPromise;

		// The lock is per recovery record and releases with the work, so acknowledgement is
		// available again once rollback has finished.
		await session.showRecovery(settled.id);
		await session.acknowledge();
		assert.deepStrictEqual(acknowledged, [settled.id]);
	});

	test('writer contention before admission returns to a review action', async () => {
		const sourceDescriptor = descriptor('cursor', 'Cursor', 'Default', 'default', 'cursor-default');
		const sourceSnapshot = snapshot(sourceDescriptor);
		const draft = reviewDraft(sourceSnapshot);
		const reviewedPlan = {
			...draft,
			choices: { selectedCategories: ['settings'] as const, decisions: [{ id: 'settings:editor.fontSize', choice: 'preserveTarget' as const }, { id: 'settings:editor.wordWrap', choice: 'preserveTarget' as const }] },
			operations: [],
			fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' },
		};
		const sourceService = {
			discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources: [sourceDescriptor], diagnostics: [] }),
			readSourceProfile: async () => sourceSnapshot,
		} as unknown as IEditorMigrationSourceService;
		const planningService = {
			inspectTarget: async () => draft.target,
			createDraftFromCurrentEvidence: async () => draft,
			acceptDraft: async () => reviewedPlan,
			verifyPlan: async () => ({ status: 'unchanged', reasons: [] }),
		} as unknown as IEditorMigrationPlanningService;
		const applyService = {
			listRecoverableOperations: async () => [],
			createApplyAuthorization: async () => ({ nonce: 'nonce', publisherSetFingerprint: 'publishers' }),
			apply: async () => { throw new EditorMigrationApplyError('writerContention', 'Another import is running'); },
		} as unknown as IEditorMigrationApplyService;
		const profilesService = {
			defaultProfile: { id: 'hucode-default', name: 'Default', isDefault: true },
			profiles: [{ id: 'hucode-default', name: 'Default', isDefault: true }],
		} as unknown as IUserDataProfilesService;
		const session = disposables.add(new EditorMigrationFlowSession(sourceService, planningService, applyService, profilesService, { writeText: async () => { } } as unknown as IClipboardService, new NullLogService()));

		await session.initialize();
		session.selectApplication('cursor');
		await session.continueFromProfile();
		await session.continueFromTarget();
		await session.acceptReview();

		assert.strictEqual(session.state.phase, 'review');
		assert.strictEqual(session.state.busy, false);
		assert.strictEqual(session.state.error, 'Another import is running');
	});

	test('an edit during plan verification invalidates the stale acceptance before Apply', async () => {
		const verification = new DeferredPromise<Awaited<ReturnType<IEditorMigrationPlanningService['verifyPlan']>>>();
		let applyCalls = 0;
		const scenario = await createReadyFlowScenario(async () => {
			applyCalls++;
			throw new Error('stale plan must not Apply');
		}, { verifyPlan: () => verification.p });
		const session = disposables.add(scenario.session);

		const acceptance = session.acceptReview();
		await Promise.resolve();
		await Promise.resolve();
		session.chooseDecision('settings:editor.fontSize', 'import');
		verification.complete({ status: 'unchanged', reasons: [] });
		await acceptance;

		assert.strictEqual(applyCalls, 0);
		assert.strictEqual(session.state.phase, 'review');
		assert.strictEqual(session.state.busy, false);
		assert.strictEqual(session.state.decisions['settings:editor.fontSize'], 'import');
		assert.strictEqual(session.state.reviewedPlan, undefined);
	});

	test('Back is inert in Apply and does not cancel an admitted operation', async () => {
		const completion = new DeferredPromise<ReturnType<typeof applyResult>>();
		const applyStarted = new DeferredPromise<void>();
		let token: { readonly isCancellationRequested: boolean } | undefined;
		const scenario = await createReadyFlowScenario(async (_plan, _authorization, applyToken, reporter) => {
			token = applyToken;
			applyStarted.complete();
			reporter?.({ operationId: 'operation-1', revision: 1, stage: 'admitted', target: { state: 'pending' }, selectedItemCount: 1, results: [], cancellationRequested: false });
			return await completion.p;
		});
		const session = disposables.add(scenario.session);
		const acceptance = session.acceptReview();
		await applyStarted.p;
		assert.strictEqual(session.state.phase, 'apply');
		session.back();
		assert.strictEqual(session.state.phase, 'apply');
		assert.strictEqual(token?.isCancellationRequested, false);
		completion.complete(applyResult());
		await acceptance;
		assert.strictEqual(session.state.phase, 'results');
	});

	test('moves a thrown post-admission Apply to durable Results and clears stale progress for another import', async () => {
		const scenario = await createReadyFlowScenario(async (_plan, _authorization, _token, reporter) => {
			reporter?.({ operationId: 'operation-1', revision: 1, stage: 'admitted', target: { state: 'pending' }, selectedItemCount: 1, results: [], cancellationRequested: false });
			throw new Error('Apply stopped after admission');
		});
		const session = disposables.add(scenario.session);

		await session.acceptReview();
		assert.strictEqual(session.state.phase, 'results');
		assert.strictEqual(session.state.operation?.id, 'operation-1');
		assert.strictEqual(session.state.error, 'Apply stopped after admission');
		assert.strictEqual(session.state.progress?.operationId, 'operation-1');

		await session.startImport();
		assert.strictEqual(session.state.phase, 'application');
		assert.strictEqual(session.state.progress, undefined);
	});

	test('retains a durable operation report that arrives after cancellation is requested', async () => {
		const completion = new DeferredPromise<ReturnType<typeof applyResult>>();
		const applyStarted = new DeferredPromise<void>();
		let report: ((progress: EditorMigrationApplyProgress) => void) | undefined;
		const scenario = await createReadyFlowScenario(async (_plan, _authorization, _token, reporter) => {
			report = reporter;
			applyStarted.complete();
			return await completion.p;
		});
		const session = disposables.add(scenario.session);
		const acceptance = session.acceptReview();
		await applyStarted.p;
		session.requestCancellation();
		report?.({ operationId: 'operation-1', revision: 1, stage: 'admitted', target: { state: 'pending' }, selectedItemCount: 1, results: [], cancellationRequested: true });
		completion.error(new CancellationError());
		await acceptance;
		assert.strictEqual(session.state.phase, 'results');
		assert.strictEqual(session.state.operation?.id, 'operation-1');
	});

	test('falls back to Recovery when a reported durable operation cannot be reopened', async () => {
		const scenario = await createReadyFlowScenario(async (_plan, _authorization, _token, reporter) => {
			reporter?.({ operationId: 'operation-1', revision: 1, stage: 'admitted', target: { state: 'pending' }, selectedItemCount: 1, results: [], cancellationRequested: false });
			throw new Error('Apply stopped after admission');
		}, { getOperationError: new Error('Journal temporarily unavailable') });
		const session = disposables.add(scenario.session);

		await session.acceptReview();
		assert.strictEqual(session.state.phase, 'recovery');
		assert.strictEqual(session.state.error, 'Apply stopped after admission');
	});

	test('returns pre-admission cancellation and empty authorization failures to usable review phases', async () => {
		const withoutPublishers = await createReadyFlowScenario(async () => { throw new CancellationError(); });
		const first = disposables.add(withoutPublishers.session);
		await first.acceptReview();
		assert.strictEqual(first.state.phase, 'review');
		assert.strictEqual(first.state.reviewedPlan?.fingerprints.plan, withoutPublishers.plan.fingerprints.plan);

		const withPublishers = await createReadyFlowScenario(async () => { throw new CancellationError(); }, { publishers: true });
		const second = disposables.add(withPublishers.session);
		await second.acceptReview();
		assert.strictEqual(second.state.phase, 'publishers');
		assert.deepStrictEqual(second.state.publishers, ['publisher']);

		const invalidEmpty = await createReadyFlowScenario(async () => { throw new EditorMigrationApplyError('invalidAuthorization', 'Authorization expired'); });
		const third = disposables.add(invalidEmpty.session);
		await third.acceptReview();
		assert.strictEqual(third.state.phase, 'review');
		assert.deepStrictEqual(third.state.publishers, []);
	});

	test('rebuilds current target evidence after Apply reports plan drift', async () => {
		const scenario = await createReadyFlowScenario(async () => { throw new EditorMigrationApplyError('planDrift', 'Target changed'); });
		const session = disposables.add(scenario.session);
		const staleDraft = session.state.draft;

		await session.acceptReview();
		assert.strictEqual(session.state.phase, 'review');
		assert.strictEqual(session.state.reviewNeedsRebuild, true);
		await session.rebuildReview();

		assert.strictEqual(session.state.reviewNeedsRebuild, false);
		assert.notStrictEqual(session.state.draft, staleDraft);
		assert.deepStrictEqual(scenario.planningCalls, { targets: 2, drafts: 2 });
	});

	test('rebuilds stale review evidence when returning through Target after plan drift', async () => {
		const scenario = await createReadyFlowScenario(async () => { throw new EditorMigrationApplyError('planDrift', 'Target changed'); });
		const session = disposables.add(scenario.session);
		const staleDraft = session.state.draft;

		await session.acceptReview();
		assert.strictEqual(session.state.reviewNeedsRebuild, true);
		assert.deepStrictEqual(scenario.planningCalls, { targets: 1, drafts: 1 });

		session.back();
		assert.strictEqual(session.state.phase, 'target');
		assert.strictEqual(session.state.reviewNeedsRebuild, true, 'Back must not silently clear the stale-evidence flag');
		await session.continueFromTarget();

		assert.strictEqual(session.state.phase, 'review');
		assert.strictEqual(session.state.reviewNeedsRebuild, false);
		assert.notStrictEqual(session.state.draft, staleDraft, 'continuing through Target must not reuse the stale draft');
		assert.deepStrictEqual(scenario.planningCalls, { targets: 2, drafts: 2 });
	});

	test('turns clipboard and acknowledgement failures into flow errors', async () => {
		const clipboard = { writeText: async () => { throw new Error('Clipboard unavailable'); } } as unknown as IClipboardService;
		const scenario = await createReadyFlowScenario(async (_plan, _authorization, _token, reporter) => {
			reporter?.({ operationId: 'operation-1', revision: 1, stage: 'admitted', target: { state: 'pending' }, selectedItemCount: 1, results: [], cancellationRequested: false });
			throw new Error('Apply stopped');
		}, { clipboard, acknowledgeError: new Error('Journal unavailable') });
		const session = disposables.add(scenario.session);
		await session.acceptReview();

		await session.copyReport();
		assert.strictEqual(session.state.error, 'Clipboard unavailable');
		await session.acknowledge();
		assert.strictEqual(session.state.error, 'Journal unavailable');
	});
});

function descriptor(adapterId: 'vscode' | 'cursor', productName: string, profileName: string, kind: 'default' | 'named', ref: string): EditorMigrationSourceDescriptor {
	return {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: ref },
		adapter: { id: adapterId, productName, channel: 'stable', order: adapterId === 'vscode' ? 0 : 2 },
		profile: { id: ref, name: profileName, kind },
		localPaths: { userData: `/private/${ref}`, extensions: `/private/${ref}/extensions` },
		categories: [{ category: 'settings', state: 'present', itemCount: 3 }], diagnostics: [],
		ranking: { completeness: 1, newestModificationTime: 1, stableChannelPreference: 1, adapterOrder: 0, normalizedProfileName: profileName.toLowerCase(), canonicalReference: ref },
		discoveryFingerprint: { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, algorithm: 'sha256', categories: ['settings'], entries: [], value: `fingerprint-${ref}` },
	};
}

function snapshot(source: EditorMigrationSourceDescriptor): EditorMigrationSourceSnapshot {
	return {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: source.ref, adapter: source.adapter, profile: source.profile,
		categories: [{ category: 'settings', state: 'present', value: { 'editor.fontSize': 16, 'editor.wordWrap': 'on', 'machine.secret': 'hidden' } }],
		diagnostics: [], fingerprint: source.discoveryFingerprint,
	};
}

function reviewDraft(source: EditorMigrationSourceSnapshot): EditorMigrationPlanDraft {
	const target: EditorMigrationTargetSnapshot = {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		selection: { kind: 'existing', profileId: 'hucode-default' },
		profile: { id: 'hucode-default', name: 'Default', kind: 'default' }, eligible: true,
		catalogFingerprint: 'catalog', requestedCategories: ['settings'],
		categories: [{ category: 'settings', ownership: 'target', ownerProfileId: 'hucode-default', state: 'present', contentHash: 'target-settings', value: { 'editor.fontSize': 14, 'editor.wordWrap': 'off' } }],
		environment: { targetPlatform: 'linux-x64', productVersion: '1.135.0', hucodeVersion: '0.0.78', galleryIdentity: 'open-vsx', policyVersion: 1 },
		builtIns: [], fingerprint: 'target',
	};
	return {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION, source, target,
		evidence: { registryIgnoredSettings: [], normalizedKeys: {}, keybindingPlatform: 'linux', gallery: [] },
		decisions: [
			{ id: 'settings:editor.fontSize', category: 'settings', item: 'editor.fontSize', kind: 'conflict', defaultChoice: 'preserveTarget', source: 16, target: 14 },
			{ id: 'settings:editor.wordWrap', category: 'settings', item: 'editor.wordWrap', kind: 'conflict', defaultChoice: 'preserveTarget', source: 'on', target: 'off' },
		],
		exclusions: [{ category: 'settings', item: 'machine.secret', reason: 'machineSpecific' }], prerequisites: [], warnings: [{ code: 'defaultProfileBacksOmni' }], draftFingerprintSeed: 'draft',
	};
}

async function createReadyFlowScenario(
	apply: IEditorMigrationApplyService['apply'],
	options: { readonly publishers?: boolean; readonly clipboard?: IClipboardService; readonly acknowledgeError?: Error; readonly getOperationError?: Error; readonly verifyPlan?: IEditorMigrationPlanningService['verifyPlan'] } = {},
): Promise<{ readonly session: EditorMigrationFlowSession; readonly draft: EditorMigrationPlanDraft; readonly plan: EditorMigrationReviewedPlan; readonly planningCalls: { targets: number; drafts: number } }> {
	const sourceDescriptor = descriptor('cursor', 'Cursor', 'Default', 'default', 'cursor-default');
	const sourceSnapshot = snapshot(sourceDescriptor);
	const baseDraft = reviewDraft(sourceSnapshot);
	const extensionOperation = {
		id: 'extensions:publisher.extension:1.0.0:linux-x64',
		category: 'extensions' as const,
		kind: 'installExtension' as const,
		item: 'publisher.extension',
		source: { id: 'publisher.extension', requestedChannel: 'stable' as const, status: 'available' as const, version: '1.0.0', targetPlatform: 'linux-x64', selectedChannel: 'stable' as const, engine: '*', galleryIdentity: 'open-vsx' },
	};
	const draft: EditorMigrationPlanDraft = options.publishers ? {
		...baseDraft,
		decisions: [...baseDraft.decisions, { id: extensionOperation.id, category: 'extensions', item: extensionOperation.item, kind: 'add', defaultChoice: 'import', source: extensionOperation.source }],
		target: { ...baseDraft.target, requestedCategories: ['settings', 'extensions'] },
	} : baseDraft;
	const plan: EditorMigrationReviewedPlan = {
		...draft,
		choices: {
			selectedCategories: options.publishers ? ['settings', 'extensions'] : ['settings'],
			decisions: draft.decisions.filter(decision => decision.kind === 'conflict').map(decision => ({ id: decision.id, choice: 'preserveTarget' as const })),
		},
		operations: options.publishers ? [extensionOperation] : [],
		fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' },
	};
	const planningCalls = { targets: 0, drafts: 0 };
	const sourceService = {
		discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources: [sourceDescriptor], diagnostics: [] }),
		readSourceProfile: async () => sourceSnapshot,
	} as unknown as IEditorMigrationSourceService;
	const planningService = {
		inspectTarget: async () => { planningCalls.targets++; return draft.target; },
		createDraftFromCurrentEvidence: async () => { planningCalls.drafts++; return { ...draft, draftFingerprintSeed: `draft-${planningCalls.drafts}` }; },
		acceptDraft: async (acceptedDraft: EditorMigrationPlanDraft) => ({ ...plan, source: acceptedDraft.source, target: acceptedDraft.target }),
		verifyPlan: options.verifyPlan ?? (async () => ({ status: 'unchanged', reasons: [] })),
	} as unknown as IEditorMigrationPlanningService;
	const applyService = {
		listRecoverableOperations: async () => [],
		createApplyAuthorization: async () => ({ nonce: 'nonce', publisherSetFingerprint: 'publishers' }),
		apply,
		getOperation: async () => { if (options.getOperationError) { throw options.getOperationError; } return operation(plan); },
		acknowledge: async () => { if (options.acknowledgeError) { throw options.acknowledgeError; } },
	} as unknown as IEditorMigrationApplyService;
	const session = new EditorMigrationFlowSession(
		sourceService,
		planningService,
		applyService,
		{ defaultProfile: { id: 'hucode-default', name: 'Default', isDefault: true }, profiles: [{ id: 'hucode-default', name: 'Default', isDefault: true }] } as unknown as IUserDataProfilesService,
		options.clipboard ?? ({ writeText: async () => { } } as unknown as IClipboardService),
		new NullLogService(),
	);
	await session.initialize();
	session.selectApplication('cursor');
	await session.continueFromProfile();
	await session.continueFromTarget();
	return { session, draft, plan, planningCalls };
}

function applyResult() {
	return { operationId: 'operation-1', aggregateOutcome: 'completed' as const, stage: 'settled' as const, results: [] };
}

function operation(plan: EditorMigrationReviewedPlan): EditorMigrationOperation {
	return {
		schemaVersion: EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION,
		id: 'operation-1', revision: 1, createdAt: 1, updatedAt: 2, plan,
		integrity: {} as EditorMigrationOperation['integrity'],
		authorization: {} as EditorMigrationOperation['authorization'],
		stage: 'admitted', cancellationRequested: false, target: { state: 'pending' }, snapshots: [], extensionInstallIntents: [], retryItemIds: [], rollbackDriftSnapshots: [], results: [], acknowledged: false,
	};
}
