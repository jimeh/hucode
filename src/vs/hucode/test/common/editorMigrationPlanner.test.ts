/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, EditorMigrationCategory, EditorMigrationCategorySnapshot, EditorMigrationJsonValue, EditorMigrationSourceSnapshot } from '../../common/migration/editorMigrationSource.js';
import { effectiveEditorMigrationExtensions, parseEditorMigrationExtensionManifest } from '../../common/migration/editorMigrationExtensionManifest.js';
import {
	EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
	EDITOR_MIGRATION_POLICY_VERSION,
	EditorMigrationPlanChoices,
	EditorMigrationPlanningEvidence,
	EditorMigrationTargetCategorySnapshot,
	EditorMigrationTargetSnapshot,
} from '../../common/migration/editorMigrationPlanning.js';
import { canonicalizeEditorMigrationValue, fingerprintEditorMigrationValue } from '../../common/migration/editorMigrationPlanningCanonical.js';
import { acceptEditorMigrationPlanDraft, createEditorMigrationPlanDraft, getEditorMigrationSettingExclusion } from '../../common/migration/editorMigrationPlanner.js';

suite('EditorMigrationPlanner', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses published SHA-256 vectors and canonical object ordering', async () => {
		assert.strictEqual(canonicalizeEditorMigrationValue({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
		assert.strictEqual(canonicalizeEditorMigrationValue({ '\u{10000}': 1, '\uE000': 2 }), '{"\uE000":2,"\u{10000}":1}');
		assert.strictEqual(canonicalizeEditorMigrationValue({ present: true, omitted: undefined }), '{"present":true}');
		assert.strictEqual(await fingerprintEditorMigrationValue('abc'), '6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25');
		assert.strictEqual(await fingerprintEditorMigrationValue({ b: 2, a: 1 }), await fingerprintEditorMigrationValue({ a: 1, b: 2 }));
		for (const invalid of [[undefined], { value: () => undefined }, { value: Symbol('invalid') }, { value: BigInt(1) }]) {
			assert.throws(() => canonicalizeEditorMigrationValue(invalid), /canonical JSON/);
		}
	});

	test('drafts and freezes real-shaped source snapshots with undefined optional properties', () => {
		const fixture = source();
		const realShapedSource = {
			...fixture,
			categories: fixture.categories.map(category => {
				if (category.category === 'snippets') {
					return { ...category, state: 'absent' as const, value: undefined };
				}
				if (category.category === 'extensions') {
					return {
						...category,
						value: category.value?.map(extension => ({
							...extension,
							uuid: undefined,
							preRelease: extension.preRelease,
							hasPreReleaseVersion: undefined,
						})),
					};
				}
				return category;
			}),
		} satisfies EditorMigrationSourceSnapshot;

		const draft = createEditorMigrationPlanDraft(realShapedSource, target(), evidence());

		assert.ok(Object.isFrozen(draft));
		assert.ok(Object.isFrozen(draft.source));
		assert.strictEqual(Object.keys(draft.source.categories.find(category => category.category === 'snippets')!).includes('value'), false);
		const extension = draft.source.categories.find(category => category.category === 'extensions')?.value?.[0];
		assert.strictEqual(extension && Object.keys(extension).includes('uuid'), false);
		assert.strictEqual(extension && Object.keys(extension).includes('hasPreReleaseVersion'), false);
	});

	test('assigns every static and registry settings exclusion reason', () => {
		assert.strictEqual(getEditorMigrationSettingExclusion('terminal.integrated.defaultProfile.linux', []), 'machineSpecific');
		assert.strictEqual(getEditorMigrationSettingExclusion('github.copilot.enable', []), 'accountOrAuthentication');
		assert.strictEqual(getEditorMigrationSettingExclusion('telemetry.telemetryLevel', []), 'telemetryIdentity');
		assert.strictEqual(getEditorMigrationSettingExclusion('update.mode', []), 'updateChannel');
		assert.strictEqual(getEditorMigrationSettingExclusion('remote.SSH.remotePlatform', []), 'remoteAuthority');
		assert.strictEqual(getEditorMigrationSettingExclusion('http.proxy', []), 'applicationPath');
		assert.strictEqual(getEditorMigrationSettingExclusion('cursor.secret', []), 'sourceProductIntegration');
		assert.strictEqual(getEditorMigrationSettingExclusion('hucode.omni.enabled', []), undefined);
		assert.strictEqual(getEditorMigrationSettingExclusion('custom.secret', ['custom.secret']), 'registryIgnored');
		assert.strictEqual(getEditorMigrationSettingExclusion('editor.fontSize', []), undefined);
	});

	test('imports Hucode settings while preserving conflicts and respecting registry exclusions', async () => {
		const workbench = 'hucode.omni.workbenchItemLayout';
		const worktree = 'hucode.omni.worktreeItemLayout';
		const ignored = 'hucode.privateSetting';
		const draft = createEditorMigrationPlanDraft(
			source({ settings: { [workbench]: 'compact', [worktree]: 'compact', [ignored]: true, 'cursor.secret': true } }),
			target({ requestedCategories: ['settings'], settings: { [worktree]: 'comfortable' } }),
			{ ...evidence(), registryIgnoredSettings: [ignored] },
		);
		assert.deepStrictEqual(draft.decisions.map(item => [item.item, item.kind, item.defaultChoice]), [
			[workbench, 'add', 'import'], [worktree, 'conflict', 'preserveTarget'],
		]);
		assert.deepStrictEqual(draft.exclusions.map(item => [item.item, item.reason]), [
			['cursor.secret', 'sourceProductIntegration'], [ignored, 'registryIgnored'],
		]);
		const plan = await acceptEditorMigrationPlanDraft(draft, choose(draft, {}, ['settings']));
		assert.deepStrictEqual(plan.operations.map(item => item.item), [workbench]);
		const replaced = await acceptEditorMigrationPlanDraft(draft, choose(draft, { [`settings:${worktree}`]: 'import' }, ['settings']));
		assert.deepStrictEqual(replaced.operations.map(item => item.item), [workbench, worktree]);
	});

	test('plans independent preserve-by-default settings, keybindings, snippets, and extensions', async () => {
		const draft = createEditorMigrationPlanDraft(source(), target(), evidence());
		assert.deepStrictEqual(draft.decisions.map(decision => [decision.category, decision.item, decision.defaultChoice]), [
			['settings', 'editor.fontSize', 'preserveTarget'],
			['settings', 'editor.wordWrap', 'import'],
			['keybindings', '{"args":null,"command":"source.command","key":"ctrl+k","when":"editorTextFocus"}', 'preserveTarget'],
			['snippets', 'typescript.json', 'preserveTarget'],
			['extensions', 'pub.available', 'import'],
		]);
		assert.deepStrictEqual(draft.exclusions.map(exclusion => [exclusion.item, exclusion.reason]), [
			['pub.installed', 'alreadyInstalled'],
			['pub.missing', 'galleryUnavailable'],
			['vscode.git', 'sourceProductIntegration'],
			['cursor.secret', 'sourceProductIntegration'],
		]);
		assert.deepStrictEqual(draft.prerequisites.map(item => item.category), ['settings']);
		assert.ok(draft.warnings.some(warning => warning.code === 'preReleaseFellBackToStable'));

		const choices = choose(draft, {
			'settings:editor.fontSize': 'preserveTarget',
		}, ['settings', 'extensions']);
		const plan = await acceptEditorMigrationPlanDraft(draft, { ...choices, selectedCategories: ['settings', 'extensions'] });
		assert.deepStrictEqual(plan.operations.map(operation => [operation.category, operation.item]), [
			['settings', 'editor.wordWrap'],
			['extensions', 'pub.available'],
		]);
		assert.deepStrictEqual(plan.prerequisites.map(item => item.category), ['settings']);
		assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.operations) && Object.isFrozen(plan.source));
	});

	test('ignores every unrequested source category in draft and reviewed fingerprints', async () => {
		const settingsTarget = target({ requestedCategories: ['settings'] });
		const firstDraft = createEditorMigrationPlanDraft(source(), settingsTarget, evidence());
		const changedUnrequestedSource = source({
			keybindings: [{ key: 'ctrl+shift+9', command: 'different.command' }],
			snippets: [{ name: 'different.code-snippets', contents: { Different: { prefix: 'different' } }, contentHash: 'different-snippet' }],
			extensions: [{ id: 'different.extension', version: '9.9.9' }],
		});
		const secondDraft = createEditorMigrationPlanDraft(changedUnrequestedSource, settingsTarget, evidence(
			{ 'ctrl+shift+9': 'ctrl+shift+0' },
			[{ id: 'different.extension', requestedChannel: 'stable', status: 'unavailable' }],
		));
		const draftContents = (draft: typeof firstDraft) => ({
			decisions: draft.decisions,
			exclusions: draft.exclusions,
			prerequisites: draft.prerequisites,
			warnings: draft.warnings,
			draftFingerprintSeed: draft.draftFingerprintSeed,
		});

		assert.strictEqual(canonicalizeEditorMigrationValue(draftContents(firstDraft)), canonicalizeEditorMigrationValue(draftContents(secondDraft)));
		assert.ok(firstDraft.decisions.every(decision => decision.category === 'settings'));
		assert.ok(firstDraft.exclusions.every(exclusion => exclusion.category === 'settings'));
		const firstPlan = await acceptEditorMigrationPlanDraft(firstDraft, choose(firstDraft, {}, ['settings']));
		const secondPlan = await acceptEditorMigrationPlanDraft(secondDraft, choose(secondDraft, {}, ['settings']));
		assert.strictEqual(firstPlan.fingerprints.plan, secondPlan.fingerprints.plan);
	});

	test('normalizes key and context identity, deduplicates removals, and preserves target order metadata', () => {
		const sourceSnapshot = source({
			keybindings: [
				{ key: 'CTRL+K', command: 'source.command', when: 'editorTextFocus && resourceLangId == typescript', args: { b: 2, a: 1 } },
				{ key: 'ctrl+x', command: '-target.command', when: 'editorTextFocus' },
				{ key: 'ctrl+x', command: '-target.command', when: 'editorTextFocus' },
			],
		});
		const targetSnapshot = target({
			keybindings: [
				{ key: 'ctrl+k', command: 'target.command', when: 'editorTextFocus && resourceLangId == typescript', args: { a: 1 } },
				{ key: 'ctrl+y', command: 'unrelated.command' },
			],
		});
		const draft = createEditorMigrationPlanDraft(sourceSnapshot, targetSnapshot, evidence({ 'CTRL+K': 'ctrl+k' }));
		const keybindings = draft.decisions.filter(decision => decision.category === 'keybindings');
		assert.strictEqual(keybindings.length, 2);
		assert.deepStrictEqual(keybindings.map(decision => decision.kind).sort(), ['add', 'conflict']);
		assert.strictEqual(keybindings.find(decision => decision.kind === 'conflict')?.relatedTargetIds?.length, 1);
	});

	test('classifies built-in, installed, incompatible, unavailable, and source integrations exactly once', () => {
		const classifiedSource = source({
			extensions: [
				...sourceCategory(source(), 'extensions'),
				{ id: 'pub.builtin', version: '1.0.0' },
				{ id: 'pub.incompatible', version: '1.0.0' },
			]
		});
		const draft = createEditorMigrationPlanDraft(classifiedSource, target({ builtIns: [{ id: 'pub.builtin', version: '1.0.0' }] }), evidence(undefined, [
			{ id: 'pub.available', requestedChannel: 'preRelease', status: 'available', version: '2.0.0', targetPlatform: 'linux-x64', selectedChannel: 'stable', engine: '^1.100.0', galleryIdentity: 'open-vsx' },
			{ id: 'pub.incompatible', requestedChannel: 'stable', status: 'incompatible' },
			{ id: 'pub.missing', requestedChannel: 'stable', status: 'unavailable' },
		]));
		assert.deepStrictEqual(draft.exclusions.filter(item => item.category === 'extensions').map(item => [item.item, item.reason]), [
			['pub.builtin', 'builtIn'],
			['pub.incompatible', 'galleryIncompatible'],
			['pub.installed', 'alreadyInstalled'],
			['pub.missing', 'galleryUnavailable'],
			['vscode.git', 'sourceProductIntegration'],
		]);
	});

	test('rejects stale, missing, unknown, and proposed-inheritance choices', async () => {
		const draft = createEditorMigrationPlanDraft(source(), target(), evidence());
		await assert.rejects(() => acceptEditorMigrationPlanDraft(draft, { selectedCategories: ['settings'], decisions: [] }), /every selected conflict decision/);
		await assert.rejects(() => acceptEditorMigrationPlanDraft(draft, {
			selectedCategories: ['settings'],
			decisions: [...choose(draft, {}, ['settings']).decisions, { id: 'unknown', choice: 'import' }],
		}), /Unknown or duplicate/);
		const proposed = target({
			selection: { kind: 'proposed', name: 'New', options: { useDefaultFlags: { settings: true } } },
			nameAvailable: true,
		});
		const proposedDraft = createEditorMigrationPlanDraft(source(), proposed, evidence());
		await assert.rejects(() => acceptEditorMigrationPlanDraft(proposedDraft, choose(proposedDraft)), /inherits selected category/);
	});

	test('parses current and legacy extension manifests without retaining mutable metadata', () => {
		const metadataUuid = '11111111-1111-4111-8111-111111111111';
		const identifierUuid = '22222222-2222-4222-8222-222222222222';
		const parsed = parseEditorMigrationExtensionManifest(JSON.stringify({
			extensions: [
				{ identifier: { id: 'Pub.One', uuid: identifierUuid }, version: '1.0.0', metadata: { id: metadataUuid, preRelease: true, isApplicationScoped: true }, location: { path: '/private' } },
				{ id: 'pub.two', version: '2.0.0', applicationScoped: false },
			]
		}));
		assert.deepStrictEqual(parsed, [
			{ id: 'pub.one', uuid: metadataUuid, version: '1.0.0', preRelease: true, applicationScoped: true },
			{ id: 'pub.two', version: '2.0.0', applicationScoped: false },
		]);
		assert.deepStrictEqual(effectiveEditorMigrationExtensions([parsed[1]], parsed), [parsed[0], parsed[1]]);
		assert.throws(() => parseEditorMigrationExtensionManifest('{'), /malformed JSON/);
		assert.throws(() => parseEditorMigrationExtensionManifest('[{"id":"bad","version":"1"}]'), /invalid identity/);
		assert.throws(() => parseEditorMigrationExtensionManifest('[{"id":"pub.bad","version":"1","metadata":{"id":"not-a-uuid"}}]'), /invalid UUID/);
	});

	test('selects duplicate extension versions with semver and deterministic codepoint fallback', () => {
		const entries = [
			{ id: 'pub.semver', version: '1.9.0' },
			{ id: 'pub.semver', version: '1.10.0' },
			{ id: 'pub.fallback', version: 'release-a' },
			{ id: 'pub.fallback', version: 'release-z' },
			{ id: 'pub.tie', version: '1.0.0', applicationScoped: false },
			{ id: 'pub.tie', version: '1.0.0', applicationScoped: true },
		];
		const parsed = parseEditorMigrationExtensionManifest(JSON.stringify(entries));
		const reversed = parseEditorMigrationExtensionManifest(JSON.stringify([...entries].reverse()));

		assert.deepStrictEqual(parsed.map(extension => [extension.id, extension.version]), [
			['pub.fallback', 'release-z'],
			['pub.semver', '1.10.0'],
			['pub.tie', '1.0.0'],
		]);
		assert.strictEqual(parsed.find(extension => extension.id === 'pub.tie')?.applicationScoped, true);
		assert.deepStrictEqual(reversed, parsed);
	});

	test('is deterministic under reversed fixture input and fingerprints single-field drift', async () => {
		const first = createEditorMigrationPlanDraft(source(), target(), evidence());
		const reordered = source({
			settings: Object.fromEntries(Object.entries(sourceCategory(source(), 'settings')).reverse()),
			extensions: [...sourceCategory(source(), 'extensions')].reverse(),
		});
		const reversedSource = { ...reordered, fingerprint: source().fingerprint };
		const second = createEditorMigrationPlanDraft(reversedSource, target(), evidence(undefined, [...evidence().gallery].reverse()));
		assert.strictEqual(canonicalizeEditorMigrationValue(first.decisions), canonicalizeEditorMigrationValue(second.decisions));
		const firstPlan = await acceptEditorMigrationPlanDraft(first, choose(first));
		const secondPlan = await acceptEditorMigrationPlanDraft(second, choose(second));
		assert.strictEqual(firstPlan.fingerprints.plan, secondPlan.fingerprints.plan);
		const changedPlan = await acceptEditorMigrationPlanDraft(createEditorMigrationPlanDraft(source({ settings: { ...sourceCategory(source(), 'settings'), 'editor.wordWrap': 'off' } }), target(), evidence()), choose(createEditorMigrationPlanDraft(source({ settings: { ...sourceCategory(source(), 'settings'), 'editor.wordWrap': 'off' } }), target(), evidence())));
		assert.notStrictEqual(firstPlan.fingerprints.plan, changedPlan.fingerprints.plan);
	});

	test('keeps unselected category evidence out of reviewed fingerprints', async () => {
		const firstDraft = createEditorMigrationPlanDraft(source(), target(), evidence());
		const firstPlan = await acceptEditorMigrationPlanDraft(firstDraft, choose(firstDraft, {}, ['settings']));
		const changedSource = source({ extensions: [{ id: 'different.extension', version: '9.9.9' }] });
		const changedTarget = target({
			builtIns: [{ id: 'different.builtin', version: '9.9.9' }],
		});
		const secondDraft = createEditorMigrationPlanDraft(changedSource, changedTarget, evidence(undefined, [{ id: 'different.extension', requestedChannel: 'stable', status: 'unavailable' }]));
		const secondPlan = await acceptEditorMigrationPlanDraft(secondDraft, choose(secondDraft, {}, ['settings']));

		assert.strictEqual(firstPlan.fingerprints.target, secondPlan.fingerprints.target);
		assert.strictEqual(firstPlan.fingerprints.policy, secondPlan.fingerprints.policy);
		assert.strictEqual(firstPlan.fingerprints.gallery, secondPlan.fingerprints.gallery);
		assert.strictEqual(firstPlan.fingerprints.plan, secondPlan.fingerprints.plan);
	});
});

