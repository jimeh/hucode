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

		const filter = [...parent.getElementsByTagName('input')].find(input => input.type === 'search');
		assert.ok(filter);
		filter.focus();
		filter.value = 'Profile 299';
		filter.dispatchEvent(domEvent('input'));

		const filteredInput = [...parent.getElementsByTagName('input')].find(input => input.type === 'search');
		const filteredRadios = [...parent.getElementsByTagName('input')].filter(input => input.type === 'radio');
		assert.strictEqual(mainWindow.document.activeElement, filteredInput);
		assert.strictEqual(filteredRadios.length, 1);
		assert.match(filteredRadios[0].labels?.[0]?.textContent ?? '', /Profile 299/);
		filteredRadios[0].checked = true;
		filteredRadios[0].dispatchEvent(domEvent('change'));
		assert.strictEqual(session.state.selectedSourceRef?.value, 'profile-299');
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
		filteredButtons[0].dispatchEvent(domEvent('click'));
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
		assert.deepStrictEqual(renderedResultTexts(applyParent), expected);

		const operation = {
			id: 'operation',
			stage: 'settled',
			aggregateOutcome: 'completed',
			plan,
			results,
		} as EditorMigrationOperation;
		const resultsParent = testParent(disposables);
		disposables.add(new EditorMigrationFlowView(resultsParent, presentationSession(presentationState({ phase: 'results', operation })), () => { }));
		assert.deepStrictEqual(renderedResultTexts(resultsParent), expected);
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
		targets: [],
		selectedCategories: [],
		decisions: {},
		publishers: [],
		reviewNeedsRebuild: false,
		...overrides,
	};
}

function renderedResultTexts(parent: HTMLElement): readonly string[] {
	const list = parent.getElementsByClassName('hucode-editor-migration-results')[0];
	assert.ok(list);
	return [...list.getElementsByTagName('li')].map(item => item.textContent ?? '');
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
