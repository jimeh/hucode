/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { EditorMigrationItemResult, EditorMigrationOperation } from '../../common/migration/editorMigrationApply.js';
import { EditorMigrationCategory, EditorMigrationJsonValue } from '../../common/migration/editorMigrationSource.js';
import { EditorMigrationDraftDecision, EditorMigrationDraftExclusion, EditorMigrationExclusionReason, EditorMigrationPlanDraft, EditorMigrationPlanWarning } from '../../common/migration/editorMigrationPlanning.js';
import { EditorMigrationFlowState } from './editorMigrationFlow.js';

export const CATEGORY_LABELS: Readonly<Record<EditorMigrationCategory, string>> = {
	settings: localize('editorMigration.category.settings', "Settings"),
	keybindings: localize('editorMigration.category.keybindings', "Keyboard Shortcuts"),
	snippets: localize('editorMigration.category.snippets', "Snippets"),
	extensions: localize('editorMigration.category.extensions', "Extensions"),
};

export const ORDERED_CATEGORIES: readonly EditorMigrationCategory[] = ['settings', 'keybindings', 'snippets', 'extensions'];

/** Section identifiers that are not one of the four import categories. */
export const OVERVIEW_SECTION = 'overview';
export const NOT_IMPORTED_SECTION = 'notImported';
export const PUBLISHERS_SECTION = 'publishers';
export const RESTORE_SECTION = 'restore';

/** Item names are only spelled out while the count stays scannable inside a disclosure. */
export const ITEM_NAME_LIMIT = 25;

export type EditorMigrationSectionStatus = 'attention' | 'ok' | 'neutral';

/** One navigable row of the persistent section index. */
export interface EditorMigrationSection {
	readonly id: string;
	readonly label: string;
	readonly status: EditorMigrationSectionStatus;
	readonly count?: number;
	/** Renders after a separating rule, for sections that are not part of the import topic map. */
	readonly separated?: boolean;
}

/** Repeated items reduced to one stated cause with a count and the names behind it. */
export interface EditorMigrationAggregateGroup {
	readonly id: string;
	readonly title: string;
	readonly count: number;
	readonly items: readonly string[];
}

const PROBLEM_OUTCOMES: readonly EditorMigrationItemResult['outcome'][] = ['failed', 'unavailable', 'incompatible', 'canceled'];

/** True when an item result is something the user still has to act on or understand. */
export function isEditorMigrationProblemOutcome(outcome: EditorMigrationItemResult['outcome']): boolean {
	return PROBLEM_OUTCOMES.includes(outcome);
}

/** Category a plan warning belongs to, or undefined when it is not category scoped. */
export function editorMigrationWarningCategory(warning: EditorMigrationPlanWarning): EditorMigrationCategory | undefined {
	switch (warning.code) {
		case 'unknownSettingSchema': return 'settings';
		case 'preReleaseFellBackToStable':
		case 'unavailableThemeExtension': return 'extensions';
		case 'defaultProfileBacksOmni': return undefined;
	}
}

/** The review choices a user has made so far, keyed by stable draft decision ID. */
export type EditorMigrationDecisionChoices = Readonly<Record<string, 'import' | 'preserveTarget' | undefined>>;

/** What a category or the whole import will actually write, split so the accounting reconciles. */
export interface EditorMigrationImportCounts {
	readonly ready: number;
	readonly kept: number;
}

/** An unanswered difference still counts as the choice the planner seeded for it. */
function resolvedChoice(decisions: EditorMigrationDecisionChoices, decision: EditorMigrationDraftDecision): 'import' | 'preserveTarget' {
	return decisions[decision.id] ?? decision.defaultChoice;
}

/**
 * Items one category will import: every addition, plus each difference resolved to the imported
 * value. Differences kept at their current value are counted separately, never as imports.
 */
export function editorMigrationCategoryCounts(
	draft: EditorMigrationPlanDraft,
	decisions: EditorMigrationDecisionChoices,
	category: EditorMigrationCategory,
): EditorMigrationImportCounts {
	let ready = 0;
	let kept = 0;
	for (const decision of draft.decisions) {
		if (decision.category !== category) {
			continue;
		}
		if (decision.kind === 'add' || resolvedChoice(decisions, decision) === 'import') {
			ready += 1;
		} else {
			kept += 1;
		}
	}
	return { ready, kept };
}