function source(overrides: {
	readonly settings?: Record<string, EditorMigrationJsonValue>;
	readonly keybindings?: readonly Record<string, EditorMigrationJsonValue>[];
	readonly snippets?: readonly { readonly name: string; readonly contents: Record<string, EditorMigrationJsonValue>; readonly contentHash: string }[];
	readonly extensions?: readonly { readonly id: string; readonly version: string; readonly preRelease?: boolean }[];
} = {}): EditorMigrationSourceSnapshot {
	const categories: readonly EditorMigrationCategorySnapshot[] = [
		{ category: 'settings' as const, state: 'present' as const, value: overrides.settings ?? { 'editor.fontSize': 16, 'editor.wordWrap': 'on', 'cursor.secret': true } },
		{ category: 'keybindings' as const, state: 'present' as const, value: overrides.keybindings ?? [{ key: 'ctrl+k', command: 'source.command', when: 'editorTextFocus' }] },
		{ category: 'snippets' as const, state: 'present' as const, value: overrides.snippets ?? [{ name: 'typescript.json', contents: { Log: { prefix: 'log' } }, contentHash: 'source-snippet' }] },
		{
			category: 'extensions' as const, state: 'present' as const, value: overrides.extensions ?? [
				{ id: 'pub.available', version: '1.0.0', preRelease: true },
				{ id: 'pub.installed', version: '1.0.0' },
				{ id: 'pub.missing', version: '1.0.0' },
				{ id: 'vscode.git', version: '1.0.0' },
			]
		},
	];
	return {
		schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION,
		ref: { value: 'source-v1:fixture' },
		adapter: { id: 'vscode', productName: 'Visual Studio Code', channel: 'stable', order: 0 },
		profile: { id: 'default', name: 'Default', kind: 'default' },
		categories,
		diagnostics: [],
		fingerprint: { schemaVersion: EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION, algorithm: 'sha256', categories: categories.map(item => item.category), entries: [], value: `source-${canonicalizeEditorMigrationValue(categories)}` },
	};
}

