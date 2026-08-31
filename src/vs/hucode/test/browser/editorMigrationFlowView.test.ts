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
import { EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION, EditorMigrationDraftDecision, EditorMigrationDraftExclusion, EditorMigrationPlanDraft, EditorMigrationPlanWarning, EditorMigrationReviewedPlan, IEditorMigrationPlanningService } from '../../common/migration/editorMigrationPlanning.js';
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

		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));

		const radios = [...parent.getElementsByTagName('input')].filter(input => input.type === 'radio');
		assert.ok(radios.length < sources.length, 'only the visible profile window should be in the DOM');
		assert.strictEqual(radios[0].checked, true);
		assert.match(radios[0].labels?.[0]?.textContent ?? '', /Default/);
		const fullList = parent.querySelector('[data-migration-list-id="profiles"] .monaco-list') as HTMLElement;
		assert.ok(fullList);
		fullList.focus();
		fullList.dispatchEvent(keyboardEvent('End'));
		assert.match(fullList.textContent ?? '', /Profile 299/, 'End should focus an off-screen profile and scroll it into view');
		fullList.dispatchEvent(keyboardEvent('Home'));
		assert.match(fullList.textContent ?? '', /Default/, 'Home should return to the first profile');
		fullList.dispatchEvent(keyboardEvent('End'));
		session.selectSourceProfile(sources[1].ref);
		assert.match(parent.textContent ?? '', /Profile 299/, 'the off-screen focused window remains rendered after the update');

		const filter = inputWithLabel(parent, 'Filter profiles');
		filter.focus();
		filter.value = 'Profile 299';
		filter.setSelectionRange(7, 7);
		filter.dispatchEvent(domEvent('input'));

		const filteredInput = inputWithLabel(parent, 'Filter profiles');
		const filteredRadios = [...parent.getElementsByTagName('input')].filter(input => input.type === 'radio');
		assert.strictEqual(mainWindow.document.activeElement, filteredInput);
		assert.deepStrictEqual([filteredInput.selectionStart, filteredInput.selectionEnd], [7, 7]);
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
		const sources = Array.from({ length: 300 }, (_, index) => withAdapter(source('Default', 'default', `application-${index}-default`), `application-${index}`, `Application ${index}`, index));
		const session = disposables.add(discoverySession(sources));
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

	test('auto-sizes small application and profile choices without filter controls', async () => {
		const sources = [
			source('Default', 'default', 'cursor-default'),
			source('Work', 'named', 'cursor-work'),
			withAdapter(source('Default', 'default', 'vscode-default'), 'vscode', 'Visual Studio Code', 0),
		];
		const session = disposables.add(discoverySession(sources));
		await session.initialize();
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));

		assert.strictEqual(searchInputs(parent).length, 0, 'two applications do not need a filter control');
		const applicationList = parent.querySelector('[data-migration-list-id="applications"]') as HTMLElement;
		assert.strictEqual(applicationList.style.height, '152px', 'the application list sizes to its two rows');

		const cards = [...parent.getElementsByClassName('hucode-editor-migration-choice-card')].map(card => card.textContent ?? '');
		assert.deepStrictEqual(cards, ['Cursor2 profiles', 'Visual Studio Code1 profile'], 'profile counts use singular and plural copy');

		const cursor = buttonWithText(parent, 'Cursor');
		cursor.dispatchEvent(domEvent('click'));
		assert.strictEqual(searchInputs(parent).length, 0, 'two profiles do not need a filter control');
		assert.match(parent.textContent ?? '', /Default/);
		assert.match(parent.textContent ?? '', /Work/);

		buttonWithText(parent, 'Back').dispatchEvent(domEvent('click'));
		assert.match(parent.textContent ?? '', /Which Application Should Hucode Import From\?/);
	});

	test('keeps application and profile filters independent across navigation', async () => {
		const sources = [
			...Array.from({ length: 10 }, (_, index) => source(`Profile ${index}`, 'named', `cursor-${index}`)),
			...Array.from({ length: 10 }, (_, index) => withAdapter(source('Default', 'default', `other-${index}-default`), `other-${index}`, `Other Editor ${index}`, index)),
		];
		const session = disposables.add(discoverySession(sources));
		await session.initialize();
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));

		const applicationFilter = inputWithLabel(parent, 'Filter applications');
		applicationFilter.value = 'Cursor';
		applicationFilter.dispatchEvent(domEvent('input'));
		buttonWithText(parent, 'Cursor').dispatchEvent(domEvent('click'));

		assert.strictEqual(inputWithLabel(parent, 'Filter profiles').value, '');
		buttonWithText(parent, 'Back').dispatchEvent(domEvent('click'));
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
		assert.match(parent.textContent ?? '', /Import finished/);
		assert.doesNotMatch(parent.textContent ?? '', /\bsettled\b/);
		assert.ok(buttonWithText(parent, 'Start Another Import'), 'the recovery action stays in the footer');
		const list = parent.querySelector('[data-migration-list-id="recoveries"] .monaco-list') as HTMLElement;
		assert.ok(list);
		list.focus();
		list.dispatchEvent(keyboardEvent('ArrowDown'));
		list.dispatchEvent(keyboardEvent('Enter'));
		assert.strictEqual(opened, 'recovery-1');
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

	test('opens review on the first section needing attention and summarizes routine additions', () => {
		const draft = volumeDraft();
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(volumeReviewState(draft)), () => { }));

		assert.deepStrictEqual(sectionLabels(parent), ['Settings', 'Keyboard Shortcuts', 'Snippets', 'Extensions', 'Not Imported']);
		assert.deepStrictEqual(sectionCounts(parent), ['214', '170', '2', '77', '62']);
		assert.strictEqual(activeSection(parent), 'settings', 'review opens on the first section needing attention');
		assert.deepStrictEqual(sectionsWithStatus(parent, 'attention'), ['settings', 'extensions']);

		const settledSettings = { ...draft, decisions: draft.decisions.filter(decision => decision.kind !== 'conflict') };
		const settledParent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(settledParent, presentationSession(volumeReviewState(settledSettings)), () => { }));
		assert.strictEqual(activeSection(settledParent), 'extensions', 'attention outranks the Settings fallback');

		const detail = detailPane(parent);
		assert.match(detail.textContent ?? '', /214 of 237 will be imported\. 3 differ from your current values\./);
		assert.strictEqual(detail.getElementsByClassName('hucode-editor-migration-conflict').length, 3, 'only the differing settings render as comparison rows');
		assert.match(detail.textContent ?? '', /211 new settings/);
		assert.strictEqual(occurrences(detail.textContent ?? '', 'settings.new-'), 25, 'routine additions stay capped inside the disclosure');
		assert.match(detail.textContent ?? '', /and 186 more\./);
		assert.match(detail.textContent ?? '', /Keep All Current Values/);
		assert.match(detail.textContent ?? '', /Use Imported Values for All/);
		assert.match(detail.textContent ?? '', /Current value 13\. Imported value 14\./);

		assert.strictEqual(parent.getElementsByClassName('hucode-editor-migration-detail').length, 1, 'an indexed screen has exactly one detail pane');
		assert.strictEqual(detail.querySelectorAll('ul ul').length, 0, 'disclosures never nest lists');
		assert.strictEqual(detail.getElementsByClassName('hucode-editor-migration-virtual-list').length, 0, 'review never nests a scrolling list inside the detail pane');
		assert.ok(buttonWithText(parent, 'Back'));
		assert.ok(buttonWithText(parent, 'Continue'));
	});

	test('aggregates repeated warnings and never lists every planned extension', () => {
		const draft = volumeDraft();
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(volumeReviewState(draft)), () => { }));

		selectSection(parent, 'extensions');
		assert.strictEqual(activeSection(parent), 'extensions');
		const detail = detailPane(parent);
		assert.match(detail.textContent ?? '', /77 of 116 will be imported\./);
		assert.strictEqual(occurrences(detail.textContent ?? '', 'requested a pre-release version'), 1, 'six pre-release fallbacks render once');
		assert.match(detail.textContent ?? '', /6 extensions requested a pre-release version/);
		assert.match(detail.textContent ?? '', /77 planned installations/);
		assert.strictEqual(occurrences(detail.textContent ?? '', 'publisher.extension-'), 25 + 6, 'planned installs stay capped; the warning group lists its own six');
		assert.strictEqual(detail.getElementsByClassName('hucode-editor-migration-conflict').length, 0);
	});

	test('groups held-back items by reason with one statement and a count', () => {
		const draft = volumeDraft();
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(volumeReviewState(draft)), () => { }));

		selectSection(parent, 'notImported');
		const detail = detailPane(parent);
		assert.match(detail.textContent ?? '', /62 items are held back, grouped by reason\./);
		const groups = [...detail.getElementsByClassName('hucode-editor-migration-group')].map(group => group.textContent ?? '');
		assert.strictEqual(groups.length, 3);
		assert.match(groups[0], /^24Extensions — Unavailable from Hucode's extension gallery\./);
		assert.match(groups[1], /^23Settings — Kept out because these settings are specific to the source machine\./);
		assert.match(groups[2], /^15Extensions — Already installed in the target profile\./);
		assert.strictEqual(occurrences(detail.textContent ?? '', 'Unavailable from Hucode'), 1, 'each reason is stated once');
		assert.strictEqual(detail.querySelectorAll('ul ul').length, 0);
	});

	test('holds back a deselected category as whole-category source items, not its exclusions again', async () => {
		const draft = volumeDraft();
		const session = disposables.add(await reviewSession(draft));
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));
		assert.deepStrictEqual([...session.state.selectedCategories], ['settings', 'keybindings', 'snippets', 'extensions']);
		assert.deepStrictEqual(sectionCounts(parent), ['214', '170', '2', '77', '62']);

		selectSection(parent, 'extensions');
		const include = includeCheckbox(parent, 'Include Extensions in this import');
		include.checked = false;
		include.dispatchEvent(domEvent('change'));

		assert.deepStrictEqual([...session.state.selectedCategories], ['settings', 'keybindings', 'snippets'], 'the inclusion control drives the state the view renders from');
		assert.deepStrictEqual(sectionCounts(parent), ['214', '170', '2', '0', '139'], '116 Extensions source items plus the 23 remaining Settings exclusions');
		assert.match(footer(parent).textContent ?? '', /386 items ready to import\. 139 held back\./);

		selectSection(parent, 'notImported');
		const detail = detailPane(parent);
		assert.match(detail.textContent ?? '', /139 items are held back, grouped by reason\./);
		const groups = [...detail.getElementsByClassName('hucode-editor-migration-group')].map(group => group.textContent ?? '');
		assert.strictEqual(groups.length, 2);
		assert.match(groups[0], /^116Extensions is not included in this import, so none of its source items are imported\.$/);
		assert.match(groups[1], /^23Settings — Kept out because these settings are specific to the source machine\./);
		assert.doesNotMatch(detail.textContent ?? '', /Unavailable from Hucode's extension gallery/, 'a deselected category must not also list its exclusion reasons');
		assert.doesNotMatch(detail.textContent ?? '', /Already installed in the target profile/);

		selectSection(parent, 'extensions');
		const restored = includeCheckbox(parent, 'Include Extensions in this import');
		assert.strictEqual(restored.checked, false, 'the rerendered control reflects the deselected state');
		restored.checked = true;
		restored.dispatchEvent(domEvent('change'));
		assert.deepStrictEqual(sectionCounts(parent), ['214', '170', '2', '77', '62'], 're-including the category restores the exclusion-only accounting');
	});

	test('keeps the review target, ownership and category inclusion controls in the detail header', () => {
		const draft = volumeDraft();
		const parent = testParent(disposables);
		const session = presentationSession(volumeReviewState(draft));
		disposables.add(new EditorMigrationFlowView(parent, session, () => { }));

		const include = [...detailPane(parent).getElementsByTagName('input')].find(input => input.type === 'checkbox');
		assert.ok(include, 'category inclusion lives in the detail header');
		assert.strictEqual(include.checked, true);
		assert.match(include.parentElement?.textContent ?? '', /Include Settings in this import/);
		assert.match(detailPane(parent).textContent ?? '', /Currently inherited from Default; Hucode will copy it into Work before importing\./);
		assert.match(footer(parent).textContent ?? '', /Default into Work\./);
		assert.match(footer(parent).textContent ?? '', /463 items ready to import\. 62 held back\./);
		assert.strictEqual([...parent.getElementsByClassName('hucode-editor-migration-section')].filter(node => node.closest('.hucode-editor-migration-index')).length, 5);
	});

	test('confirms publishers with import-only wording while keeping the review index', () => {
		const draft = volumeDraft();
		const state = presentationState({
			...volumeReviewState(draft),
			phase: 'publishers',
			publishers: ['publisher', 'other'],
			reviewedPlan: reviewedPlanFrom(draft, ['settings', 'extensions']),
		});
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(state), () => { }));

		assert.strictEqual(activeSection(parent), 'publishers');
		assert.ok(sectionLabels(parent).includes('Publishers'));
		assert.ok(sectionLabels(parent).includes('Settings'), 'the review topic map stays available during confirmation');
		const detail = detailPane(parent);
		assert.match(detail.textContent ?? '', /This confirmation applies only to this import and does not change Hucode's trusted publisher settings\./);
		assert.match(detail.textContent ?? '', /publisher provides 77 extensions in this import\./);
		assert.ok(buttonWithText(parent, 'Confirm Publishers and Import'));
		assert.ok(buttonWithText(parent, 'Back'));

		selectSection(parent, 'settings');
		const settingsDetail = detailPane(parent);
		assert.strictEqual(settingsDetail.getElementsByClassName('hucode-editor-migration-conflict').length, 3);
		assert.strictEqual([...settingsDetail.getElementsByTagName('input')].length, 0, 'confirmation must not reopen review choices');
		assert.match(settingsDetail.textContent ?? '', /Keeping current value/);
	});

	test('shows four category progress states and at most one current item', () => {
		const draft = volumeDraft();
		const plan = reviewedPlanFrom(draft, ['settings', 'keybindings', 'snippets', 'extensions']);
		const progress: EditorMigrationApplyProgress = {
			operationId: 'operation', revision: 3, stage: 'applying',
			target: { state: 'attached', profileId: 'work', profileName: 'Work' },
			selectedItemCount: 463,
			results: [
				{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 },
				{ id: 'keybindings', category: 'keybindings', outcome: 'completed', attempts: 1 },
				{ id: 'snippets', category: 'snippets', outcome: 'completed', attempts: 1 },
				...Array.from({ length: 40 }, (_, index) => ({ id: `extensions:publisher.extension-${index}`, category: 'extensions' as const, outcome: 'completed' as const, attempts: 1 })),
			],
			cancellationRequested: false,
			extensionInstallIntents: [{ operationId: 'extensions:publisher.extension-40', applicationScoped: false }],
		};
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(presentationState({ phase: 'apply', busy: true, reviewedPlan: plan, progress })), () => { }));

		assert.strictEqual(activeSection(parent), 'overview');
		const detail = detailPane(parent);
		const rows = [...detail.getElementsByClassName('hucode-editor-migration-progress-row')].map(row => row.textContent ?? '');
		assert.strictEqual(rows.length, 4, 'apply shows one progress state per category');
		assert.match(rows[0], /^SettingsComplete\. 1 recorded\.$/);
		assert.match(rows[2], /^SnippetsComplete\. 1 recorded\.$/);
		assert.match(rows[3], /^ExtensionsIn progress\. 40 of 77 recorded\.$/);
		assert.strictEqual(detail.getElementsByClassName('hucode-editor-migration-current-item').length, 1, 'apply streams at most one current item line');
		assert.match(detail.textContent ?? '', /Working on publisher\.extension-40\./);
		assert.strictEqual(detail.getElementsByClassName('hucode-editor-migration-result-row').length, 0, 'apply must not stream every completed operation');
		const progressbar = detail.querySelector('[role="progressbar"]');
		assert.strictEqual(progressbar?.getAttribute('aria-valuemin'), '0');
		assert.strictEqual(progressbar?.getAttribute('aria-valuenow'), '43');
		assert.ok(buttonWithText(parent, 'Cancel Import'));

		const waitingParent = testParent(disposables);
		const waiting = { ...progress, results: progress.results.filter(result => result.category !== 'snippets' && result.category !== 'extensions') };
		disposables.add(new EditorMigrationFlowView(waitingParent, presentationSession(presentationState({ phase: 'apply', busy: true, reviewedPlan: plan, progress: waiting })), () => { }));
		const waitingRows = [...detailPane(waitingParent).getElementsByClassName('hucode-editor-migration-progress-row')].map(row => row.textContent ?? '');
		assert.match(waitingRows[2], /^SnippetsWaiting\.$/);
		assert.match(detailPane(waitingParent).textContent ?? '', /Working on Snippets\./);
	});

	test('names only durable extension intent while resolving', () => {
		const draft = volumeDraft();
		const plan = reviewedPlanFrom(draft, ['extensions']);
		const unresolved: EditorMigrationApplyProgress = {
			operationId: 'operation', revision: 1, stage: 'applying',
			target: { state: 'attached', profileId: 'work', profileName: 'Work' },
			selectedItemCount: 78, results: [], cancellationRequested: false, extensionInstallIntents: [],
		};
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(presentationState({ phase: 'apply', busy: true, reviewedPlan: plan, progress: unresolved })), () => { }));
		assert.match(parent.textContent ?? '', /Working on Resolving extensions\./);
	});

	test('shows durable rollback resource progress instead of forward Apply counts', () => {
		const draft = volumeDraft();
		const plan = reviewedPlanFrom(draft, ['settings', 'snippets']);
		const progress: EditorMigrationApplyProgress = {
			operationId: 'rollback-operation', revision: 8, stage: 'rollbackPending',
			target: { state: 'attached', profileId: 'work', profileName: 'Work' },
			selectedItemCount: 99,
			results: Array.from({ length: 20 }, (_, index) => ({ id: `forward-${index}`, category: 'settings' as const, outcome: 'completed' as const, attempts: 1 })),
			cancellationRequested: false,
			rollback: { categories: ['settings', 'snippets'], restoredResourceCount: 1, resourceCount: 3, mutationStarted: true },
		};
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(presentationState({ phase: 'apply', busy: true, reviewedPlan: plan, progress })), () => { }));
		const progressbar = parent.querySelector('[role="progressbar"]');
		assert.match(progressbar?.textContent ?? '', /Restoring Settings, Snippets\. 1 of 3 file resources restored\./);
		assert.doesNotMatch(progressbar?.textContent ?? '', /20 of 99/);
		assert.strictEqual(progressbar?.getAttribute('aria-valuenow'), '1');
		assert.strictEqual(progressbar?.getAttribute('aria-valuemax'), '3');
		assert.strictEqual(parent.getElementsByClassName('hucode-editor-migration-progress-row').length, 0, 'rollback progress must not present forward Apply results as restoration evidence');
		assert.strictEqual(parent.getElementsByClassName('hucode-editor-migration-result-row').length, 0);
	});

	test('opens results on the first category with a problem and collapses routine successes', () => {
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(presentationState({ phase: 'results', operation: volumeOperation() })), () => { }));

		assert.deepStrictEqual(sectionLabels(parent), ['Summary', 'Settings', 'Keyboard Shortcuts', 'Snippets', 'Extensions', 'Not Imported']);
		assert.strictEqual(activeSection(parent), 'extensions', 'results open the first category with a problem');
		const detail = detailPane(parent);
		assert.match(detail.textContent ?? '', /75 succeeded, 2 need attention\./);
		const failures = [...detail.getElementsByClassName('hucode-editor-migration-result-row')].map(row => row.textContent ?? '');
		assert.strictEqual(failures.length, 2, 'failures come first and successes stay collapsed');
		assert.match(failures[0], /publisher\.extension-0 · failed/);
		assert.match(failures[0], /The extension installation failed\./);
		assert.match(detail.textContent ?? '', /75 completed successfully/);
		assert.ok(buttonWithText(parent, 'Retry Failed Items'));
		assert.ok(buttonWithText(parent, 'Copy Report'));
		assert.ok(buttonWithText(parent, 'Import Another Setup'));
		assert.ok(buttonWithText(parent, 'Done'));
		assert.ok(buttonWithText(parent, 'Done and Remove Recovery Data'));
		assert.match(footer(parent).textContent ?? '', /Removing recovery data deletes the retained snapshots used for file rollback\./);
	});

	test('aggregates extension placement guidance instead of repeating it per extension', () => {
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(presentationState({ phase: 'results', operation: volumeOperation() })), () => { }));
		selectSection(parent, 'overview');
		const detail = detailPane(parent);
		assert.match(detail.textContent ?? '', /75 extensions are installed in this profile\. Restart the extension host or reload this window to use them\./);
		assert.match(detail.textContent ?? '', /2 extensions were intended for this profile, but no completed installation was recorded\./);
		assert.strictEqual(occurrences(detail.textContent ?? '', 'Restart the extension host'), 1, 'placement guidance is stated once per outcome');
		assert.match(detail.textContent ?? '', /3 current values were kept during review/);
	});

	test('reports legacy recovery records without an unknown profile placement per extension', () => {
		const operation = volumeOperation();
		const legacy = {
			...operation,
			extensionInstallIntents: operation.extensionInstallIntents.map(intent => ({ operationId: intent.operationId, actualProfileLocation: '/private/legacy/extensions.json' })),
		} as unknown as EditorMigrationOperation;
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(presentationState({ phase: 'results', operation: legacy })), () => { }));
		selectSection(parent, 'overview');
		assert.match(parent.textContent ?? '', /older recovery record does not identify their profile placement/);
		assert.doesNotMatch(parent.textContent ?? '', /installed application-wide in Default|installed in this profile/);
		assert.doesNotMatch(parent.textContent ?? '', /\/private\/legacy/);
	});

	test('keeps a category deselected during review in the durable Results Not Imported topic', () => {
		const draft = volumeDraft();
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(presentationState({ phase: 'results', operation: partialCategoryOperation(draft) })), () => { }));

		assert.deepStrictEqual(sectionLabels(parent), ['Summary', 'Settings', 'Keyboard Shortcuts', 'Snippets', 'Not Imported']);
		assert.deepStrictEqual(sectionCounts(parent), ['', '1', '1', '1', '139'], 'Results keeps the accounting Review showed');

		selectSection(parent, 'notImported');
		const detail = detailPane(parent);
		assert.match(detail.textContent ?? '', /139 items were held back during review, grouped by reason\./);
		const groups = [...detail.getElementsByClassName('hucode-editor-migration-group')].map(group => group.textContent ?? '');
		assert.strictEqual(groups.length, 2);
		assert.match(groups[0], /^116Extensions is not included in this import, so none of its source items are imported\.$/);
		assert.match(groups[1], /^23Settings — Kept out because these settings are specific to the source machine\./);
		assert.doesNotMatch(detail.textContent ?? '', /Unavailable from Hucode's extension gallery/);
	});

	test('offers the Results Not Imported topic for a deselected category with no policy exclusions', () => {
		const draft = { ...volumeDraft(), exclusions: [] };
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(presentationState({ phase: 'results', operation: partialCategoryOperation(draft) })), () => { }));

		assert.ok(sectionLabels(parent).includes('Not Imported'), 'a deselected category alone must still produce the topic');
		assert.deepStrictEqual(sectionCounts(parent), ['', '1', '1', '1', '116']);
	});

	test('offers rollback only for proven mutations and lets the user choose categories', () => {
		const draft = volumeDraft();
		const plan = reviewedPlanFrom(draft, ['settings', 'keybindings', 'extensions']);
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

		assert.ok(sectionLabels(parent).includes('Undo File Changes'));
		selectSection(parent, 'restore');
		const rollbackLabels = [...parent.querySelectorAll('.hucode-editor-migration-rollback-selection label')].map(label => label.textContent);
		assert.deepStrictEqual(rollbackLabels, ['Settings']);
		buttonWithText(parent, 'Check File Rollback').dispatchEvent(domEvent('click'));
		assert.deepStrictEqual(requested, ['settings']);
	});

	test('does not offer forward retry after rollback restoration started', () => {
		const draft = volumeDraft();
		const plan = reviewedPlanFrom(draft, ['snippets']);
		const operation = {
			id: 'partial-rollback', stage: 'settled', aggregateOutcome: 'completedWithIssues', plan,
			results: [{ id: 'snippets', category: 'snippets', outcome: 'failed', attempts: 2 }], extensionInstallIntents: [], snapshots: [],
			rollbackIntent: {
				categories: ['snippets'], forceCategories: [], ownershipState: 'restored', mutationStarted: true,
				beforeFlags: {}, afterFlags: {}, resources: [
					{ category: 'snippets', item: 'one.code-snippets', resource: 'private-resource-one', expectedPostApplyHash: 'after-one', expectedRestoredHash: 'before-one', state: 'restored' },
					{ category: 'snippets', item: 'two.code-snippets', resource: 'private-resource-two', expectedPostApplyHash: 'after-two', expectedRestoredHash: 'before-two', state: 'pending' },
				],
			},
		} as unknown as EditorMigrationOperation;
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(presentationState({ phase: 'results', operation })), () => { }));
		assert.match(footer(parent).textContent ?? '', /Forward import retry is unavailable because file restoration already began\./);
		assert.doesNotMatch(parent.textContent ?? '', /Retry Failed Items/);
		assert.doesNotMatch(parent.textContent ?? '', /private-resource-one/);
		selectSection(parent, 'restore');
		assert.match(detailPane(parent).textContent ?? '', /File restoration already began for this import\./);
	});

	test('offers Resume but not forward retry for an interrupted pre-mutation rollback', () => {
		const draft = volumeDraft();
		const plan = reviewedPlanFrom(draft, ['snippets']);
		const operation = {
			id: 'interrupted-rollback', stage: 'rollbackPending', aggregateOutcome: 'recoverable', plan,
			results: [{ id: 'snippets', category: 'snippets', outcome: 'failed', attempts: 1 }], extensionInstallIntents: [], snapshots: [],
			rollbackIntent: {
				categories: ['snippets'], forceCategories: [], ownershipState: 'pending', mutationStarted: false,
				beforeFlags: {}, afterFlags: {}, resources: [
					{ category: 'snippets', item: 'one.code-snippets', resource: 'private-resource-one', expectedPostApplyHash: 'after-one', expectedRestoredHash: 'before-one', state: 'pending' },
				],
			},
		} as unknown as EditorMigrationOperation;
		const parent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(parent, presentationSession(presentationState({ phase: 'results', operation })), () => { }));
		assert.ok(buttonWithText(parent, 'Resume'));
		assert.doesNotMatch(parent.textContent ?? '', /Retry Failed Items/);
	});
});

