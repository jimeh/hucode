/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { Event } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { IUserDataProfilesService } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { EditorMigrationFlowSession, EditorMigrationFlowState } from '../../browser/migration/editorMigrationFlow.js';
import { EditorMigrationFlowView } from '../../browser/migration/editorMigrationFlowView.js';
import { EditorMigrationApplyProgress, EditorMigrationItemResult, EditorMigrationOperation, IEditorMigrationApplyService } from '../../common/migration/editorMigrationApply.js';
import { EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION, EditorMigrationPlanDraft, EditorMigrationReviewedPlan, EditorMigrationTargetSelection, EditorMigrationTargetSnapshot, IEditorMigrationPlanningService } from '../../common/migration/editorMigrationPlanning.js';
import { EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, EditorMigrationSourceDescriptor, EditorMigrationSourceSnapshot, IEditorMigrationSourceService } from '../../common/migration/editorMigrationSource.js';

suite('EditorMigrationFlowView', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('virtualizes hundreds of profiles and preserves keyboard filter focus', async () => {
		const sources = [source('Default', 'default', 'default')];
		for (let index = 0; index < 300; index++) {
			sources.push(source(`Profile ${index}`, 'named', `profile-${index}`));
		}
		const session = disposables.add(new EditorMigrationFlowSession(
			{
				discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources, diagnostics: [] }),
			} as unknown as IEditorMigrationSourceService,
			{} as IEditorMigrationPlanningService,
			{ listRecoverableOperations: async () => [] } as unknown as IEditorMigrationApplyService,
			{ defaultProfile: { id: 'default', name: 'Default', isDefault: true }, profiles: [] } as unknown as IUserDataProfilesService,
			{ writeText: async () => { } } as unknown as IClipboardService,
			new NullLogService(),
		));
		await session.initialize();
		session.selectApplication('cursor');

		const parent = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(parent);
		disposables.add({ dispose: () => parent.remove() });
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));

		const radios = [...parent.getElementsByTagName('input')].filter(input => input.type === 'radio');
		assert.ok(radios.length < sources.length, 'only the visible profile window should be in the DOM');
		assert.strictEqual(radios[0].checked, true);
		assert.match(radios[0].labels?.[0]?.textContent ?? '', /Default/);
		const fullList = parent.querySelector('[data-migration-list-id="profiles"] .monaco-list') as HTMLElement;
		assert.ok(fullList);
		fullList.focus();
		(parent.querySelector('[data-migration-list-id="profiles"]') as HTMLElement).dispatchEvent(keyboardEvent('End'));
		assert.match(parent.textContent ?? '', /Profile 299/, 'End should focus an off-screen profile and scroll it into view');
		session.selectSourceProfile(sources[1].ref);
		assert.match(parent.textContent ?? '', /Profile 299/, 'the off-screen focused window remains rendered after the update');

		const filter = [...parent.getElementsByTagName('input')].find(input => input.type === 'search');
		assert.ok(filter);
		filter.focus();
		filter.value = 'Profile 299';
		filter.setSelectionRange(7, 7);
		filter.dispatchEvent(domEvent('input'));

		const filteredInput = [...parent.getElementsByTagName('input')].find(input => input.type === 'search');
		const filteredRadios = [...parent.getElementsByTagName('input')].filter(input => input.type === 'radio');
		assert.strictEqual(mainWindow.document.activeElement, filteredInput);
		assert.deepStrictEqual([filteredInput?.selectionStart, filteredInput?.selectionEnd], [7, 7]);
		assert.strictEqual(filteredRadios.length, 1);
		assert.match(filteredRadios[0].labels?.[0]?.textContent ?? '', /Profile 299/);
		const profileList = parent.querySelector('[data-migration-list-id="profiles"] .monaco-list') as HTMLElement;
		assert.ok(profileList);
		profileList.focus();
		profileList.dispatchEvent(keyboardEvent('ArrowDown'));
		profileList.dispatchEvent(keyboardEvent('Enter'));
		assert.strictEqual(session.state.selectedSourceRef?.value, 'profile-299');

		const composing = inputWithLabel(parent, 'Filter profiles');
		composing.dispatchEvent(domEvent('compositionstart'));
		composing.value = 'Profile 2';
		composing.dispatchEvent(domEvent('input'));
		assert.strictEqual(inputWithLabel(parent, 'Filter profiles'), composing, 'IME input must not rebuild the active control');
		composing.dispatchEvent(domEvent('compositionend'));
		assert.notStrictEqual(inputWithLabel(parent, 'Filter profiles'), composing, 'composition completion applies the filter once');
		assert.strictEqual(parent.firstElementChild?.getAttribute('role'), 'region');
		assert.strictEqual(parent.firstElementChild?.getAttribute('aria-label'), 'Editor Setup Import');
	});

	test('virtualizes hundreds of applications with stable application identities', async () => {
		const sources = Array.from({ length: 300 }, (_, index) => ({
			...source('Default', 'default', `application-${index}-default`),
			adapter: { id: `application-${index}`, productName: `Application ${index}`, channel: 'stable' as const, order: index },
		}));
		const session = disposables.add(new EditorMigrationFlowSession(
			{ discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources, diagnostics: [] }) } as unknown as IEditorMigrationSourceService,
			{} as IEditorMigrationPlanningService,
			{ listRecoverableOperations: async () => [] } as unknown as IEditorMigrationApplyService,
			{ defaultProfile: { id: 'default', name: 'Default', isDefault: true }, profiles: [] } as unknown as IUserDataProfilesService,
			{ writeText: async () => { } } as unknown as IClipboardService,
			new NullLogService(),
		));
		await session.initialize();
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));

		const applicationButtons = [...parent.getElementsByClassName('hucode-editor-migration-choice-card')];
		assert.ok(applicationButtons.length < sources.length, 'only the visible application window should be in the DOM');
		const filter = inputWithLabel(parent, 'Filter applications');
		filter.focus();
		filter.value = 'Application 299';
		filter.dispatchEvent(domEvent('input'));
		const filteredButtons = [...parent.getElementsByClassName('hucode-editor-migration-choice-card')];
		assert.strictEqual(filteredButtons.length, 1);
		assert.strictEqual(mainWindow.document.activeElement, inputWithLabel(parent, 'Filter applications'));
		const list = parent.querySelector('[data-migration-list-id="applications"] .monaco-list') as HTMLElement;
		assert.ok(list);
		list.focus();
		list.dispatchEvent(keyboardEvent('ArrowDown'));
		list.dispatchEvent(keyboardEvent('Enter'));
		assert.strictEqual(session.state.selectedApplicationId, 'application-299');
	});

	test('keeps application and profile filters independent across navigation', async () => {
		const sources = [
			source('Default', 'default', 'cursor-default'),
			source('Work', 'named', 'cursor-work'),
			{ ...source('Default', 'default', 'vscode-default'), adapter: { id: 'vscode', productName: 'Visual Studio Code', channel: 'stable' as const, order: 0 } },
		];
		const session = disposables.add(new EditorMigrationFlowSession(
			{ discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources, diagnostics: [] }) } as unknown as IEditorMigrationSourceService,
			{} as IEditorMigrationPlanningService,
			{ listRecoverableOperations: async () => [] } as unknown as IEditorMigrationApplyService,
			{ defaultProfile: { id: 'default', name: 'Default', isDefault: true }, profiles: [] } as unknown as IUserDataProfilesService,
			{ writeText: async () => { } } as unknown as IClipboardService,
			new NullLogService(),
		));
		await session.initialize();
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));

		const applicationFilter = inputWithLabel(parent, 'Filter applications');
		applicationFilter.value = 'Cursor';
		applicationFilter.dispatchEvent(domEvent('input'));
		const cursor = [...parent.getElementsByTagName('button')].find(button => button.textContent?.includes('Cursor'));
		assert.ok(cursor);
		cursor.dispatchEvent(domEvent('click'));

		const profileFilter = inputWithLabel(parent, 'Filter profiles');
		assert.strictEqual(profileFilter.value, '');
		assert.match(parent.textContent ?? '', /Default/);
		assert.match(parent.textContent ?? '', /Work/);
		const back = [...parent.getElementsByTagName('button')].find(button => button.textContent === 'Back');
		assert.ok(back);
		back.dispatchEvent(domEvent('click'));
		assert.strictEqual(inputWithLabel(parent, 'Filter applications').value, 'Cursor');
	});

	test('opens a virtualized recovery choice with Enter', () => {
		let opened: string | undefined;
		const state = presentationState({
			phase: 'recovery',
			recoveries: [{ id: 'recovery-1', stage: 'settled', aggregateOutcome: 'completedWithIssues', createdAt: 1, updatedAt: 2, targetName: 'Default', recoverable: true }],
		});
		const session = {
			state,
			onDidChangeState: Event.None,
			showRecovery: async (id: string) => { opened = id; },
		} as unknown as EditorMigrationFlowSession;
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));
		const list = parent.querySelector('[data-migration-list-id="recoveries"] .monaco-list') as HTMLElement;
		assert.ok(list);
		list.focus();
		list.dispatchEvent(keyboardEvent('ArrowDown'));
		list.dispatchEvent(keyboardEvent('Enter'));
		assert.strictEqual(opened, 'recovery-1');
	});

	test('renders the complete review and virtualizes independently filtered extensions', async () => {
		const descriptor = richSource();
		const sourceSnapshot = richSnapshot(descriptor);
		const draft = richDraft(sourceSnapshot);
		const session = disposables.add(new EditorMigrationFlowSession(
			{
				discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources: [descriptor], diagnostics: [] }),
				readSourceProfile: async () => sourceSnapshot,
			} as unknown as IEditorMigrationSourceService,
			{
				inspectTarget: async (selection: EditorMigrationTargetSelection) => ({ ...draft.target, selection }),
				createDraftFromCurrentEvidence: async (_source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot) => ({ ...draft, target }),
			} as unknown as IEditorMigrationPlanningService,
			{ listRecoverableOperations: async () => [] } as unknown as IEditorMigrationApplyService,
			{
				defaultProfile: { id: 'default', name: 'Default', isDefault: true },
				profiles: [{ id: 'default', name: 'Default', isDefault: true }, { id: 'work', name: 'Work', isDefault: false }],
			} as unknown as IUserDataProfilesService,
			{ writeText: async () => { } } as unknown as IClipboardService,
			new NullLogService(),
		));
		await session.initialize();
		session.selectApplication('cursor');
		await session.continueFromProfile();
		session.selectTarget({ kind: 'existing', profileId: 'work' });
		await session.continueFromTarget();

		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));
		const text = parent.textContent ?? '';
		assert.match(text, /Settings · 4 available · 3 planned · 2 different · 1 excluded/);
		assert.match(text, /Target Storage/);
		assert.match(text, /Settings: currently inherited from Default/);
		assert.match(text, /New Settings/);
		assert.match(text, /editor.minimap.enabled with imported value true/);
		assert.match(text, /Settings Not Imported/);
		assert.match(text, /specific to the source machine/);
		assert.doesNotMatch(text, /hidden-source-secret/);
		assert.match(text, /Different Settings/);
		assert.match(text, /Current: 14 · Imported: 16/);
		assert.match(text, /Keep All Current Values/);
		assert.match(text, /Use Imported Values for All/);
		assert.match(text, /Keyboard Shortcut Changes/);
		assert.match(text, /Different shortcut ctrl\+k for editor.action.test/);
		assert.match(text, /Snippet File Changes/);
		assert.match(text, /Different snippet file javascript.json/);
		assert.doesNotMatch(text, /private source|private target/);
		assert.match(text, /Already provided by Hucode as a built-in extension/);
		assert.match(text, /Review editor.unknown/);
		assert.doesNotMatch(text, /defaultProfileBacksOmni/);

		const settingsFilter = inputWithLabel(parent, 'Filter different settings');
		settingsFilter.value = 'fontSize';
		settingsFilter.dispatchEvent(domEvent('input'));
		const importAll = [...parent.getElementsByTagName('button')].find(button => button.textContent === 'Use Imported Values for All');
		assert.ok(importAll);
		importAll.dispatchEvent(domEvent('click'));
		assert.strictEqual(session.state.decisions['settings:editor.fontSize'], 'import');
		assert.strictEqual(session.state.decisions['settings:editor.wordWrap'], 'import');

		const extensionRows = [...parent.getElementsByClassName('hucode-editor-migration-extension-row')];
		assert.ok(extensionRows.length < 300, 'the extension review must not render every row');
		const extensionFilter = inputWithLabel(parent, 'Filter extensions');
		extensionFilter.focus();
		extensionFilter.value = 'publisher.extension-299';
		extensionFilter.dispatchEvent(domEvent('input'));
		const filteredExtensionRows = [...parent.getElementsByClassName('hucode-editor-migration-extension-row')];
		assert.strictEqual(filteredExtensionRows.length, 1);
		assert.match(filteredExtensionRows[0].textContent ?? '', /publisher\.extension-299/);
		assert.strictEqual(mainWindow.document.activeElement, inputWithLabel(parent, 'Filter extensions'));

		const reviewBack = [...parent.getElementsByTagName('button')].find(button => button.textContent === 'Back');
		assert.ok(reviewBack);
		reviewBack.dispatchEvent(domEvent('click'));
		const reopenReview = [...parent.getElementsByTagName('button')].find(button => button.textContent === 'Review Import');
		assert.ok(reopenReview);
		reopenReview.dispatchEvent(domEvent('click'));
		assert.strictEqual(inputWithLabel(parent, 'Filter different settings').value, 'fontSize');
		assert.strictEqual(inputWithLabel(parent, 'Filter extensions').value, 'publisher.extension-299');
	});

	test('shows unreadable discovery evidence only in labeled details', async () => {
		const descriptor = {
			...source('Default', 'default', 'cursor-default'),
			ranking: { ...source('Default', 'default', 'cursor-default').ranking, newestModificationTime: 0 },
			categories: [
				{ category: 'settings' as const, state: 'unreadable' as const, itemCount: 0 },
				{ category: 'extensions' as const, state: 'absent' as const, itemCount: 0 },
			],
			diagnostics: [{ code: 'permissionDeniedOrLocked' as const, severity: 'error' as const, scope: 'resource' as const, adapterId: 'cursor' as const, profileId: 'cursor-default', category: 'settings' as const, details: { path: '/private/cursor/settings.json' } }],
		};
		const session = disposables.add(new EditorMigrationFlowSession(
			{ discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources: [descriptor], diagnostics: [{ code: 'candidateAbsent', severity: 'info', scope: 'candidate', adapterId: 'vscode', details: { path: '/private/vscode' } }] }) } as unknown as IEditorMigrationSourceService,
			{} as IEditorMigrationPlanningService,
			{ listRecoverableOperations: async () => [] } as unknown as IEditorMigrationApplyService,
			{ defaultProfile: { id: 'default', name: 'Default', isDefault: true }, profiles: [] } as unknown as IUserDataProfilesService,
			{ writeText: async () => { } } as unknown as IClipboardService,
			new NullLogService(),
		));
		await session.initialize();
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));
		assert.match(parent.textContent ?? '', /Discovery Details/);
		assert.match(parent.textContent ?? '', /No installation data was found/);
		assert.match(parent.textContent ?? '', /\/private\/vscode/);

		session.selectApplication('cursor');
		const text = parent.textContent ?? '';
		assert.match(text, /Settings: could not be read/);
		assert.match(text, /Extensions: not found/);
		assert.match(text, /Profile Details/);
		assert.match(text, /No readable source modification time was found/);
		assert.doesNotMatch(text, /1970/);
		assert.match(text, /locked or Hucode does not have permission/);
		assert.match(text, /\/private\/cursor\/settings\.json/);
		assert.doesNotMatch(text, /source value|private contents/);
	});

	test('offers rollback only for proven mutations and lets the user choose categories', () => {
		const draft = richDraft(richSnapshot(richSource()));
		const plan = {
			...draft,
			choices: { selectedCategories: ['settings', 'keybindings', 'extensions'] as const, decisions: [] },
			operations: [],
			fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' },
		} satisfies EditorMigrationReviewedPlan;
		const operation = {
			id: 'rollback-operation', stage: 'settled', aggregateOutcome: 'completed', plan, results: [], extensionInstallIntents: [],
			snapshots: [
				{ category: 'settings', state: 'present', ownership: 'target', resource: 'settings', byteHash: 'before', postApplyHash: 'after' },
				{ category: 'keybindings', state: 'present', ownership: 'target', resource: 'keybindings', byteHash: 'same' },
			],
		} as unknown as EditorMigrationOperation;
		let requested: readonly string[] | undefined;
		const session = {
			state: presentationState({ phase: 'results', operation }),
			onDidChangeState: Event.None,
			inspectRollback: async (categories: readonly string[]) => { requested = categories; },
		} as unknown as EditorMigrationFlowSession;
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));
		const rollbackLabels = [...parent.querySelectorAll('.hucode-editor-migration-rollback-selection label')].map(label => label.textContent);
		assert.deepStrictEqual(rollbackLabels, ['Settings']);
		const inspect = [...parent.getElementsByTagName('button')].find(button => button.textContent === 'Check File Rollback');
		assert.ok(inspect);
		inspect.dispatchEvent(domEvent('click'));
		assert.deepStrictEqual(requested, ['settings']);
	});

	test('virtualizes Apply and Results and names only durable extension intent', () => {
		const draft = richDraft(richSnapshot(richSource()));
		const operations = draft.decisions.filter(decision => decision.category === 'extensions').map(decision => ({
			id: decision.id,
			category: 'extensions' as const,
			kind: 'installExtension' as const,
			item: decision.item,
			source: decision.source as Extract<EditorMigrationReviewedPlan['operations'][number], { readonly kind: 'installExtension' }>['source'],
		}));
		const plan = { ...draft, choices: { selectedCategories: ['extensions'] as const, decisions: [] }, operations, fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' } } satisfies EditorMigrationReviewedPlan;
		const unresolved: EditorMigrationApplyProgress = { operationId: 'operation', revision: 1, stage: 'applying', target: { state: 'attached', profileId: 'work', profileName: 'Work' }, selectedItemCount: operations.length + 1, results: [], cancellationRequested: false, extensionInstallIntents: [] };
		const unresolvedParent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(unresolvedParent, presentationSession(presentationState({ phase: 'apply', busy: true, reviewedPlan: plan, progress: unresolved })), () => { }));
		assert.match(unresolvedParent.textContent ?? '', /Resolving extensions/);

		const results = operations.map(operation => ({ id: operation.id, category: 'extensions' as const, outcome: 'completed' as const, attempts: 1 }));
		const durable: EditorMigrationApplyProgress = { ...unresolved, revision: 2, results: results.slice(0, 1), extensionInstallIntents: [{ operationId: operations[1].id, applicationScoped: true }] };
		const applyParent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(applyParent, presentationSession(presentationState({ phase: 'apply', busy: true, reviewedPlan: plan, progress: durable })), () => { }));
		assert.match(applyParent.textContent ?? '', new RegExp(operations[1].item));
		const progressbar = applyParent.querySelector('[role="progressbar"]');
		assert.strictEqual(progressbar?.getAttribute('aria-valuemin'), '0');
		assert.strictEqual(progressbar?.getAttribute('ariaValueMin'), null);

		const operation = { id: 'operation', stage: 'settled', aggregateOutcome: 'completed', plan, results, extensionInstallIntents: [] } as unknown as EditorMigrationOperation;
		const resultsParent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(resultsParent, presentationSession(presentationState({ phase: 'results', operation })), () => { }));
		assert.ok(resultsParent.getElementsByClassName('hucode-editor-migration-result-row').length < results.length, 'Results must remain virtualized');
	});

	test('labels item results from reviewed operations while keeping category aggregates concise', () => {
		const draft = richDraft(richSnapshot(richSource()));
		const plan: EditorMigrationReviewedPlan = {
			...draft,
			choices: { selectedCategories: ['snippets', 'extensions'], decisions: [] },
			operations: [
				{
					id: 'opaque-snippet-operation',
					category: 'snippets',
					kind: 'addSnippet',
					item: 'typescript.json',
					source: { name: 'typescript.json', contents: {}, contentHash: 'snippet-hash' },
				},
				{
					id: 'opaque-extension-operation',
					category: 'extensions',
					kind: 'installExtension',
					item: 'publisher.extension',
					source: { id: 'publisher.extension', requestedChannel: 'stable', status: 'available', version: '1.0.0', targetPlatform: 'linux-x64', selectedChannel: 'stable', engine: '*', galleryIdentity: 'open-vsx' },
				},
			],
			exclusions: [],
			fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' },
		};
		const results: readonly EditorMigrationItemResult[] = [
			{ id: 'snippets', category: 'snippets', outcome: 'completed', attempts: 1 },
			{ id: 'opaque-snippet-operation', category: 'snippets', outcome: 'completed', attempts: 1 },
			{ id: 'extensions', category: 'extensions', outcome: 'completed', attempts: 1 },
			{ id: 'opaque-extension-operation', category: 'extensions', outcome: 'completed', attempts: 1 },
		];
		const expected = [
			'Snippets · completed',
			'Snippets · typescript.json · completed',
			'Extensions · completed',
			'Extensions · publisher.extension · completed',
		];
		const progress: EditorMigrationApplyProgress = {
			operationId: 'operation',
			revision: 4,
			stage: 'applying',
			target: { state: 'attached', profileId: 'work', profileName: 'Work' },
			selectedItemCount: results.length,
			results,
			cancellationRequested: false,
		};

		const applyParent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(applyParent, presentationSession(presentationState({ phase: 'apply', busy: true, reviewedPlan: plan, progress })), () => { }));
		const applyTexts = renderedResultTexts(applyParent);
		assert.deepStrictEqual(applyTexts, expected);
		expected.forEach((label, index) => assert.strictEqual(occurrences(applyTexts[index], label), 1, `Apply result label must render once: ${label}`));

		const operation = {
			id: 'operation',
			stage: 'settled',
			aggregateOutcome: 'completed',
			plan,
			results,
			extensionInstallIntents: [{ operationId: 'opaque-extension-operation', actualProfileLocation: '/private/default/extensions.json', applicationScoped: true }],
		} as unknown as EditorMigrationOperation;
		const resultsParent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(resultsParent, presentationSession(presentationState({ phase: 'results', operation })), () => { }));
		const resultTexts = renderedResultTexts(resultsParent);
		assert.deepStrictEqual(resultTexts, expected);
		expected.forEach((label, index) => assert.strictEqual(occurrences(resultTexts[index], label), 1, `Results label must render once: ${label}`));
		assert.match(resultsParent.textContent ?? '', /publisher\.extension is installed application-wide in Default/);
		assert.match(resultsParent.textContent ?? '', /Reload Hucode windows/);
		assert.doesNotMatch(resultsParent.textContent ?? '', /\/private\/default/);

		const legacyOperation = { ...operation, extensionInstallIntents: [{ operationId: 'opaque-extension-operation', actualProfileLocation: '/private/legacy/extensions.json' }] } as EditorMigrationOperation;
		const legacyParent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(legacyParent, presentationSession(presentationState({ phase: 'results', operation: legacyOperation })), () => { }));
		assert.match(legacyParent.textContent ?? '', /older recovery record does not identify its profile placement/);
		assert.doesNotMatch(legacyParent.textContent ?? '', /installed application-wide in Default|installed in this profile/);
		assert.doesNotMatch(legacyParent.textContent ?? '', /\/private\/legacy/);
	});
});