/** The same accounting across every selected category. */
export function editorMigrationImportCounts(
	draft: EditorMigrationPlanDraft,
	decisions: EditorMigrationDecisionChoices,
	selectedCategories: readonly EditorMigrationCategory[],
): EditorMigrationImportCounts {
	return selectedCategories.reduce<EditorMigrationImportCounts>((total, category) => {
		const counts = editorMigrationCategoryCounts(draft, decisions, category);
		return { ready: total.ready + counts.ready, kept: total.kept + counts.kept };
	}, { ready: 0, kept: 0 });
}

/**
 * The durable evidence held-back accounting needs. A draft carries it before review, and the
 * reviewed plan retains the same source snapshot, requested categories, and exclusions, so
 * Results reports the identical accounting the user saw in Review.
 */
export type EditorMigrationHeldBackEvidence = Pick<EditorMigrationPlanDraft, 'source' | 'target' | 'exclusions'>;

/** Number of source items a category offers, used for available and held-back counts. */
export function editorMigrationSourceItemCount(evidence: EditorMigrationHeldBackEvidence, category: EditorMigrationCategory): number {
	const source = evidence.source.categories.find(candidate => candidate.category === category);
	if (source?.state !== 'present' || !source.value) {
		return 0;
	}
	return Array.isArray(source.value) ? source.value.length : Object.keys(source.value as Readonly<Record<string, EditorMigrationJsonValue>>).length;
}

/**
 * Items held back from the import. A deselected category contributes its full source item count,
 * which already contains that category's policy exclusions, so only still-selected categories
 * contribute their exclusions.
 */
export function editorMigrationNotImportedCount(evidence: EditorMigrationHeldBackEvidence, selectedCategories: readonly EditorMigrationCategory[]): number {
	const selectedExclusions = evidence.exclusions.filter(exclusion => selectedCategories.includes(exclusion.category)).length;
	const deselected = evidence.target.requestedCategories
		.filter(category => !selectedCategories.includes(category))
		.reduce((total, category) => total + editorMigrationSourceItemCount(evidence, category), 0);
	return selectedExclusions + deselected;
}

/**
 * Held-back groups, following the same rule as the count: one whole-category group for a
 * deselected category, and per-reason exclusion groups only for categories still being imported.
 */
export function editorMigrationNotImportedGroups(evidence: EditorMigrationHeldBackEvidence, selectedCategories: readonly EditorMigrationCategory[]): readonly EditorMigrationAggregateGroup[] {
	const groups: EditorMigrationAggregateGroup[] = [];
	for (const category of ORDERED_CATEGORIES) {
		if (!evidence.target.requestedCategories.includes(category)) {
			continue;
		}
		if (selectedCategories.includes(category)) {
			groups.push(...categorizedExclusionGroups(evidence.exclusions, [category]));
			continue;
		}
		const count = editorMigrationSourceItemCount(evidence, category);
		groups.push({
			id: `deselected:${category}`,
			title: localize('editorMigration.notImported.deselected', "{0} is not included in this import, so none of its source items are imported.", CATEGORY_LABELS[category]),
			count,
			items: [],
		});
	}
	return sortAggregateGroups(groups);
}

/** Exclusion causes across the given categories, each prefixed by its category and stated once. */
function categorizedExclusionGroups(
	exclusions: readonly EditorMigrationDraftExclusion[],
	categories: readonly EditorMigrationCategory[],
): readonly EditorMigrationAggregateGroup[] {
	return sortAggregateGroups(categories.flatMap(category => editorMigrationExclusionGroups(exclusions, category)
		.map(group => ({
			...group,
			id: `${category}:${group.id}`,
			title: localize('editorMigration.notImported.categoryReason', "{0} — {1}", CATEGORY_LABELS[category], group.title),
		}))));
}

/** Largest cause first, with a stable tie-break so the order does not drift between renders. */
function sortAggregateGroups(groups: readonly EditorMigrationAggregateGroup[]): readonly EditorMigrationAggregateGroup[] {
	return [...groups].sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
}