// #region fixtures and helpers

function discoverySession(sources: readonly EditorMigrationSourceDescriptor[]): EditorMigrationFlowSession {
	return new EditorMigrationFlowSession(
		{ discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources, diagnostics: [] }) } as unknown as IEditorMigrationSourceService,
		{} as IEditorMigrationPlanningService,
		{ listRecoverableOperations: async () => [] } as unknown as IEditorMigrationApplyService,
		{ defaultProfile: { id: 'default', name: 'Default', isDefault: true }, profiles: [] } as unknown as IUserDataProfilesService,
		{ writeText: async () => { } } as unknown as IClipboardService,
		new NullLogService(),
	);
}

/** A real session driven through discovery to Review, so control events exercise real state. */
async function reviewSession(draft: EditorMigrationPlanDraft): Promise<EditorMigrationFlowSession> {
	const descriptor = source('Default', 'default', 'cursor-default');
	const session = new EditorMigrationFlowSession(
		{
			discoverSources: async () => ({ schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, generation: 1, sources: [descriptor], diagnostics: [] }),
			readSourceProfile: async () => draft.source,
		} as unknown as IEditorMigrationSourceService,
		{
			inspectTarget: async (selection: unknown) => ({ ...draft.target, selection }),
			createDraftFromCurrentEvidence: async (_source: unknown, target: unknown) => ({ ...draft, target }),
		} as unknown as IEditorMigrationPlanningService,
		{ listRecoverableOperations: async () => [] } as unknown as IEditorMigrationApplyService,
		{
			defaultProfile: { id: 'default', name: 'Default', isDefault: true },
			profiles: [{ id: 'default', name: 'Default', isDefault: true }, { id: 'work', name: 'Work', isDefault: false }],
		} as unknown as IUserDataProfilesService,
		{ writeText: async () => { } } as unknown as IClipboardService,
		new NullLogService(),
	);
	await session.initialize();
	session.selectApplication('cursor');
	await session.continueFromProfile();
	session.selectTarget({ kind: 'existing', profileId: 'work' });
	await session.continueFromTarget();
	assert.strictEqual(session.state.phase, 'review', 'the fixture session must reach Review');
	return session;
}

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