function presentationSession(state: EditorMigrationFlowState): EditorMigrationFlowSession {
	return {
		state,
		onDidChangeState: Event.None,
	} as unknown as EditorMigrationFlowSession;
}

function presentationState(overrides: Pick<EditorMigrationFlowState, 'phase'> & Partial<EditorMigrationFlowState>): EditorMigrationFlowState {
	return {
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

function renderedResultTexts(parent: HTMLElement): readonly string[] {
	return [...parent.getElementsByClassName('hucode-editor-migration-result-row')].map(item => item.textContent ?? '');
}

function occurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

function source(name: string, kind: 'default' | 'named', ref: string): EditorMigrationSourceDescriptor {
	return {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: ref },
		adapter: { id: 'cursor', productName: 'Cursor', channel: 'stable', order: 2 },
		profile: { id: ref, name, kind },
		localPaths: { userData: `/private/${ref}`, extensions: `/private/${ref}/extensions` },
		categories: [{ category: 'settings', state: 'present', itemCount: 1 }],
		diagnostics: [],
		ranking: { completeness: 1, newestModificationTime: 1, stableChannelPreference: 1, adapterOrder: 2, normalizedProfileName: name.toLowerCase(), canonicalReference: ref },
		discoveryFingerprint: { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, algorithm: 'sha256', categories: ['settings'], entries: [], value: `fingerprint-${ref}` },
	};
}

function richSource(): EditorMigrationSourceDescriptor {
	return {
		...source('Default', 'default', 'cursor-default'),
		categories: [
			{ category: 'settings', state: 'present', itemCount: 4 },
			{ category: 'keybindings', state: 'present', itemCount: 2 },
			{ category: 'snippets', state: 'present', itemCount: 2 },
			{ category: 'extensions', state: 'present', itemCount: 305 },
		],
	};
}

function richSnapshot(descriptor: EditorMigrationSourceDescriptor): EditorMigrationSourceSnapshot {
	return {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: descriptor.ref,
		adapter: descriptor.adapter,
		profile: descriptor.profile,
		categories: [
			{ category: 'settings', state: 'present', value: { 'editor.fontSize': 16, 'editor.wordWrap': 'on', 'editor.minimap.enabled': true, 'machine.secret': 'hidden-source-secret' } },
			{ category: 'keybindings', state: 'present', value: [] },
			{ category: 'snippets', state: 'present', value: [] },
			{ category: 'extensions', state: 'present', value: [] },
		],
		diagnostics: [],
		fingerprint: descriptor.discoveryFingerprint,
	};
}

function richDraft(sourceSnapshot: EditorMigrationSourceSnapshot): EditorMigrationPlanDraft {
	const extensions = Array.from({ length: 300 }, (_, index) => ({
		id: `extensions:publisher.extension-${index}:1.0.${index}:linux-x64`,
		category: 'extensions' as const,
		item: `publisher.extension-${index}`,
		kind: 'add' as const,
		defaultChoice: 'import' as const,
		source: { id: `publisher.extension-${index}`, requestedChannel: 'stable' as const, status: 'available' as const, version: `1.0.${index}`, targetPlatform: 'linux-x64', selectedChannel: 'stable' as const, engine: '*', galleryIdentity: 'open-vsx' },
	}));
	return {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		source: sourceSnapshot,
		target: {
			schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
			selection: { kind: 'existing', profileId: 'work' },
			profile: { id: 'work', name: 'Work', kind: 'named' },
			eligible: true,
			catalogFingerprint: 'catalog',
			requestedCategories: ['settings', 'keybindings', 'snippets', 'extensions'],
			categories: [
				{ category: 'settings', ownership: 'default', ownerProfileId: 'default', state: 'present', value: { 'editor.fontSize': 14, 'editor.wordWrap': 'off' } },
				{ category: 'keybindings', ownership: 'target', ownerProfileId: 'work', state: 'present', value: [] },
				{ category: 'snippets', ownership: 'target', ownerProfileId: 'work', state: 'present', value: [] },
				{ category: 'extensions', ownership: 'target', ownerProfileId: 'work', state: 'present', value: [] },
			],
			environment: { targetPlatform: 'linux-x64', productVersion: '1.135.0', hucodeVersion: '0.0.78', galleryIdentity: 'open-vsx', policyVersion: 1 },
			builtIns: [],
			fingerprint: 'target',
		},
		evidence: { registryIgnoredSettings: [], normalizedKeys: {}, keybindingPlatform: 'linux', gallery: [] },
		decisions: [
			{ id: 'settings:editor.minimap.enabled', category: 'settings', item: 'editor.minimap.enabled', kind: 'add', defaultChoice: 'import', source: true },
			{ id: 'settings:editor.fontSize', category: 'settings', item: 'editor.fontSize', kind: 'conflict', defaultChoice: 'preserveTarget', source: 16, target: 14 },
			{ id: 'settings:editor.wordWrap', category: 'settings', item: 'editor.wordWrap', kind: 'conflict', defaultChoice: 'preserveTarget', source: 'on', target: 'off' },
			{ id: 'keybindings:add', category: 'keybindings', item: 'ctrl+l:test.add', kind: 'add', defaultChoice: 'import', source: { key: 'ctrl+l', command: 'test.add' } },
			{ id: 'keybindings:conflict', category: 'keybindings', item: 'ctrl+k:editor.action.test', kind: 'conflict', defaultChoice: 'preserveTarget', source: { key: 'ctrl+k', command: 'editor.action.test' }, target: { key: 'ctrl+k', command: 'other.action' } },
			{ id: 'snippets:add', category: 'snippets', item: 'typescript.json', kind: 'add', defaultChoice: 'import', source: { name: 'typescript.json', contents: '{}', contentHash: 'new' } },
			{ id: 'snippets:conflict', category: 'snippets', item: 'javascript.json', kind: 'conflict', defaultChoice: 'preserveTarget', source: { name: 'javascript.json', contents: '{ private source }', contentHash: 'source' }, target: { name: 'javascript.json', contents: '{ private target }', contentHash: 'target' } },
			...extensions,
		],
		exclusions: [
			{ category: 'settings', item: 'machine.secret', reason: 'machineSpecific' },
			{ category: 'extensions', item: 'hucode.builtin', reason: 'builtIn' },
			{ category: 'extensions', item: 'publisher.installed', reason: 'alreadyInstalled' },
			{ category: 'extensions', item: 'publisher.missing', reason: 'galleryUnavailable' },
			{ category: 'extensions', item: 'publisher.incompatible', reason: 'galleryIncompatible' },
			{ category: 'extensions', item: 'cursor.integration', reason: 'sourceProductIntegration' },
		],
		prerequisites: [{ kind: 'materializeInheritedResource', category: 'settings', ownerProfileId: 'default', baselineFingerprint: 'baseline' }],
		warnings: [{ code: 'defaultProfileBacksOmni' }, { code: 'unknownSettingSchema', item: 'editor.unknown' }],
		draftFingerprintSeed: 'draft',
	};
}

function testParent(disposables: ReturnType<typeof ensureNoDisposablesAreLeakedInTestSuite>): HTMLElement {
	const parent = mainWindow.document.createElement('div');
	mainWindow.document.body.appendChild(parent);
	disposables.add({ dispose: () => parent.remove() });
	return parent;
}

function inputWithLabel(parent: HTMLElement, label: string): HTMLInputElement {
	const input = [...parent.getElementsByTagName('input')].find(candidate => candidate.getAttribute('aria-label') === label);
	assert.ok(input, `expected input labeled ${label}`);
	return input;
}

function domEvent(type: string): globalThis.Event {
	const event = mainWindow.document.createEvent('Event');
	event.initEvent(type, true, true);
	return event;
}

function keyboardEvent(key: string): KeyboardEvent {
	return new mainWindow.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
}