/** Review index: the four categories plus the dedicated held-back section. */
export function editorMigrationReviewSections(state: EditorMigrationFlowState): readonly EditorMigrationSection[] {
	const draft = state.draft;
	if (!draft) {
		return [];
	}
	const sections: EditorMigrationSection[] = [];
	for (const category of ORDERED_CATEGORIES) {
		if (!draft.target.requestedCategories.includes(category)) {
			continue;
		}
		const included = state.selectedCategories.includes(category);
		const decisions = draft.decisions.filter(decision => decision.category === category);
		const conflicts = decisions.filter(decision => decision.kind === 'conflict');
		const warnings = draft.warnings.filter(warning => editorMigrationWarningCategory(warning) === category);
		sections.push({
			id: category,
			label: CATEGORY_LABELS[category],
			count: included ? editorMigrationCategoryCounts(draft, state.decisions, category).ready : 0,
			status: !included ? 'neutral' : conflicts.length || warnings.length ? 'attention' : decisions.length ? 'ok' : 'neutral',
		});
	}
	sections.push({
		id: NOT_IMPORTED_SECTION,
		label: localize('editorMigration.section.notImported', "Not Imported"),
		count: editorMigrationNotImportedCount(draft, state.selectedCategories),
		status: 'neutral',
	});
	return sections;
}

/** Publisher confirmation keeps the review topic map and adds the publishers topic. */
export function editorMigrationPublisherSections(state: EditorMigrationFlowState): readonly EditorMigrationSection[] {
	return [
		...editorMigrationReviewSections(state),
		{
			id: PUBLISHERS_SECTION,
			label: localize('editorMigration.section.publishers', "Publishers"),
			count: state.publishers.length,
			status: 'attention',
			separated: true,
		},
	];
}

/** Apply index: an overview topic plus each category being imported. */
export function editorMigrationApplySections(state: EditorMigrationFlowState): readonly EditorMigrationSection[] {
	const plan = state.reviewedPlan ?? state.operation?.plan;
	const results = state.progress?.results ?? [];
	const sections: EditorMigrationSection[] = [{
		id: OVERVIEW_SECTION,
		label: localize('editorMigration.section.progress', "Progress"),
		status: 'neutral',
	}];
	for (const category of ORDERED_CATEGORIES) {
		if (!plan?.choices.selectedCategories.includes(category)) {
			continue;
		}
		const categoryResults = results.filter(result => result.category === category);
		sections.push({
			id: category,
			label: CATEGORY_LABELS[category],
			count: categoryResults.length,
			status: categoryResults.some(result => isEditorMigrationProblemOutcome(result.outcome))
				? 'attention'
				: results.some(result => result.id === category) ? 'ok' : 'neutral',
		});
	}
	return sections;
}

/** Results index: a summary topic, each imported category, held-back items, and restore. */
export function editorMigrationResultsSections(state: EditorMigrationFlowState): readonly EditorMigrationSection[] {
	const operation = state.operation;
	if (!operation) {
		return [];
	}
	const sections: EditorMigrationSection[] = [{
		id: OVERVIEW_SECTION,
		label: localize('editorMigration.section.summary', "Summary"),
		status: operation.aggregateOutcome === 'completed' ? 'ok' : 'neutral',
	}];
	for (const category of ORDERED_CATEGORIES) {
		if (!operation.plan.choices.selectedCategories.includes(category)) {
			continue;
		}
		const categoryResults = operation.results.filter(result => result.category === category);
		const problems = categoryResults.filter(result => isEditorMigrationProblemOutcome(result.outcome));
		sections.push({
			id: category,
			label: CATEGORY_LABELS[category],
			count: categoryResults.length - problems.length,
			status: problems.length ? 'attention' : categoryResults.length ? 'ok' : 'neutral',
		});
	}
	const heldBack = editorMigrationNotImportedCount(operation.plan, operation.plan.choices.selectedCategories);
	if (heldBack) {
		sections.push({
			id: NOT_IMPORTED_SECTION,
			label: localize('editorMigration.section.notImported', "Not Imported"),
			count: heldBack,
			status: 'neutral',
		});
	}
	if (editorMigrationRollbackEligibleCategories(operation).length || operation.rollbackIntent) {
		sections.push({
			id: RESTORE_SECTION,
			label: localize('editorMigration.section.restore', "Undo File Changes"),
			status: 'neutral',
			separated: true,
		});
	}
	return sections;
}

