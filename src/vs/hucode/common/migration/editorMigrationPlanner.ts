/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { EditorMigrationCategory, EditorMigrationCategorySnapshot, EditorMigrationExtension, EditorMigrationJsonValue, EditorMigrationSourceSnapshot } from './editorMigrationSource.js';
import {
	EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
	EditorMigrationDraftDecision,
	EditorMigrationDraftExclusion,
	EditorMigrationExclusionReason,
	EditorMigrationGalleryResult,
	EditorMigrationMaterializationPrerequisite,
	EditorMigrationPlanChoices,
	EditorMigrationPlanDraft,
	EditorMigrationPlanOperation,
	EditorMigrationPlanningError,
	EditorMigrationPlanningEvidence,
	EditorMigrationPlanWarning,
	EditorMigrationReviewedPlan,
	EditorMigrationTargetCategorySnapshot,
	EditorMigrationTargetSnapshot,
} from './editorMigrationPlanning.js';
import { canonicalizeEditorMigrationValue, compareEditorMigrationCodePoints as compare, fingerprintEditorMigrationValue, immutableEditorMigrationValue } from './editorMigrationPlanningCanonical.js';

const STATIC_SETTING_EXCLUSIONS: readonly [RegExp, EditorMigrationExclusionReason][] = [
	[/^(?:window\.nativeTabs|terminal\.integrated\.(?:defaultProfile|profiles))/, 'machineSpecific'],
	[/^(?:github|microsoft|authentication|accounts)\./, 'accountOrAuthentication'],
	[/^(?:telemetry\.|workbench\.settings\.enableNaturalLanguageSearch)/, 'telemetryIdentity'],
	[/^(?:update\.|extensions\.autoUpdate|extensions\.autoCheckUpdates)/, 'updateChannel'],
	[/^(?:remote\.|security\.workspace\.trust\.untrustedFiles)/, 'remoteAuthority'],
	[/^(?:application\.|http\.proxy|terminal\.integrated\.cwd)/, 'applicationPath'],
	[/^(?:hucode\.|cursor\.|workbench\.welcomePage\.experimentalOnboarding)/, 'sourceProductIntegration'],
];

const SOURCE_EXTENSION_PREFIXES = ['vscode.', 'cursor.', 'anysphere.'];