/** Review state at the manually observed import volume. */
function volumeReviewState(draft: EditorMigrationPlanDraft): EditorMigrationFlowState {
	return presentationState({
		phase: 'review',
		draft,
		selectedCategories: ['settings', 'keybindings', 'snippets', 'extensions'],
		decisions: Object.fromEntries(draft.decisions.filter(decision => decision.kind === 'conflict').map(decision => [decision.id, decision.defaultChoice])),
	});
}

/**
 * 237 settings, 171 shortcuts, 2 snippets, 116 extensions; 214 settings and 77 extensions
 * planned; 23 settings and 39 extensions held back; 3 conflicts and 6 pre-release fallbacks.
 */
function volumeDraft(): EditorMigrationPlanDraft {
	const conflictValues: readonly [string, number | string, number | string][] = [
		['editor.fontSize', 13, 14],
		['files.autoSave', 'off', 'afterDelay'],
		['workbench.colorTheme', 'Dark+', 'Tokyo Night'],
	];
	const decisions: EditorMigrationDraftDecision[] = [
		...conflictValues.map(([item, target, sourceValue]): EditorMigrationDraftDecision => ({
			id: `settings:${item}`, category: 'settings', item, kind: 'conflict', defaultChoice: 'preserveTarget', source: sourceValue, target,
		})),
		...Array.from({ length: 211 }, (_, index): EditorMigrationDraftDecision => ({
			id: `settings:settings.new-${index}`, category: 'settings', item: `settings.new-${index}`, kind: 'add', defaultChoice: 'import', source: index,
		})),
		...Array.from({ length: 170 }, (_, index): EditorMigrationDraftDecision => ({
			id: `keybindings:add-${index}`, category: 'keybindings', item: `ctrl+k ${index}`, kind: 'add', defaultChoice: 'import', source: { key: `ctrl+k ${index}`, command: `command.${index}` },
		})),
		...Array.from({ length: 2 }, (_, index): EditorMigrationDraftDecision => ({
			id: `snippets:add-${index}`, category: 'snippets', item: `snippet-${index}.json`, kind: 'add', defaultChoice: 'import', source: { name: `snippet-${index}.json`, contents: '{}', contentHash: `hash-${index}` },
		})),
		...Array.from({ length: 77 }, (_, index): EditorMigrationDraftDecision => ({
			id: `extensions:publisher.extension-${index}`, category: 'extensions', item: `publisher.extension-${index}`, kind: 'add', defaultChoice: 'import',
			source: { id: `publisher.extension-${index}`, requestedChannel: 'stable', status: 'available', version: `1.0.${index}`, targetPlatform: 'linux-x64', selectedChannel: 'stable', engine: '*', galleryIdentity: 'open-vsx' },
		})),
	];
	const exclusions: EditorMigrationDraftExclusion[] = [
		...Array.from({ length: 23 }, (_, index): EditorMigrationDraftExclusion => ({ category: 'settings', item: `machine.secret-${index}`, reason: 'machineSpecific' })),
		...Array.from({ length: 24 }, (_, index): EditorMigrationDraftExclusion => ({ category: 'extensions', item: `publisher.missing-${index}`, reason: 'galleryUnavailable' })),
		...Array.from({ length: 15 }, (_, index): EditorMigrationDraftExclusion => ({ category: 'extensions', item: `publisher.installed-${index}`, reason: 'alreadyInstalled' })),
	];
	const warnings: EditorMigrationPlanWarning[] = [
		{ code: 'defaultProfileBacksOmni' },
		...Array.from({ length: 6 }, (_, index): EditorMigrationPlanWarning => ({ code: 'preReleaseFellBackToStable', item: `publisher.extension-${index}` })),
	];
	const sourceSnapshot: EditorMigrationSourceSnapshot = {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: 'cursor-default' },
		adapter: { id: 'cursor', productName: 'Cursor', channel: 'stable', order: 2 },
		profile: { id: 'cursor-default', name: 'Default', kind: 'default' },
		categories: [
			{ category: 'settings', state: 'present', value: Object.fromEntries(Array.from({ length: 237 }, (_, index) => [`setting-${index}`, index])) },
			{ category: 'keybindings', state: 'present', value: Array.from({ length: 171 }, (_, index) => ({ key: `ctrl+k ${index}`, command: `command.${index}` })) },
			{ category: 'snippets', state: 'present', value: Array.from({ length: 2 }, (_, index) => ({ name: `snippet-${index}.json`, contents: '{}', contentHash: `hash-${index}` })) },
			{ category: 'extensions', state: 'present', value: Array.from({ length: 116 }, (_, index) => ({ id: `publisher.extension-${index}`, version: `1.0.${index}` })) },
		],
		diagnostics: [],
		fingerprint: { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, algorithm: 'sha256', categories: ['settings'], entries: [], value: 'fingerprint' },
	};
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
				{ category: 'settings', ownership: 'default', ownerProfileId: 'default', state: 'present', value: { 'editor.fontSize': 13 } },
				{ category: 'keybindings', ownership: 'target', ownerProfileId: 'work', state: 'present', value: [] },
				{ category: 'snippets', ownership: 'target', ownerProfileId: 'work', state: 'present', value: [] },
				{ category: 'extensions', ownership: 'target', ownerProfileId: 'work', state: 'present', value: [] },
			],
			environment: { targetPlatform: 'linux-x64', productVersion: '1.135.0', hucodeVersion: '0.0.78', galleryIdentity: 'open-vsx', policyVersion: 1 },
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