function target(overrides: Omit<Partial<EditorMigrationTargetSnapshot>, 'categories'> & {
	readonly settings?: Record<string, EditorMigrationJsonValue>;
	readonly keybindings?: readonly Record<string, EditorMigrationJsonValue>[];
	readonly snippets?: readonly { readonly name: string; readonly contents: Record<string, EditorMigrationJsonValue>; readonly contentHash: string }[];
} = {}): EditorMigrationTargetSnapshot {
	const categories: readonly EditorMigrationTargetCategorySnapshot[] = [
		{ category: 'settings' as const, ownership: 'default' as const, ownerProfileId: 'default', state: 'present' as const, contentHash: 'settings-target', value: overrides.settings ?? { 'editor.fontSize': 14 } },
		{ category: 'keybindings' as const, ownership: 'target' as const, ownerProfileId: 'work', state: 'present' as const, contentHash: 'keybindings-target', value: overrides.keybindings ?? [{ key: 'ctrl+k', command: 'target.command', when: 'editorTextFocus' }] },
		{ category: 'snippets' as const, ownership: 'target' as const, ownerProfileId: 'work', state: 'present' as const, contentHash: 'snippets-target', value: overrides.snippets ?? [{ name: 'typescript.json', contents: { Log: { prefix: 'target' } }, contentHash: 'target-snippet' }] },
		{ category: 'extensions' as const, ownership: 'target' as const, ownerProfileId: 'work', state: 'present' as const, contentHash: 'manifest-raw', semanticHash: 'manifest-semantic', value: [{ id: 'pub.installed', version: '9.0.0', applicationScoped: false }] },
	];
	const { settings: _settings, keybindings: _keybindings, snippets: _snippets, profile: profileOverride, ...snapshotOverrides } = overrides;
	const selection = snapshotOverrides.selection ?? { kind: 'existing', profileId: 'work' };
	return {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		selection,
		...(selection.kind === 'existing' ? { profile: profileOverride ?? { id: 'work', name: 'Work', kind: 'named' as const } } : {}),
		eligible: true,
		catalogFingerprint: 'catalog',
		requestedCategories: ['settings', 'keybindings', 'snippets', 'extensions'],
		categories,
		environment: { targetPlatform: 'linux-x64', productVersion: '1.100.0', hucodeVersion: '0.0.1', galleryIdentity: 'open-vsx', policyVersion: EDITOR_MIGRATION_POLICY_VERSION },
		builtIns: [],
		fingerprint: 'target',
		...snapshotOverrides,
	};
}