/** Whether an extension belongs to a supported source editor rather than user setup. */
export function isEditorMigrationSourceIntegrationExtension(id: string): boolean {
	const normalized = normalizeExtensionId(id);
	return SOURCE_EXTENSION_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/** Returns the stable exclusion reason for a setting, if policy excludes it. */
export function getEditorMigrationSettingExclusion(key: string, registryIgnoredSettings: readonly string[]): EditorMigrationExclusionReason | undefined {
	return STATIC_SETTING_EXCLUSIONS.find(([pattern]) => pattern.test(key))?.[1]
		?? (registryIgnoredSettings.includes(key) ? 'registryIgnored' : undefined);
}

/** Builds the pure preserve-by-default review draft. */
export function createEditorMigrationPlanDraft(
	source: EditorMigrationSourceSnapshot,
	target: EditorMigrationTargetSnapshot,
	evidence: EditorMigrationPlanningEvidence,
): EditorMigrationPlanDraft {
	const requestedCategories = normalizeCategories(target.requestedCategories);
	validateInputs(source, target, evidence, requestedCategories);
	const normalizedEvidence = normalizeEvidence(evidence, requestedCategories);
	const decisions: EditorMigrationDraftDecision[] = [];
	const exclusions: EditorMigrationDraftExclusion[] = [];
	const warnings: EditorMigrationPlanWarning[] = [];

	if (requestedCategories.includes('settings')) {
		planSettings(source, target, normalizedEvidence, decisions, exclusions, warnings);
	}
	if (requestedCategories.includes('keybindings')) {
		planKeybindings(source, target, normalizedEvidence, decisions);
	}
	if (requestedCategories.includes('snippets')) {
		planSnippets(source, target, decisions);
	}
	if (requestedCategories.includes('extensions')) {
		planExtensions(source, target, normalizedEvidence, decisions, exclusions, warnings);
	}

	const prerequisites = target.categories
		.filter(category => requestedCategories.includes(category.category) && category.ownership === 'default')
		.map<EditorMigrationMaterializationPrerequisite>(category => ({
			kind: 'materializeInheritedResource',
			category: category.category,
			ownerProfileId: category.ownerProfileId!,
			baselineFingerprint: category.semanticHash ?? category.contentHash ?? canonicalizeEditorMigrationValue(category.value ?? null),
		}));
	if (target.profile?.kind === 'default' && target.requestedCategories.some(category => category === 'settings' || category === 'keybindings')) {
		warnings.push({ code: 'defaultProfileBacksOmni' });
	}

	const draft = {
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		source,
		target,
		evidence: normalizedEvidence,
		decisions: sortDecisions(decisions),
		exclusions: sortByCategoryAndItem(exclusions),
		prerequisites: prerequisites.sort((a, b) => compare(a.category, b.category)),
		warnings: warnings.sort((a, b) => compare(`${a.code}:${a.item ?? ''}`, `${b.code}:${b.item ?? ''}`)),
		draftFingerprintSeed: canonicalizeEditorMigrationValue({
			source: editorMigrationSourceEvidence(source, requestedCategories),
			target: editorMigrationTargetEvidence(target, requestedCategories),
			policy: editorMigrationPolicyEvidence(normalizedEvidence, target.environment.policyVersion, requestedCategories),
			gallery: editorMigrationGalleryEvidence(normalizedEvidence, requestedCategories),
		}),
	} satisfies EditorMigrationPlanDraft;
	return immutableEditorMigrationValue(draft);
}

/** Validates choices and produces a deeply immutable reviewed plan. */
export async function acceptEditorMigrationPlanDraft(draft: EditorMigrationPlanDraft, choices: EditorMigrationPlanChoices): Promise<EditorMigrationReviewedPlan> {
	const selectedCategories = normalizeCategories(choices.selectedCategories);
	if (selectedCategories.length === 0 || selectedCategories.some(category => !draft.target.requestedCategories.includes(category))) {
		throw new EditorMigrationPlanningError('invalidChoices', 'A reviewed plan must select requested migration categories');
	}
	if (draft.target.selection.kind === 'proposed') {
		for (const category of selectedCategories) {
			if (draft.target.selection.options?.useDefaultFlags?.[category]) {
				throw new EditorMigrationPlanningError('selectedCategoryInheritedByProposedTarget', `Proposed target inherits selected category '${category}'`);
			}
		}
	}

	const expectedIds = draft.decisions
		.filter(decision => decision.kind === 'conflict' && selectedCategories.includes(decision.category))
		.map(decision => decision.id);
	const choiceMap = new Map<string, 'import' | 'preserveTarget'>();
	for (const decision of choices.decisions) {
		if (!expectedIds.includes(decision.id) || choiceMap.has(decision.id)) {
			throw new EditorMigrationPlanningError('invalidChoices', `Unknown or duplicate planning choice '${decision.id}'`);
		}
		choiceMap.set(decision.id, decision.choice);
	}
	if (choiceMap.size !== expectedIds.length) {
		throw new EditorMigrationPlanningError('invalidChoices', 'Choices must name every selected conflict decision');
	}

	const normalizedChoices: EditorMigrationPlanChoices = {
		selectedCategories,
		decisions: [...choiceMap].sort(([a], [b]) => compare(a, b)).map(([id, choice]) => ({ id, choice })),
	};
	const operations = draft.decisions
		.filter(decision => selectedCategories.includes(decision.category) && (decision.kind === 'add' || choiceMap.get(decision.id) === 'import'))
		.map(toOperation);
	const prerequisites = draft.prerequisites.filter(item => selectedCategories.includes(item.category));
	const policyInput = editorMigrationPolicyEvidence(draft.evidence, draft.target.environment.policyVersion, selectedCategories);
	const galleryInput = editorMigrationGalleryEvidence(draft.evidence, selectedCategories);
	const fingerprints = {
		source: await fingerprintEditorMigrationValue(editorMigrationSourceEvidence(draft.source, selectedCategories)),
		target: await fingerprintEditorMigrationValue(editorMigrationTargetEvidence(draft.target, selectedCategories)),
		choices: await fingerprintEditorMigrationValue(normalizedChoices),
		policy: await fingerprintEditorMigrationValue(policyInput),
		gallery: await fingerprintEditorMigrationValue(galleryInput),
		plan: '',
	};
	fingerprints.plan = await fingerprintEditorMigrationValue({
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		fingerprints: {
			source: fingerprints.source,
			target: fingerprints.target,
			choices: fingerprints.choices,
			policy: fingerprints.policy,
			gallery: fingerprints.gallery,
		},
		operations,
		prerequisites,
	});

	return immutableEditorMigrationValue({
		schemaVersion: EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION,
		source: draft.source,
		target: draft.target,
		evidence: draft.evidence,
		choices: normalizedChoices,
		operations,
		exclusions: draft.exclusions,
		prerequisites,
		warnings: draft.warnings,
		fingerprints,
	});
}

/** Canonical source evidence restricted to accepted categories. */
export function editorMigrationSourceEvidence(source: EditorMigrationSourceSnapshot, categories: readonly EditorMigrationCategory[]): unknown {
	return {
		ref: source.ref,
		profile: source.profile,
		categories: normalizeCategories(categories),
		entries: source.fingerprint.entries.filter(entry => entry.category === 'profileCatalog' || categories.includes(entry.category)),
	};
}

/** Canonical target evidence restricted to accepted categories. */
export function editorMigrationTargetEvidence(target: EditorMigrationTargetSnapshot, categories: readonly EditorMigrationCategory[]): unknown {
	return {
		selection: target.selection,
		profile: target.profile ?? null,
		nameAvailable: target.nameAvailable ?? null,
		catalogFingerprint: target.catalogFingerprint,
		categories: target.categories.filter(category => categories.includes(category.category)).map(category => ({
			category: category.category,
			ownership: category.ownership,
			ownerProfileId: category.ownerProfileId ?? null,
			state: category.state,
			contentHash: (category.category === 'extensions' ? category.semanticHash : category.contentHash) ?? null,
		})),
		environment: target.environment,
		builtIns: categories.includes('extensions') ? target.builtIns : [],
	};
}

/** Canonical policy evidence restricted to accepted categories. */
export function editorMigrationPolicyEvidence(evidence: EditorMigrationPlanningEvidence, policyVersion: number, categories: readonly EditorMigrationCategory[]): unknown {
	return {
		version: policyVersion,
		registryIgnoredSettings: categories.includes('settings') ? evidence.registryIgnoredSettings : [],
		normalizedKeys: categories.includes('keybindings') ? evidence.normalizedKeys : {},
		keybindingPlatform: categories.includes('keybindings') ? evidence.keybindingPlatform : null,
	};
}

/** Canonical gallery evidence restricted to accepted extension planning. */
export function editorMigrationGalleryEvidence(evidence: EditorMigrationPlanningEvidence, categories: readonly EditorMigrationCategory[]): readonly EditorMigrationGalleryResult[] {
	return categories.includes('extensions') ? evidence.gallery : [];
}

function planSettings(
	source: EditorMigrationSourceSnapshot,
	target: EditorMigrationTargetSnapshot,
	evidence: EditorMigrationPlanningEvidence,
	decisions: EditorMigrationDraftDecision[],
	exclusions: EditorMigrationDraftExclusion[],
	warnings: EditorMigrationPlanWarning[],
): void {
	const sourceValue = sourceCategory(source, 'settings')?.value ?? {};
	const targetValue = targetCategory(target, 'settings')?.value ?? {};
	for (const key of Object.keys(sourceValue).sort(compare)) {
		const reason = getEditorMigrationSettingExclusion(key, evidence.registryIgnoredSettings);
		if (reason) {
			exclusions.push({ category: 'settings', item: key, reason });
			continue;
		}
		const sourceSetting = sourceValue[key];
		const targetSetting = targetValue[key];
		if (targetSetting !== undefined && equal(sourceSetting, targetSetting)) {
			continue;
		}
		decisions.push({
			id: `settings:${key}`,
			category: 'settings',
			item: key,
			kind: targetSetting === undefined ? 'add' : 'conflict',
			defaultChoice: targetSetting === undefined ? 'import' : 'preserveTarget',
			source: sourceSetting,
			...(targetSetting === undefined ? {} : { target: targetSetting }),
		});
		if (!evidence.registryIgnoredSettings.includes(key) && key.includes('.') && !isKnownCoreSetting(key)) {
			warnings.push({ code: 'unknownSettingSchema', item: key });
		}
	}
}

function planKeybindings(source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot, evidence: EditorMigrationPlanningEvidence, decisions: EditorMigrationDraftDecision[]): void {
	const sourceEntries = sourceCategory(source, 'keybindings')?.value ?? [];
	const targetEntries = targetCategory(target, 'keybindings')?.value ?? [];
	const targetRows = targetEntries.map((entry, index) => ({ ...normalizedKeybinding(entry, evidence), rowId: editorMigrationKeybindingRowId(entry, evidence, index) }));
	const seen = new Set<string>();
	for (const entry of sourceEntries) {
		const normalized = normalizedKeybinding(entry, evidence);
		if (seen.has(normalized.identity)) {
			continue;
		}
		seen.add(normalized.identity);
		if (targetRows.some(targetEntry => targetEntry.identity === normalized.identity)) {
			continue;
		}
		const conflicts = normalized.command.startsWith('-') ? [] : targetRows.filter(targetEntry =>
			!targetEntry.command.startsWith('-') && targetEntry.key === normalized.key && targetEntry.when === normalized.when
		);
		decisions.push({
			id: `keybindings:${normalized.identity}`,
			category: 'keybindings',
			item: normalized.identity,
			kind: conflicts.length ? 'conflict' : 'add',
			defaultChoice: conflicts.length ? 'preserveTarget' : 'import',
			source: entry,
			...(conflicts.length ? { target: conflicts[0].value, relatedTargetIds: conflicts.map(item => item.rowId) } : {}),
		});
	}
}

function planSnippets(source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot, decisions: EditorMigrationDraftDecision[]): void {
	const sourceEntries = sourceCategory(source, 'snippets')?.value ?? [];
	const targetEntries = targetCategory(target, 'snippets')?.value ?? [];
	const targets = new Map(targetEntries.map(entry => [normalizeSnippetName(entry.name, target.environment.targetPlatform), entry]));
	for (const snippet of [...sourceEntries].sort((a, b) => compare(normalizeSnippetName(a.name, target.environment.targetPlatform), normalizeSnippetName(b.name, target.environment.targetPlatform)))) {
		const normalizedName = normalizeSnippetName(snippet.name, target.environment.targetPlatform);
		const targetSnippet = targets.get(normalizedName);
		if (targetSnippet?.contentHash === snippet.contentHash) {
			continue;
		}
		decisions.push({
			id: `snippets:${normalizedName}:${snippet.contentHash}`,
			category: 'snippets',
			item: normalizedName,
			kind: targetSnippet ? 'conflict' : 'add',
			defaultChoice: targetSnippet ? 'preserveTarget' : 'import',
			source: { name: snippet.name, contents: snippet.contents, contentHash: snippet.contentHash },
			...(targetSnippet ? { target: { name: targetSnippet.name, contents: targetSnippet.contents, contentHash: targetSnippet.contentHash } } : {}),
		});
	}
}

function planExtensions(
	source: EditorMigrationSourceSnapshot,
	target: EditorMigrationTargetSnapshot,
	evidence: EditorMigrationPlanningEvidence,
	decisions: EditorMigrationDraftDecision[],
	exclusions: EditorMigrationDraftExclusion[],
	warnings: EditorMigrationPlanWarning[],
): void {
	const sourceEntries = sourceCategory(source, 'extensions')?.value ?? [];
	const installed = new Set((targetCategory(target, 'extensions')?.value ?? []).map(extension => normalizeExtensionId(extension.id)));
	const builtIns = new Set(target.builtIns.map(extension => normalizeExtensionId(extension.id)));
	const gallery = new Map(evidence.gallery.map(item => [normalizeExtensionId(item.id), item]));
	for (const extension of deduplicateExtensions(sourceEntries)) {
		const id = normalizeExtensionId(extension.id);
		if (isEditorMigrationSourceIntegrationExtension(id)) {
			exclusions.push({ category: 'extensions', item: id, reason: 'sourceProductIntegration' });
			continue;
		}
		if (builtIns.has(id)) {
			exclusions.push({ category: 'extensions', item: id, reason: 'builtIn' });
			continue;
		}
		if (installed.has(id)) {
			exclusions.push({ category: 'extensions', item: id, reason: 'alreadyInstalled' });
			continue;
		}
		const result = gallery.get(id);
		if (!result || result.status !== 'available') {
			exclusions.push({ category: 'extensions', item: id, reason: result?.status === 'incompatible' ? 'galleryIncompatible' : 'galleryUnavailable' });
			continue;
		}
		if (result.requestedChannel === 'preRelease' && result.selectedChannel === 'stable') {
			warnings.push({ code: 'preReleaseFellBackToStable', item: id });
		}
		decisions.push({
			id: `extensions:${id}:${result.version}:${result.targetPlatform}`,
			category: 'extensions',
			item: id,
			kind: 'add',
			defaultChoice: 'import',
			source: result,
		});
	}
}

function toOperation(decision: EditorMigrationDraftDecision): EditorMigrationPlanOperation {
	switch (decision.category) {
		case 'settings':
			return { id: decision.id, category: 'settings', kind: 'setSetting', item: decision.item, source: decision.source };
		case 'keybindings':
			if (!isJsonObject(decision.source)) {
				throw new EditorMigrationPlanningError('nonCanonicalInput', 'Keybinding operation source must be an object');
			}
			return {
				id: decision.id,
				category: 'keybindings',
				kind: decision.kind === 'conflict' ? 'replaceKeybinding' : 'addKeybinding',
				item: decision.item,
				source: decision.source,
				relatedTargetIds: decision.relatedTargetIds ?? [],
			};
		case 'snippets': {
			const source = decision.source;
			if (!isJsonObject(source) || typeof source.name !== 'string' || typeof source.contentHash !== 'string' || !isJsonObject(source.contents)) {
				throw new EditorMigrationPlanningError('nonCanonicalInput', 'Snippet operation source must contain a name, contents, and content hash');
			}
			return { id: decision.id, category: 'snippets', kind: decision.kind === 'conflict' ? 'replaceSnippet' : 'addSnippet', item: decision.item, source: { name: source.name, contents: source.contents, contentHash: source.contentHash } };
		}
		case 'extensions': {
			const source = decision.source;
			if (!isAvailableGalleryResult(source)) {
				throw new EditorMigrationPlanningError('nonCanonicalInput', 'Extension operation source must be an available exact gallery coordinate');
			}
			return { id: decision.id, category: 'extensions', kind: 'installExtension', item: decision.item, source };
		}
	}
}

/** Narrows a migration JSON value to an object. */
function isJsonObject(value: EditorMigrationJsonValue): value is Readonly<Record<string, EditorMigrationJsonValue>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks whether gallery evidence identifies an exact installable extension coordinate. */
function isAvailableGalleryResult(value: EditorMigrationJsonValue): value is Extract<EditorMigrationGalleryResult, { readonly status: 'available' }> {
	return isJsonObject(value)
		&& typeof value.id === 'string'
		&& (value.requestedChannel === 'stable' || value.requestedChannel === 'preRelease')
		&& value.status === 'available'
		&& typeof value.version === 'string'
		&& typeof value.targetPlatform === 'string'
		&& (value.selectedChannel === 'stable' || value.selectedChannel === 'preRelease')
		&& typeof value.engine === 'string'
		&& typeof value.galleryIdentity === 'string'
		&& (value.uuid === undefined || typeof value.uuid === 'string');
}

function validateInputs(source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot, evidence: EditorMigrationPlanningEvidence, categories: readonly EditorMigrationCategory[]): void {
	if (target.schemaVersion !== EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION || !target.eligible) {
		throw new EditorMigrationPlanningError('ineligibleTarget', 'Migration target is not eligible');
	}
	if (target.selection.kind === 'proposed' && !target.nameAvailable) {
		throw new EditorMigrationPlanningError('proposedNameUnavailable', 'Proposed migration target name is unavailable');
	}
	for (const category of target.categories.filter(category => categories.includes(category.category))) {
		if (category.state === 'unreadable') {
			throw new EditorMigrationPlanningError('resourceUnavailable', `Target ${category.category} is unreadable`);
		}
	}
	if (categories.includes('extensions') && new Set(evidence.gallery.map(item => normalizeExtensionId(item.id))).size !== evidence.gallery.length) {
		throw new EditorMigrationPlanningError('nonCanonicalInput', 'Gallery evidence contains duplicate extension IDs');
	}
	if (source.categories.some(category => categories.includes(category.category) && category.state === 'unreadable')) {
		throw new EditorMigrationPlanningError('resourceUnavailable', 'Selected source resource is unreadable');
	}
}

type CategoryValue<T extends EditorMigrationCategory> = Extract<EditorMigrationCategorySnapshot, { category: T }>;
type TargetCategoryValue<T extends EditorMigrationCategory> = Extract<EditorMigrationTargetCategorySnapshot, { category: T }>;

function sourceCategory<T extends EditorMigrationCategory>(snapshot: EditorMigrationSourceSnapshot, category: T): CategoryValue<T> | undefined {
	return snapshot.categories.find(item => item.category === category) as CategoryValue<T> | undefined;
}

function targetCategory<T extends EditorMigrationCategory>(snapshot: EditorMigrationTargetSnapshot, category: T): TargetCategoryValue<T> | undefined {
	return snapshot.categories.find(item => item.category === category) as TargetCategoryValue<T> | undefined;
}

function normalizedKeybinding(value: Readonly<Record<string, EditorMigrationJsonValue>>, evidence: EditorMigrationPlanningEvidence): { key: string; command: string; when: string; identity: string; value: EditorMigrationJsonValue } {
	const rawKey = typeof value.key === 'string' ? value.key : '';
	const key = evidence.normalizedKeys[rawKey] ?? rawKey.trim().toLowerCase();
	const command = typeof value.command === 'string' ? value.command : '';
	const rawWhen = typeof value.when === 'string' ? value.when : '';
	const when = ContextKeyExpr.deserialize(rawWhen)?.serialize() ?? rawWhen.trim();
	const args = value.args ?? null;
	return {
		key,
		command,
		when,
		identity: canonicalizeEditorMigrationValue({ key, command, when, args }),
		value,
	};
}

/** Produces the stable indexed row ID shared by planning and Apply. */
export function editorMigrationKeybindingRowId(value: Readonly<Record<string, EditorMigrationJsonValue>>, evidence: EditorMigrationPlanningEvidence, index: number): string {
	return canonicalizeEditorMigrationValue({ identity: normalizedKeybinding(value, evidence).identity, index });
}

function normalizeEvidence(evidence: EditorMigrationPlanningEvidence, categories: readonly EditorMigrationCategory[]): EditorMigrationPlanningEvidence {
	return {
		registryIgnoredSettings: categories.includes('settings') ? [...new Set(evidence.registryIgnoredSettings)].sort(compare) : [],
		normalizedKeys: categories.includes('keybindings') ? Object.fromEntries(Object.entries(evidence.normalizedKeys).sort(([a], [b]) => compare(a, b))) : {},
		keybindingPlatform: categories.includes('keybindings') ? evidence.keybindingPlatform : '',
		gallery: categories.includes('extensions') ? [...evidence.gallery].sort((a, b) => compare(normalizeExtensionId(a.id), normalizeExtensionId(b.id))) : [],
	};
}

function deduplicateExtensions(extensions: readonly EditorMigrationExtension[]): EditorMigrationExtension[] {
	const result = new Map<string, EditorMigrationExtension>();
	for (const extension of extensions) {
		const id = normalizeExtensionId(extension.id);
		if (!result.has(id)) {
			result.set(id, { ...extension, id });
		}
	}
	return [...result.values()].sort((a, b) => compare(a.id, b.id));
}

function normalizeExtensionId(id: string): string {
	return id.trim().toLowerCase();
}

function normalizeSnippetName(name: string, targetPlatform: string): string {
	const trimmed = name.trim();
	return targetPlatform.startsWith('win32-') || targetPlatform.startsWith('darwin-') ? trimmed.toLowerCase() : trimmed;
}

function normalizeCategories(categories: readonly EditorMigrationCategory[]): EditorMigrationCategory[] {
	const order: readonly EditorMigrationCategory[] = ['settings', 'keybindings', 'snippets', 'extensions'];
	return order.filter(category => categories.includes(category));
}

function equal(a: EditorMigrationJsonValue, b: EditorMigrationJsonValue): boolean {
	return canonicalizeEditorMigrationValue(a) === canonicalizeEditorMigrationValue(b);
}

function sortDecisions(values: EditorMigrationDraftDecision[]): EditorMigrationDraftDecision[] {
	const order: readonly EditorMigrationCategory[] = ['settings', 'keybindings', 'snippets', 'extensions'];
	return values.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category)
		|| (a.category === 'keybindings' ? 0 : compare(a.id, b.id)));
}

function sortByCategoryAndItem<T extends { readonly category: string; readonly item: string }>(values: T[]): T[] {
	return values.sort((a, b) => compare(`${a.category}:${a.item}`, `${b.category}:${b.item}`));
}

function isKnownCoreSetting(key: string): boolean {
	return /^(?:editor|workbench|files|search|terminal|window|extensions|security)\./.test(key);
}