function reviewedPlanFrom(draft: EditorMigrationPlanDraft, selectedCategories: readonly ('settings' | 'keybindings' | 'snippets' | 'extensions')[]): EditorMigrationReviewedPlan {
	return {
		...draft,
		choices: {
			selectedCategories,
			decisions: draft.decisions.filter(decision => decision.kind === 'conflict').map(decision => ({ id: decision.id, choice: 'preserveTarget' as const })),
		},
		operations: draft.decisions
			.filter(decision => decision.category === 'extensions' && selectedCategories.includes('extensions'))
			.map(decision => ({
				id: decision.id,
				category: 'extensions' as const,
				kind: 'installExtension' as const,
				item: decision.item,
				source: decision.source as Extract<EditorMigrationReviewedPlan['operations'][number], { readonly kind: 'installExtension' }>['source'],
			})),
		exclusions: draft.exclusions,
		fingerprints: { source: 'source', target: 'target', choices: 'choices', policy: 'policy', gallery: 'gallery', plan: 'plan' },
	};
}

/** A settled import whose reviewed plan records Extensions as deselected during Review. */
function partialCategoryOperation(draft: EditorMigrationPlanDraft): EditorMigrationOperation {
	const plan = reviewedPlanFrom(draft, ['settings', 'keybindings', 'snippets']);
	return {
		id: 'partial-category-operation', stage: 'settled', aggregateOutcome: 'completed', plan, snapshots: [], extensionInstallIntents: [],
		results: [
			{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 },
			{ id: 'keybindings', category: 'keybindings', outcome: 'completed', attempts: 1 },
			{ id: 'snippets', category: 'snippets', outcome: 'completed', attempts: 1 },
		],
	} as unknown as EditorMigrationOperation;
}