/** Categories with a proven post-apply file mutation that rollback can restore. */
export function editorMigrationRollbackEligibleCategories(operation: EditorMigrationOperation): Exclude<EditorMigrationCategory, 'extensions'>[] {
	return ['settings', 'keybindings', 'snippets'].filter((category): category is Exclude<EditorMigrationCategory, 'extensions'> =>
		(operation.snapshots ?? []).some(snapshot => snapshot.category === category && snapshot.postApplyHash !== undefined));
}

/**
 * Opens on the first section needing attention, then the caller's fallback topic.
 * `ignoreAttentionFor` keeps a summary topic from claiming its own attention mark.
 */
export function editorMigrationDefaultSection(sections: readonly EditorMigrationSection[], fallback?: string, ignoreAttentionFor?: string): string | undefined {
	const attention = sections.find(section => section.id !== ignoreAttentionFor && section.status === 'attention');
	if (attention) {
		return attention.id;
	}
	return sections.some(section => section.id === fallback) ? fallback : sections[0]?.id;
}

/** Held-back items reduced to one row per reason, largest cause first. */
export function editorMigrationExclusionGroups(
	exclusions: readonly EditorMigrationDraftExclusion[],
	category?: EditorMigrationCategory,
): readonly EditorMigrationAggregateGroup[] {
	const scoped = category ? exclusions.filter(exclusion => exclusion.category === category) : exclusions;
	const groups = new Map<string, { reason: EditorMigrationExclusionReason; items: string[] }>();
	for (const exclusion of scoped) {
		const group = groups.get(exclusion.reason) ?? { reason: exclusion.reason, items: [] };
		group.items.push(exclusion.item);
		groups.set(exclusion.reason, group);
	}
	return [...groups.values()]
		.map(group => ({ id: `exclusion:${group.reason}`, title: editorMigrationExclusionReasonLabel(group.reason), count: group.items.length, items: group.items }))
		.sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
}

/** Repeated plan warnings reduced to one row per warning code with a count. */
export function editorMigrationWarningGroups(
	warnings: readonly EditorMigrationPlanWarning[],
	category?: EditorMigrationCategory,
): readonly EditorMigrationAggregateGroup[] {
	const scoped = warnings.filter(warning => warning.code !== 'defaultProfileBacksOmni'
		&& (category === undefined || editorMigrationWarningCategory(warning) === category));
	const groups = new Map<EditorMigrationPlanWarning['code'], string[]>();
	for (const warning of scoped) {
		groups.set(warning.code, [...groups.get(warning.code) ?? [], warning.item ?? '']);
	}
	return [...groups.entries()]
		.map(([code, items]) => ({
			id: `warning:${code}`,
			title: editorMigrationWarningGroupLabel(code, items.length),
			count: items.length,
			items: items.filter(item => item.length > 0),
		}))
		.sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
}