function evidence(normalizedKeys: Record<string, string> = {}, gallery = defaultGallery()): EditorMigrationPlanningEvidence {
	return { registryIgnoredSettings: [], normalizedKeys, keybindingPlatform: 'linux', gallery };
}

function defaultGallery(): EditorMigrationPlanningEvidence['gallery'] {
	return [
		{ id: 'pub.available', requestedChannel: 'preRelease', status: 'available', version: '2.0.0', targetPlatform: 'linux-x64', selectedChannel: 'stable', engine: '^1.100.0', galleryIdentity: 'open-vsx' },
		{ id: 'pub.missing', requestedChannel: 'stable', status: 'unavailable' },
	];
}

function choose(
	draft: ReturnType<typeof createEditorMigrationPlanDraft>,
	overrides: Record<string, 'import' | 'preserveTarget'> = {},
	selectedCategories: readonly EditorMigrationCategory[] = draft.target.requestedCategories,
): EditorMigrationPlanChoices {
	return {
		selectedCategories: [...selectedCategories],
		decisions: draft.decisions.filter(decision => decision.kind === 'conflict' && selectedCategories.includes(decision.category)).map(decision => ({ id: decision.id, choice: overrides[decision.id] ?? decision.defaultChoice })),
	};
}

function sourceCategory<T extends EditorMigrationCategory>(snapshot: EditorMigrationSourceSnapshot, category: T): NonNullable<Extract<(typeof snapshot.categories)[number], { category: T }>['value']> {
	return snapshot.categories.find(item => item.category === category)!.value as never;
}