/** A settled import with 75 extension installs, 2 failures and profile-scoped placement. */
function volumeOperation(): EditorMigrationOperation {
	const draft = volumeDraft();
	const plan = reviewedPlanFrom(draft, ['settings', 'keybindings', 'snippets', 'extensions']);
	const extensionOperations = plan.operations;
	const results: EditorMigrationItemResult[] = [
		{ id: 'settings', category: 'settings', outcome: 'completed', attempts: 1 },
		{ id: 'keybindings', category: 'keybindings', outcome: 'completed', attempts: 1 },
		{ id: 'snippets', category: 'snippets', outcome: 'completed', attempts: 1 },
		...extensionOperations.map((operation, index): EditorMigrationItemResult => index < 2
			? { id: operation.id, category: 'extensions', outcome: 'failed', attempts: 2, diagnostic: { code: 'extensionInstallFailed', message: 'install failed' } }
			: { id: operation.id, category: 'extensions', outcome: 'completed', attempts: 1 }),
	];
	return {
		id: 'operation', stage: 'settled', aggregateOutcome: 'completedWithIssues', plan, results, snapshots: [],
		extensionInstallIntents: extensionOperations.map(operation => ({ operationId: operation.id, applicationScoped: false })),
	} as unknown as EditorMigrationOperation;
}