/** One extension placement instruction per outcome, never one per extension. */
export function editorMigrationPlacementGroups(operation: EditorMigrationOperation): readonly EditorMigrationAggregateGroup[] {
	const groups = new Map<string, { applicationScoped: boolean | undefined; installed: boolean; items: string[] }>();
	for (const intent of operation.extensionInstallIntents ?? []) {
		const planned = operation.plan.operations.find(candidate => candidate.id === intent.operationId && candidate.kind === 'installExtension');
		if (!planned) {
			continue;
		}
		const outcome = operation.results.find(result => result.id === intent.operationId)?.outcome;
		const installed = outcome === 'completed' || outcome === 'alreadyPresent';
		const key = `${intent.applicationScoped}:${installed}`;
		const group = groups.get(key) ?? { applicationScoped: intent.applicationScoped, installed, items: [] };
		group.items.push(planned.item);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.map(([key, group]) => ({
			id: `placement:${key}`,
			title: editorMigrationPlacementLabel(group.applicationScoped, group.installed, group.items.length),
			count: group.items.length,
			items: group.items,
		}))
		.sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
}

/** Names for a group, truncated so a disclosure never becomes a nested scrolling list. */
export function editorMigrationVisibleItems(items: readonly string[]): { readonly shown: readonly string[]; readonly remaining: number } {
	return { shown: items.slice(0, ITEM_NAME_LIMIT), remaining: Math.max(0, items.length - ITEM_NAME_LIMIT) };
}

export function editorMigrationExclusionReasonLabel(reason: EditorMigrationExclusionReason): string {
	switch (reason) {
		case 'machineSpecific': return localize('editorMigration.exclusion.machineSpecific', "Kept out because these settings are specific to the source machine.");
		case 'accountOrAuthentication': return localize('editorMigration.exclusion.accountOrAuthentication', "Kept out because account and sign-in data must not be imported.");
		case 'telemetryIdentity': return localize('editorMigration.exclusion.telemetryIdentity', "Kept out because telemetry identity data must not be imported.");
		case 'updateChannel': return localize('editorMigration.exclusion.updateChannel', "Kept out because update-channel settings belong to the source application.");
		case 'remoteAuthority': return localize('editorMigration.exclusion.remoteAuthority', "Kept out because remote connection settings are machine-specific.");
		case 'applicationPath': return localize('editorMigration.exclusion.applicationPath', "Kept out because the values contain a source-application path.");
		case 'sourceProductIntegration': return localize('editorMigration.exclusion.sourceProductIntegration', "Not imported because they integrate with the source application.");
		case 'registryIgnored': return localize('editorMigration.exclusion.registryIgnored', "Not imported because Hucode's settings registry excludes them.");
		case 'builtIn': return localize('editorMigration.exclusion.builtIn', "Already provided by Hucode as built-in extensions.");
		case 'alreadyInstalled': return localize('editorMigration.exclusion.alreadyInstalled', "Already installed in the target profile.");
		case 'galleryUnavailable': return localize('editorMigration.exclusion.galleryUnavailable', "Unavailable from Hucode's extension gallery.");
		case 'galleryIncompatible': return localize('editorMigration.exclusion.galleryIncompatible', "Available releases are incompatible with this Hucode version or platform.");
	}
}

function editorMigrationWarningGroupLabel(code: EditorMigrationPlanWarning['code'], count: number): string {
	switch (code) {
		case 'preReleaseFellBackToStable': return localize('editorMigration.warning.preReleaseFallback', "{0} extensions requested a pre-release version; the gallery will install the compatible stable version.", count);
		case 'unknownSettingSchema': return localize('editorMigration.warning.unknownSettingSchema', "{0} settings have no registered schema in Hucode; review them after importing.", count);
		case 'unavailableThemeExtension': return localize('editorMigration.warning.unavailableThemeExtension', "{0} theme extensions are unavailable; choose another theme after import if needed.", count);
		case 'defaultProfileBacksOmni': return '';
	}
}

function editorMigrationPlacementLabel(applicationScoped: boolean | undefined, installed: boolean, count: number): string {
	if (applicationScoped === undefined) {
		return installed
			? localize('editorMigration.results.extensionPlacementUnknown', "{0} extensions are installed, but this older recovery record does not identify their profile placement. Reload this window; reload all Hucode windows if any of them are application-wide.", count)
			: localize('editorMigration.results.extensionIntentUnknown', "{0} extensions have no completed installation, and this older recovery record does not identify their intended profile placement.", count);
	}
	if (installed) {
		return applicationScoped
			? localize('editorMigration.results.extensionApplicationScoped', "{0} extensions are installed application-wide in Default. Reload Hucode windows to use them everywhere.", count)
			: localize('editorMigration.results.extensionProfileScoped', "{0} extensions are installed in this profile. Restart the extension host or reload this window to use them.", count);
	}
	return applicationScoped
		? localize('editorMigration.results.extensionApplicationIntent', "{0} extensions were intended for application-wide placement in Default, but no completed installation was recorded.", count)
		: localize('editorMigration.results.extensionProfileIntent', "{0} extensions were intended for this profile, but no completed installation was recorded.", count);
}