function withAdapter(descriptor: EditorMigrationSourceDescriptor, id: string, productName: string, order: number): EditorMigrationSourceDescriptor {
	return { ...descriptor, adapter: { id: id as EditorMigrationSourceDescriptor['adapter']['id'], productName, channel: 'stable', order } };
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

function testParent(disposables: ReturnType<typeof ensureNoDisposablesAreLeakedInTestSuite>): HTMLElement {
	const parent = mainWindow.document.createElement('div');
	mainWindow.document.body.appendChild(parent);
	disposables.add({ dispose: () => parent.remove() });
	return parent;
}

function detailPane(parent: HTMLElement): HTMLElement {
	const detail = parent.getElementsByClassName('hucode-editor-migration-detail')[0];
	assert.ok(detail instanceof HTMLElement, 'expected a detail pane');
	return detail;
}

function footer(parent: HTMLElement): HTMLElement {
	const node = parent.getElementsByClassName('hucode-editor-migration-footer')[0];
	assert.ok(node instanceof HTMLElement, 'expected a persistent action footer');
	return node;
}

function sectionButtons(parent: HTMLElement): readonly HTMLElement[] {
	return [...parent.querySelectorAll<HTMLElement>('.hucode-editor-migration-index .hucode-editor-migration-section')];
}

function sectionLabels(parent: HTMLElement): readonly string[] {
	return sectionButtons(parent).map(button => button.getElementsByClassName('hucode-editor-migration-section-label')[0]?.textContent ?? '');
}

function sectionCounts(parent: HTMLElement): readonly string[] {
	return sectionButtons(parent).map(button => button.getElementsByClassName('hucode-editor-migration-section-count')[0]?.textContent ?? '');
}

function sectionsWithStatus(parent: HTMLElement, status: string): readonly string[] {
	return sectionButtons(parent).filter(button => button.classList.contains(status)).map(button => button.dataset.migrationSection ?? '');
}

function activeSection(parent: HTMLElement): string | undefined {
	return sectionButtons(parent).find(button => button.getAttribute('aria-current') === 'true')?.dataset.migrationSection;
}

function selectSection(parent: HTMLElement, id: string): void {
	const button = sectionButtons(parent).find(candidate => candidate.dataset.migrationSection === id);
	assert.ok(button, `expected a ${id} section`);
	button.dispatchEvent(domEvent('click'));
}

function buttonWithText(parent: HTMLElement, text: string): HTMLButtonElement {
	const button = [...parent.getElementsByTagName('button')].find(candidate => candidate.textContent === text || candidate.textContent?.includes(text));
	assert.ok(button, `expected a button labeled ${text}`);
	return button;
}

function includeCheckbox(parent: HTMLElement, label: string): HTMLInputElement {
	const input = [...detailPane(parent).getElementsByTagName('input')]
		.find(candidate => candidate.type === 'checkbox' && candidate.parentElement?.textContent?.includes(label));
	assert.ok(input, `expected an inclusion checkbox labeled ${label}`);
	return input;
}

function searchInputs(parent: HTMLElement): readonly HTMLInputElement[] {
	return [...parent.getElementsByTagName('input')].filter(input => input.type === 'search');
}

function inputWithLabel(parent: HTMLElement, label: string): HTMLInputElement {
	const input = [...parent.getElementsByTagName('input')].find(candidate => candidate.getAttribute('aria-label') === label);
	assert.ok(input, `expected input labeled ${label}`);
	return input;
}

function occurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

function domEvent(type: string): globalThis.Event {
	const event = mainWindow.document.createEvent('Event');
	event.initEvent(type, true, true);
	return event;
}

function keyboardEvent(key: string): KeyboardEvent {
	const keyCode = new Map<string, number>([
		['ArrowDown', 40],
		['End', 35],
		['Enter', 13],
		['Home', 36],
	]).get(key);
	assert.notStrictEqual(keyCode, undefined, `missing key code for ${key}`);
	const event = new mainWindow.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	Object.defineProperty(event, 'keyCode', { configurable: true, get: () => keyCode });
	return event;
}

// #endregion
