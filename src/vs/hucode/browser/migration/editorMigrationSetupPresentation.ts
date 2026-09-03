/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { EditorMigrationApplyProgress, EditorMigrationItemResult, EditorMigrationOperation } from '../../common/migration/editorMigrationApply.js';
import { EditorMigrationCategory, EditorMigrationDiagnostic, EditorMigrationJsonValue, EditorMigrationSourceDescriptor } from '../../common/migration/editorMigrationSource.js';
import { EditorMigrationDraftDecision, EditorMigrationPlanDraft, EditorMigrationReviewedPlan } from '../../common/migration/editorMigrationPlanning.js';
import {
	EditorMigrationSetupAction,
	EditorMigrationSetupCategory,
	EditorMigrationSetupConflictRow,
	EditorMigrationSetupDisclosure,
	EditorMigrationSetupFileCategory,
	EditorMigrationSetupGroup,
	EditorMigrationSetupPanel,
	EditorMigrationSetupPresentation,
	EditorMigrationSetupProblemRow,
	EditorMigrationSetupRadioOption,
	EditorMigrationSetupSection,
} from '../../common/migration/editorMigrationSetupProtocol.js';
import { EditorMigrationFlowState } from './editorMigrationFlow.js';
import {
	CATEGORY_LABELS,
	EditorMigrationAggregateGroup,
	EditorMigrationSection,
	NOT_IMPORTED_SECTION,
	ORDERED_CATEGORIES,
	OVERVIEW_SECTION,
	PUBLISHERS_SECTION,
	RESTORE_SECTION,
	editorMigrationApplySections,
	editorMigrationCategoryCounts,
	editorMigrationDefaultSection,
	editorMigrationExclusionGroups,
	editorMigrationImportCounts,
	editorMigrationNotImportedCount,
	editorMigrationNotImportedGroups,
	editorMigrationPlacementGroups,
	editorMigrationPublisherSections,
	editorMigrationResultsSections,
	editorMigrationReviewSections,
	editorMigrationRollbackEligibleCategories,
	editorMigrationSourceItemCount,
	editorMigrationVisibleItems,
	editorMigrationWarningGroups,
	isEditorMigrationProblemOutcome,
} from './editorMigrationFlowSections.js';

/** Beyond this many comparison rows the user needs the filter rather than more scrolling. */
export const CONFLICT_ROW_LIMIT = 60;

/**
 * Maps migration state into the wire-safe, fully localized snapshot the renderer draws.
 *
 * Every user-visible string in the setup UI originates here. The renderer owns filters, open
 * disclosures, the active section, rollback category selection, and measurement, and nothing else.
 */
export function editorMigrationSetupPresentation(state: EditorMigrationFlowState, revision: number): EditorMigrationSetupPresentation {
	const sections = sectionsFor(state);
	const panels = panelsFor(state, sections);
	return {
		revision,
		phase: state.phase,
		regionLabel: localize('editorMigration.region', "Editor Setup Import"),
		title: localize('editorMigration.title', "Import Setup from Another Editor"),
		steps: [
			{ id: 'discover', label: localize('editorMigration.step.discover', "Discover"), current: phaseGroup(state.phase) === 'discover' },
			{ id: 'review', label: localize('editorMigration.step.review', "Review"), current: phaseGroup(state.phase) === 'review' },
			{ id: 'apply', label: localize('editorMigration.step.apply', "Apply"), current: phaseGroup(state.phase) === 'apply' },
			{ id: 'results', label: localize('editorMigration.step.results', "Results"), current: phaseGroup(state.phase) === 'results' },
		],
		busy: state.busy,
		canceling: state.canceling,
		error: state.error,
		announcement: state.announcement,
		railLabel: sections.length ? localize('editorMigration.index.label', "Import sections") : undefined,
		railTitle: sections.length ? phaseLabel(state.phase) : undefined,
		sections: sections.map(toSectionDto),
		defaultSectionId: defaultSectionId(state, sections),
		scopeKey: scopeKey(state),
		panels,
		footer: footerFor(state),
		sectionAnnouncementTemplate: localize('editorMigration.index.showing', "Showing {0}.", '{0}'),
	};
}

// #region sections

function sectionsFor(state: EditorMigrationFlowState): readonly EditorMigrationSection[] {
	switch (state.phase) {
		case 'review': return editorMigrationReviewSections(state);
		case 'publishers': return editorMigrationPublisherSections(state);
		case 'apply': return editorMigrationApplySections(state);
		case 'results': return editorMigrationResultsSections(state);
		default: return [];
	}
}

function defaultSectionId(state: EditorMigrationFlowState, sections: readonly EditorMigrationSection[]): string | undefined {
	if (!sections.length) {
		return undefined;
	}
	const preferred = state.phase === 'publishers'
		? PUBLISHERS_SECTION
		: state.phase === 'apply'
			? OVERVIEW_SECTION
			: state.phase === 'review'
				? editorMigrationDefaultSection(sections, 'settings')
				: editorMigrationDefaultSection(sections, OVERVIEW_SECTION, OVERVIEW_SECTION);
	return preferred && sections.some(section => section.id === preferred) ? preferred : sections[0].id;
}

function toSectionDto(section: EditorMigrationSection): EditorMigrationSetupSection {
	return {
		id: section.id,
		label: section.label,
		status: section.status,
		count: section.count,
		separated: section.separated,
		statusDescription: sectionStatusDescription(section),
	};
}

function sectionStatusDescription(section: EditorMigrationSection): string {
	const count = section.count === undefined ? '' : localize('editorMigration.index.count', "{0} items.", section.count);
	switch (section.status) {
		case 'attention': return `${localize('editorMigration.index.attention', "Needs attention.")} ${count}`.trim();
		case 'ok': return `${localize('editorMigration.index.ok', "Ready.")} ${count}`.trim();
		case 'neutral': return count;
	}
}

/**
 * Identity of what the snapshot describes.
 *
 * A fresh import, a materially different draft, or a different durable operation changes it, which
 * is the renderer's signal to discard its local section, filter, scroll, and disclosure state.
 */
function scopeKey(state: EditorMigrationFlowState): string {
	const draft = state.draft && `${state.draft.source.ref.value}|${state.draft.target.fingerprint}|${state.draft.draftFingerprintSeed}`;
	const operation = state.operation?.id ?? state.progress?.operationId;
	return `${phaseGroup(state.phase)}|${draft ?? ''}|${operation ?? ''}`;
}

// #endregion

// #region panels

function panelsFor(state: EditorMigrationFlowState, sections: readonly EditorMigrationSection[]): readonly EditorMigrationSetupPanel[] {
	switch (state.phase) {
		case 'loading': return [loadingPanel()];
		case 'recovery': return [recoveryPanel(state)];
		case 'application': return [applicationsPanel(state)];
		case 'profile': return [profilesPanel(state)];
		case 'target': return [targetPanel(state)];
		case 'review': return sections.map(section => reviewPanel(state, section.id, false));
		case 'publishers': return sections.map(section => section.id === PUBLISHERS_SECTION ? publishersPanel(state) : reviewPanel(state, section.id, true));
		case 'apply': return sections.map(section => section.id === OVERVIEW_SECTION ? applyOverviewPanel(state) : applyCategoryPanel(state, section.id as EditorMigrationCategory));
		case 'results': return sections.map(section => resultsPanel(state, section.id));
	}
}

function loadingPanel(): EditorMigrationSetupPanel {
	return {
		kind: 'loading',
		id: '',
		heading: localize('editorMigration.loading', "Looking for editor profiles..."),
		progress: { text: localize('editorMigration.loading.detail', "Reading supported local editor installations."), min: 0, max: 1, now: 0 },
	};
}

function recoveryPanel(state: EditorMigrationFlowState): EditorMigrationSetupPanel {
	return {
		kind: 'recovery',
		id: '',
		heading: localize('editorMigration.recovery.title', "Continue an Earlier Import"),
		lead: localize('editorMigration.recovery.description', "Hucode found import data that still has results or recovery actions available."),
		filterLabel: localize('editorMigration.recovery.filter', "Filter earlier imports"),
		listLabel: localize('editorMigration.recovery.list', "Earlier imports"),
		emptyText: localize('editorMigration.recovery.empty', "No earlier import data is available."),
		records: state.recoveries.map(recovery => {
			const title = recovery.targetName ?? localize('editorMigration.recovery.unknownTarget', "Unknown Target");
			const supported = recovery.unsupportedSchemaVersion === undefined;
			return {
				id: recovery.id,
				title,
				detail: supported
					? `${stageLabel(recovery.stage)} · ${new Date(recovery.updatedAt).toLocaleString()}`
					: localize('editorMigration.recovery.unsupported', "This record was created by another Hucode version and will be kept untouched."),
				action: supported
					? action(`recovery-${recovery.id}`, localize('editorMigration.recovery.open', "View or Continue"), { type: 'showRecovery', operationId: recovery.id })
					: undefined,
			};
		}),
	};
}

function applicationsPanel(state: EditorMigrationFlowState): EditorMigrationSetupPanel {
	return {
		kind: 'applications',
		id: '',
		heading: localize('editorMigration.application.title', "Which Application Should Hucode Import From?"),
		lead: localize('editorMigration.application.description', "Choose an editor first. You will choose one of its profiles next."),
		filterLabel: localize('editorMigration.application.filter', "Filter applications"),
		listLabel: localize('editorMigration.application.list', "Source applications"),
		emptyText: localize('editorMigration.application.empty', "No supported editor profiles were found."),
		noMatchText: localize('editorMigration.filter.noMatch', "Nothing matches the current filter."),
		applications: state.applications.map(application => ({
			id: application.id,
			title: application.productName,
			detail: application.profiles.length === 1
				? localize('editorMigration.application.profile', "1 profile")
				: localize('editorMigration.application.profiles', "{0} profiles", application.profiles.length),
			intent: { type: 'selectApplication', applicationId: application.id },
		})),
		diagnostics: state.discoveryDiagnostics.length
			? disclosure('discovery', localize('editorMigration.discovery.details', "Discovery Details"), state.discoveryDiagnostics.map(diagnosticLabel))
			: undefined,
	};
}

function profilesPanel(state: EditorMigrationFlowState): EditorMigrationSetupPanel {
	const application = state.applications.find(candidate => candidate.id === state.selectedApplicationId);
	if (!application) {
		return { kind: 'message', id: '', heading: localize('editorMigration.profile.titleUnknown', "Choose a Profile") };
	}
	const selected = application.profiles.find(source => source.ref.value === state.selectedSourceRef?.value);
	return {
		kind: 'profiles',
		id: '',
		heading: localize('editorMigration.profile.title', "Choose a {0} Profile", application.productName),
		filterLabel: localize('editorMigration.profile.filter', "Filter profiles"),
		groupLabel: localize('editorMigration.profile.group', "Source profile"),
		noMatchText: localize('editorMigration.filter.noMatch', "Nothing matches the current filter."),
		profiles: application.profiles.map(source => ({
			id: source.ref.value,
			label: source.profile.name,
			checked: state.selectedSourceRef?.value === source.ref.value,
			intent: { type: 'selectSourceProfile', sourceRef: source.ref.value },
		})),
		details: selected ? sourceDetails(selected) : undefined,
	};
}

function sourceDetails(source: EditorMigrationSourceDescriptor): EditorMigrationSetupDisclosure {
	return disclosure('source-details', localize('editorMigration.profile.details', "Profile Details"), [
		sourceModificationLabel(source.ranking.newestModificationTime),
		localize('editorMigration.profile.userDataPath', "User data path: {0}", source.localPaths.userData),
		localize('editorMigration.profile.extensionsPath', "Extensions path: {0}", source.localPaths.extensions),
		...source.diagnostics.map(diagnosticLabel),
	]);
}

function targetPanel(state: EditorMigrationFlowState): EditorMigrationSetupPanel {
	return {
		kind: 'target',
		id: '',
		heading: localize('editorMigration.target.title', "Where Should Hucode Import This Setup?"),
		lead: localize('editorMigration.target.description', "Default is selected. You can choose another existing profile or name a new one."),
		groupLabel: localize('editorMigration.target.group', "Target profile"),
		targets: state.targets.map(target => ({
			id: target.selection.profileId,
			label: target.kind === 'default' ? localize('editorMigration.target.default', "Default (Recommended)") : target.name,
			checked: state.selectedTarget?.kind === 'existing' && state.selectedTarget.profileId === target.selection.profileId,
			intent: { type: 'selectTarget', target: { kind: 'existing', profileId: target.selection.profileId } },
		})),
		newTarget: {
			label: localize('editorMigration.target.new.label', "New profile name"),
			placeholder: localize('editorMigration.target.new.placeholder', "New profile name"),
			actionLabel: localize('editorMigration.target.new.use', "Use New Profile"),
			value: state.selectedTarget?.kind === 'proposed' ? state.selectedTarget.name : '',
			selectedText: state.selectedTarget?.kind === 'proposed'
				? localize('editorMigration.target.new.selected', "Selected new profile: {0}", state.selectedTarget.name)
				: undefined,
		},
	};
}

function reviewPanel(state: EditorMigrationFlowState, sectionId: string, readOnly: boolean): EditorMigrationSetupPanel {
	const draft = state.draft;
	if (!draft) {
		return { kind: 'message', id: sectionId, heading: localize('editorMigration.review.title', "Review What Will Change") };
	}
	if (sectionId === NOT_IMPORTED_SECTION) {
		const total = editorMigrationNotImportedCount(draft, state.selectedCategories);
		const groups = editorMigrationNotImportedGroups(draft, state.selectedCategories);
		return {
			kind: 'groups',
			id: sectionId,
			heading: localize('editorMigration.section.notImported', "Not Imported"),
			lead: localize('editorMigration.notImported.lead', "{0} items are held back, grouped by reason.", total),
			groups: groups.map(toGroupDto),
			emptyText: groups.length ? undefined : localize('editorMigration.notImported.empty', "Everything the source offers is included in this import."),
		};
	}
	const category = ORDERED_CATEGORIES.find(candidate => candidate === sectionId);
	if (!category) {
		return { kind: 'message', id: sectionId, heading: localize('editorMigration.review.title', "Review What Will Change") };
	}

	const included = state.selectedCategories.includes(category);
	const decisions = draft.decisions.filter(decision => decision.category === category);
	const conflicts = decisions.filter(decision => decision.kind === 'conflict');
	const additions = decisions.filter(decision => decision.kind === 'add');
	const available = editorMigrationSourceItemCount(draft, category);
	const counts = editorMigrationCategoryCounts(draft, state.decisions, category);
	const warnings = included ? editorMigrationWarningGroups(draft.warnings, category) : [];
	const exclusions = included ? editorMigrationExclusionGroups(draft.exclusions, category) : [];

	return {
		kind: 'reviewCategory',
		id: sectionId,
		heading: CATEGORY_LABELS[category],
		// A deselected category imports nothing, so its lead must never open with an import count.
		lead: !included
			? localize('editorMigration.review.leadExcluded', "Not included in this import. None of its {0} source items will be imported.", available)
			: conflicts.length
				? localize('editorMigration.review.leadWithConflicts', "{0} of {1} will be imported. {2} differ from your current values.", counts.ready, available, conflicts.length)
				: localize('editorMigration.review.lead', "{0} of {1} will be imported.", counts.ready, available),
		include: readOnly ? undefined : {
			label: localize('editorMigration.review.include', "Include {0} in this import", CATEGORY_LABELS[category]),
			checked: included,
			category: category as EditorMigrationSetupCategory,
		},
		ownership: ownershipLabel(draft, category, included),
		excludedText: included ? undefined : localize('editorMigration.review.excludedCategory', "These source items are listed under Not Imported."),
		differencesHeading: included && conflicts.length
			? localize('editorMigration.review.differences', "{0} differ from your current values", conflicts.length)
			: undefined,
		bulkActions: !readOnly && included && conflicts.length && category === 'settings'
			? [
				action('keep-all-settings', localize('editorMigration.review.keepAll', "Keep All Current Values"), { type: 'chooseAllSettingDifferences', choice: 'preserveTarget' }),
				action('import-all-settings', localize('editorMigration.review.useAll', "Use Imported Values for All"), { type: 'chooseAllSettingDifferences', choice: 'import' }),
			]
			: undefined,
		conflictFilterLabel: included && conflicts.length
			? localize('editorMigration.review.filterDifferences', "Filter {0} differences", CATEGORY_LABELS[category])
			: undefined,
		conflicts: included ? conflicts.map(decision => conflictRow(decision, state, readOnly)) : [],
		conflictOverflowTemplate: included && conflicts.length
			? localize('editorMigration.review.moreDifferences', "Showing the first {0} of {1} differences. Filter to reach the rest.", '{0}', '{1}')
			: undefined,
		notesHeading: warnings.length ? localize('editorMigration.review.notes', "Review Notes") : undefined,
		warnings: warnings.map(toGroupDto),
		additions: included && additions.length
			? disclosure('additions', additionsSummary(category, additions.length), additions.map(decision => decision.item), additionsExplanation(category))
			: undefined,
		exclusionNote: exclusions.length
			? localize('editorMigration.review.categoryExcluded', "{0} {1} items are held back. See Not Imported.", exclusions.reduce((total, group) => total + group.count, 0), CATEGORY_LABELS[category])
			: undefined,
		emptyText: included && !conflicts.length && !additions.length && !warnings.length
			? localize('editorMigration.review.nothingToDo', "This category has no decisions or changes.")
			: undefined,
	};
}

function conflictRow(decision: EditorMigrationDraftDecision, state: EditorMigrationFlowState, readOnly: boolean): EditorMigrationSetupConflictRow {
	const current = displayValue(decision.target);
	const imported = displayValue(decision.source);
	const choices: readonly EditorMigrationSetupRadioOption[] = [
		{
			id: `decision-${decision.id}-preserveTarget`,
			label: localize('editorMigration.review.keepCurrent', "Keep"),
			description: localize('editorMigration.review.keepCurrentLabel', "Keep current value {0} for {1}", current, decision.item),
			checked: state.decisions[decision.id] === 'preserveTarget',
			intent: { type: 'chooseDecision', decisionId: decision.id, choice: 'preserveTarget' },
		},
		{
			id: `decision-${decision.id}-import`,
			label: localize('editorMigration.review.useImported', "Use imported"),
			description: localize('editorMigration.review.useImportedLabel', "Use imported value {0} for {1}", imported, decision.item),
			checked: state.decisions[decision.id] === 'import',
			intent: { type: 'chooseDecision', decisionId: decision.id, choice: 'import' },
		},
	];
	return {
		id: decision.id,
		name: conflictName(decision),
		searchText: `${decision.item} ${conflictName(decision)}`,
		currentValue: current,
		importedValue: imported,
		valuesDescription: localize('editorMigration.review.conflictValues', "Current value {0}. Imported value {1}.", current, imported),
		choices: readOnly ? undefined : choices,
		chosenText: readOnly
			? state.decisions[decision.id] === 'import'
				? localize('editorMigration.review.chosenImported', "Using imported value")
				: localize('editorMigration.review.chosenCurrent', "Keeping current value")
			: undefined,
	};
}

function publishersPanel(state: EditorMigrationFlowState): EditorMigrationSetupPanel {
	const groups = state.publishers.map(publisher => {
		const extensions = state.reviewedPlan?.operations.flatMap(operation =>
			operation.kind === 'installExtension' && operation.source.id.toLowerCase().startsWith(`${publisher.toLowerCase()}.`) ? [operation.source.id] : []) ?? [];
		return toGroupDto({
			id: `publisher:${publisher}`,
			title: localize('editorMigration.publishers.entry', "{0} provides {1} extensions in this import.", publisher, extensions.length),
			count: extensions.length,
			items: extensions,
		});
	});
	return {
		kind: 'groups',
		id: PUBLISHERS_SECTION,
		heading: localize('editorMigration.publishers.title', "Confirm Extension Publishers"),
		lead: localize('editorMigration.publishers.description', "These publishers provide extensions in the reviewed import. This confirmation applies only to this import and does not change Hucode's trusted publisher settings."),
		groups,
		emptyText: groups.length ? undefined : localize('editorMigration.publishers.empty', "This import installs no extensions from a publisher."),
	};
}

function applyOverviewPanel(state: EditorMigrationFlowState): EditorMigrationSetupPanel {
	const progress = state.progress;
	const plan = state.reviewedPlan ?? state.operation?.plan;
	const rollback = progress?.stage === 'rollbackPending' ? progress.rollback : undefined;
	const rows = !rollback && plan
		? ORDERED_CATEGORIES.filter(category => plan.choices.selectedCategories.includes(category)).map(category => ({
			id: category,
			label: CATEGORY_LABELS[category],
			state: applyCategoryStateLabel(category, progress, plan),
		}))
		: [];
	const active = !rollback ? activeProgressItem(progress, plan) : undefined;
	return {
		kind: 'applyOverview',
		id: OVERVIEW_SECTION,
		heading: state.canceling ? localize('editorMigration.apply.canceling', "Canceling...") : localize('editorMigration.apply.title', "Importing Setup..."),
		progress: {
			text: progress ? progressStatusLabel(progress) : localize('editorMigration.apply.admitting', "Verifying and admitting the reviewed import..."),
			min: 0,
			max: rollback?.resourceCount ?? progress?.selectedItemCount ?? 1,
			now: rollback?.restoredResourceCount ?? progress?.results.length ?? 0,
		},
		rows,
		currentItem: active ? localize('editorMigration.apply.currentItem', "Working on {0}.", active) : undefined,
		note: localize('editorMigration.apply.recoveryNote', "Recovery copies are saved before any file changes."),
	};
}

function applyCategoryPanel(state: EditorMigrationFlowState, category: EditorMigrationCategory): EditorMigrationSetupPanel {
	const plan = state.reviewedPlan ?? state.operation?.plan;
	const results = (state.progress?.results ?? []).filter(result => result.category === category);
	const problems = results.filter(result => isEditorMigrationProblemOutcome(result.outcome));
	const succeeded = results.length - problems.length;
	const { rows, overflowText } = problemRows(problems, plan);
	return {
		kind: 'applyCategory',
		id: category,
		heading: CATEGORY_LABELS[category],
		lead: applyCategoryStateLabel(category, state.progress, plan),
		problems: rows,
		problemOverflowText: overflowText,
		recordedNote: succeeded > 0 ? localize('editorMigration.apply.recorded', "{0} items recorded so far.", succeeded) : undefined,
	};
}

function resultsPanel(state: EditorMigrationFlowState, sectionId: string): EditorMigrationSetupPanel {
	const operation = state.operation;
	if (!operation) {
		return { kind: 'message', id: sectionId, heading: localize('editorMigration.results.title', "Import Results") };
	}
	if (sectionId === RESTORE_SECTION) {
		return restorePanel(state, operation);
	}
	if (sectionId === NOT_IMPORTED_SECTION) {
		const selectedCategories = operation.plan.choices.selectedCategories;
		return {
			kind: 'groups',
			id: sectionId,
			heading: localize('editorMigration.section.notImported', "Not Imported"),
			lead: localize('editorMigration.results.notImportedLead', "{0} items were held back during review, grouped by reason.", editorMigrationNotImportedCount(operation.plan, selectedCategories)),
			groups: editorMigrationNotImportedGroups(operation.plan, selectedCategories).map(toGroupDto),
		};
	}
	if (sectionId !== OVERVIEW_SECTION) {
		return resultsCategoryPanel(operation, sectionId as EditorMigrationCategory);
	}

	const problems = operation.results.filter(result => isEditorMigrationProblemOutcome(result.outcome));
	const placements = editorMigrationPlacementGroups(operation);
	const preserved = operation.plan.choices.decisions.filter(decision => decision.choice === 'preserveTarget');
	return {
		kind: 'resultsOverview',
		id: OVERVIEW_SECTION,
		heading: localize('editorMigration.results.title', "Import Results"),
		outcome: operation.aggregateOutcome ? aggregateOutcomeLabel(operation.aggregateOutcome) : stageLabel(operation.stage),
		lead: problems.length
			? localize('editorMigration.results.leadProblems', "{0} of {1} recorded items need attention. Open the marked sections to act on them.", problems.length, operation.results.length)
			: localize('editorMigration.results.lead', "{0} items were recorded without problems.", operation.results.length),
		placementsHeading: placements.length ? localize('editorMigration.results.extensionPlacement', "Extension Placement") : undefined,
		placements: placements.map(toGroupDto),
		preserved: preserved.length
			? disclosure('preserved', localize('editorMigration.results.preserved', "{0} current values were kept during review", preserved.length), preserved.map(decision => preservedDecisionLabel(decision.id)))
			: undefined,
		rollbackOutcome: operation.rollbackIntent?.mutationStarted
			? {
				heading: localize('editorMigration.results.rollbackOutcome', "File Rollback Outcome"),
				rows: operation.rollbackIntent.categories.map(category => {
					const resources = operation.rollbackIntent!.resources.filter(resource => resource.category === category);
					const restored = resources.filter(resource => resource.state === 'restored').length;
					return localize('editorMigration.results.rollbackStatus', "{0}: {1} restored; {2} remaining or refused.", CATEGORY_LABELS[category], restored, resources.length - restored);
				}),
				note: localize('editorMigration.results.rollbackForwardRetryUnavailable', "Forward import retry is unavailable because file restoration already began."),
			}
			: undefined,
	};
}

function resultsCategoryPanel(operation: EditorMigrationOperation, category: EditorMigrationCategory): EditorMigrationSetupPanel {
	const results = operation.results.filter(result => result.category === category);
	const problems = results.filter(result => isEditorMigrationProblemOutcome(result.outcome));
	const succeeded = results.filter(result => !isEditorMigrationProblemOutcome(result.outcome));
	const { rows, overflowText } = problemRows(problems, operation.plan);
	return {
		kind: 'resultsCategory',
		id: category,
		heading: CATEGORY_LABELS[category],
		lead: problems.length
			? localize('editorMigration.results.categoryProblems', "{0} succeeded, {1} need attention.", results.length - problems.length, problems.length)
			: localize('editorMigration.results.categoryClean', "{0} items completed without problems.", results.length),
		problemsHeading: problems.length ? localize('editorMigration.results.needAttention', "{0} need attention", problems.length) : undefined,
		problems: rows,
		problemOverflowText: overflowText,
		completed: succeeded.length
			? disclosure(
				'completed',
				localize('editorMigration.results.completed', "{0} completed successfully", succeeded.length),
				succeeded.map(result => editorMigrationResultLabel(result, operation.plan)),
				localize('editorMigration.results.completedNote', "Routine successes stay collapsed. Copy the report for the complete record."),
			)
			: undefined,
		emptyText: results.length ? undefined : localize('editorMigration.results.categoryEmpty', "No results were recorded for this category."),
	};
}

function restorePanel(state: EditorMigrationFlowState, operation: EditorMigrationOperation): EditorMigrationSetupPanel {
	const heading = localize('editorMigration.section.restore', "Undo File Changes");
	if (operation.rollbackIntent?.mutationStarted) {
		return { kind: 'restore', id: RESTORE_SECTION, heading, lead: localize('editorMigration.rollback.alreadyStarted', "File restoration already began for this import.") };
	}
	const eligible = editorMigrationRollbackEligibleCategories(operation);
	if (operation.stage !== 'settled' || !eligible.length) {
		return { kind: 'restore', id: RESTORE_SECTION, heading, placeholder: localize('editorMigration.rollback.unavailable', "No proven file changes from this import can be restored.") };
	}
	const inspection = state.rollbackInspection;
	const drifted = inspection?.driftedCategories ?? [];
	return {
		kind: 'restore',
		id: RESTORE_SECTION,
		heading,
		lead: localize('editorMigration.rollback.lead', "Settings, keyboard shortcuts, and snippets can be restored. Extension changes stay installed."),
		selection: {
			legend: localize('editorMigration.results.rollbackCategories', "File categories to restore"),
			options: eligible.map(category => ({ category: category as EditorMigrationSetupFileCategory, label: CATEGORY_LABELS[category] })),
			inspectLabel: localize('editorMigration.results.inspectRollback', "Check File Rollback"),
		},
		inspection: inspection
			? drifted.length
				? {
					heading: localize('editorMigration.rollback.changed', "Files Changed After Import"),
					description: localize('editorMigration.rollback.changed.description', "{0} changed after import. Force rollback will save copies of the current files before restoring those categories. Extension changes stay installed.", drifted.map(category => CATEGORY_LABELS[category]).join(', ')),
					actionLabel: localize('editorMigration.rollback.force', "Force Rollback and Save Current Copies"),
					forced: true,
					driftedCategories: drifted as readonly EditorMigrationSetupFileCategory[],
				}
				: {
					description: localize('editorMigration.rollback.ready', "Settings, keyboard shortcuts, and snippets can be restored. Extension changes stay installed."),
					actionLabel: localize('editorMigration.rollback.run', "Roll Back File Changes"),
					forced: false,
					driftedCategories: [],
				}
			: undefined,
	};
}

// #endregion

// #region footer

function footerFor(state: EditorMigrationFlowState): EditorMigrationSetupPresentation['footer'] {
	const back = action('back', localize('editorMigration.back', "Back"), { type: 'back' });
	switch (state.phase) {
		case 'loading':
			return { lines: [], actions: [] };
		case 'recovery':
			return {
				lines: [state.recoveries.length === 1
					? localize('editorMigration.recovery.footerStateOne', "1 recoverable import.")
					: localize('editorMigration.recovery.footerState', "{0} recoverable imports.", state.recoveries.length)],
				actions: [action('start-import', localize('editorMigration.recovery.new', "Start Another Import"), { type: 'startImport' })],
			};
		case 'application':
			return {
				lines: [state.applications.length === 1
					? localize('editorMigration.application.footerStateOne', "1 application found.")
					: localize('editorMigration.application.footerState', "{0} applications found.", state.applications.length)],
				actions: [action('refresh', localize('editorMigration.refresh', "Refresh"), { type: 'refreshDiscovery' })],
			};
		case 'profile': {
			const application = state.applications.find(candidate => candidate.id === state.selectedApplicationId);
			const selected = application?.profiles.find(source => source.ref.value === state.selectedSourceRef?.value);
			return {
				lines: [selected
					? localize('editorMigration.profile.footerState', "{0} selected.", selected.profile.name)
					: localize('editorMigration.profile.footerNone', "Choose a profile to continue.")],
				actions: [
					back,
					action('profile-continue', localize('editorMigration.continue', "Continue"), { type: 'continueFromProfile' }, 'primary', !state.selectedSourceRef || state.busy),
				],
			};
		}
		case 'target':
			return {
				lines: [],
				actions: [
					back,
					action('target-continue', localize('editorMigration.review', "Review Import"), { type: 'continueFromTarget' }, 'primary', !state.selectedTarget || state.busy),
				],
			};
		case 'review': {
			const draft = state.draft;
			if (!draft) {
				return { lines: [], actions: [back] };
			}
			const counts = editorMigrationImportCounts(draft, state.decisions, state.selectedCategories);
			return {
				lines: [
					localize('editorMigration.review.footerRoute', "{0} into {1}.", draft.source.profile.name, targetDisplayName(draft)),
					localize('editorMigration.review.footerState', "{0} items ready to import. {1} current values kept. {2} held back.", counts.ready, counts.kept, editorMigrationNotImportedCount(draft, state.selectedCategories)),
				],
				actions: [
					back,
					state.reviewNeedsRebuild
						? action('review-rebuild', localize('editorMigration.review.rebuild', "Rebuild Review"), { type: 'rebuildReview' }, 'primary', state.busy)
						: action('review-continue', localize('editorMigration.review.continue', "Continue"), { type: 'acceptReview' }, 'primary', state.busy || !state.selectedCategories.length),
				],
			};
		}
		case 'publishers':
			return {
				lines: [localize('editorMigration.publishers.footerState', "{0} publishers · confirmation applies to this import only.", state.publishers.length)],
				actions: [
					back,
					action('publishers-confirm', localize('editorMigration.publishers.confirm', "Confirm Publishers and Import"), { type: 'confirmPublishers' }, 'primary', state.busy),
				],
			};
		case 'apply':
			return {
				lines: [state.progress ? progressStatusLabel(state.progress) : localize('editorMigration.apply.admitting', "Verifying and admitting the reviewed import...")],
				actions: [action(
					'apply-cancel',
					state.canceling ? localize('editorMigration.apply.canceling', "Canceling...") : localize('editorMigration.apply.cancel', "Cancel Import"),
					{ type: 'requestCancellation' },
					'default',
					state.canceling,
				)],
			};
		case 'results':
			return resultsFooter(state);
	}
}

function resultsFooter(state: EditorMigrationFlowState): EditorMigrationSetupPresentation['footer'] {
	const operation = state.operation;
	if (!operation) {
		return { lines: [], actions: [] };
	}
	const actions: EditorMigrationSetupAction[] = [
		action('results-copy', localize('editorMigration.results.copy', "Copy Report"), { type: 'copyReport' }),
		action('results-another', localize('editorMigration.results.another', "Import Another Setup"), { type: 'startImport' }),
	];
	if (operation.stage !== 'rolledBack' && operation.stage !== 'rollbackPending' && !operation.rollbackIntent?.mutationStarted
		&& operation.results.some(result => ['failed', 'unavailable', 'canceled'].includes(result.outcome))) {
		actions.push(action('results-retry', localize('editorMigration.results.retry', "Retry Failed Items"), { type: 'retry', operationId: operation.id }));
	}
	if (operation.stage !== 'settled' && operation.stage !== 'rolledBack') {
		actions.push(action('results-resume', localize('editorMigration.results.resume', "Resume"), { type: 'resume', operationId: operation.id }));
	}
	const lines = [operation.aggregateOutcome ? aggregateOutcomeLabel(operation.aggregateOutcome) : stageLabel(operation.stage)];
	if (operation.rollbackIntent?.mutationStarted) {
		lines.push(localize('editorMigration.results.rollbackForwardRetryUnavailable', "Forward import retry is unavailable because file restoration already began."));
	}
	if ((operation.stage === 'settled' || operation.stage === 'rolledBack') && operation.aggregateOutcome) {
		lines.push(localize('editorMigration.results.acknowledge.description', "Removing recovery data deletes the retained snapshots used for file rollback."));
		actions.push(
			action('results-done', localize('editorMigration.results.done', "Done"), { type: 'close' }, 'primary'),
			action('results-acknowledge', localize('editorMigration.results.acknowledge', "Done and Remove Recovery Data"), { type: 'acknowledge' }, 'danger'),
		);
	}
	return { lines, actions };
}

// #endregion

// #region shared mapping

function action(
	id: string,
	label: string,
	intent: EditorMigrationSetupAction['intent'],
	kind: EditorMigrationSetupAction['kind'] = 'default',
	disabled = false,
): EditorMigrationSetupAction {
	return { id, label, kind, disabled, intent };
}

function disclosure(id: string, summary: string, items: readonly string[], note?: string): EditorMigrationSetupDisclosure {
	const { shown, remaining } = editorMigrationVisibleItems(items);
	return {
		id,
		summary,
		note,
		items: shown,
		remainingText: remaining ? localize('editorMigration.group.more', "and {0} more.", remaining) : undefined,
	};
}

function toGroupDto(group: EditorMigrationAggregateGroup): EditorMigrationSetupGroup {
	return {
		id: group.id,
		title: group.title,
		count: group.count,
		countDescription: localize('editorMigration.group.count', "{0} items.", group.count),
		disclosure: group.items.length
			? disclosure(`group:${group.id}`, localize('editorMigration.group.show', "Show {0} items", group.items.length), group.items)
			: undefined,
	};
}

/** Problem rows, truncated the same way the report's own listing is. */
function problemRows(
	problems: readonly EditorMigrationItemResult[],
	plan: EditorMigrationReviewedPlan | undefined,
): { readonly rows: readonly EditorMigrationSetupProblemRow[]; readonly overflowText?: string } {
	const { shown, remaining } = editorMigrationVisibleItems(problems.map(problem => problem.id));
	return {
		rows: shown.map(id => {
			const problem = problems.find(candidate => candidate.id === id)!;
			return {
				id,
				text: editorMigrationResultLabel(problem, plan),
				detail: problem.diagnostic ? resultDiagnosticLabel(problem.diagnostic.code) : undefined,
				outcome: problem.outcome,
			};
		}),
		overflowText: remaining ? localize('editorMigration.results.moreProblems', "and {0} more in the copied report.", remaining) : undefined,
	};
}

// #endregion

// #region localized labels

function phaseGroup(phase: EditorMigrationFlowState['phase']): 'discover' | 'review' | 'apply' | 'results' {
	switch (phase) {
		case 'loading':
		case 'recovery':
		case 'application':
		case 'profile':
		case 'target': return 'discover';
		case 'review':
		case 'publishers': return 'review';
		case 'apply': return 'apply';
		case 'results': return 'results';
	}
}

function phaseLabel(phase: EditorMigrationFlowState['phase']): string {
	switch (phaseGroup(phase)) {
		case 'discover': return localize('editorMigration.step.discover', "Discover");
		case 'review': return localize('editorMigration.step.review', "Review");
		case 'apply': return localize('editorMigration.step.apply', "Apply");
		case 'results': return localize('editorMigration.step.results', "Results");
	}
}

function targetDisplayName(draft: EditorMigrationPlanDraft): string {
	return draft.target.profile?.name ?? (draft.target.selection.kind === 'proposed' ? draft.target.selection.name : '');
}

function ownershipLabel(draft: EditorMigrationPlanDraft, category: EditorMigrationCategory, included: boolean): string {
	const snapshot = draft.target.categories.find(candidate => candidate.category === category);
	const materializes = draft.prerequisites.some(prerequisite => prerequisite.category === category);
	if (snapshot?.ownership === 'default' || materializes) {
		return included
			? localize('editorMigration.review.ownershipDefault', "Currently inherited from Default; Hucode will copy it into {0} before importing.", targetDisplayName(draft))
			: localize('editorMigration.review.ownershipDefaultExcluded', "Currently inherited from Default.");
	}
	return localize('editorMigration.review.ownershipTarget', "Stored directly in {0}.", targetDisplayName(draft));
}

function additionsSummary(category: EditorMigrationCategory, count: number): string {
	switch (category) {
		case 'settings': return localize('editorMigration.review.newSettings', "{0} new settings", count);
		case 'keybindings': return localize('editorMigration.review.newKeybindings', "{0} new keyboard shortcuts", count);
		case 'snippets': return localize('editorMigration.review.newSnippets', "{0} new snippet files", count);
		case 'extensions': return localize('editorMigration.review.plannedExtensions', "{0} planned installations", count);
	}
}

function additionsExplanation(category: EditorMigrationCategory): string {
	return category === 'extensions'
		? localize('editorMigration.review.plannedExtensionsNote', "Exact versions and platforms are recorded in the plan; no decisions are needed here.")
		: localize('editorMigration.review.additionsNote', "No decisions are needed for these additions.");
}

function conflictName(decision: EditorMigrationDraftDecision): string {
	if (decision.category === 'keybindings') {
		const source = isJsonObject(decision.source) ? decision.source : {};
		const key = typeof source.key === 'string' ? source.key : localize('editorMigration.review.keybindingUnknownKey', "an unassigned key");
		const command = typeof source.command === 'string' ? source.command : localize('editorMigration.review.keybindingUnknownCommand', "an unknown command");
		return localize('editorMigration.review.keybindingConflict', "{0} for {1}", key, command);
	}
	return decision.item;
}

function diagnosticLabel(diagnostic: EditorMigrationDiagnostic): string {
	const category = diagnostic.category ? `${CATEGORY_LABELS[diagnostic.category]}: ` : '';
	const message = (() => {
		switch (diagnostic.code) {
			case 'candidateAbsent': return localize('editorMigration.diagnostic.candidateAbsent', "No installation data was found at this candidate location.");
			case 'permissionDeniedOrLocked': return localize('editorMigration.diagnostic.permissionDenied', "The source is locked or Hucode does not have permission to read it.");
			case 'malformedKnownResource': return localize('editorMigration.diagnostic.malformed', "The source resource is malformed and cannot be imported.");
			case 'unsupportedNamedProfileCatalogSchema': return localize('editorMigration.diagnostic.catalogSchema', "The editor's profile catalog uses an unsupported format.");
			case 'sourceChangedDuringRead': return localize('editorMigration.diagnostic.changed', "The source changed while Hucode was reading it; refresh before importing.");
			case 'oversizedResource': return localize('editorMigration.diagnostic.oversized', "The source resource is too large to import safely.");
			case 'duplicateAlias': return localize('editorMigration.diagnostic.duplicateAlias', "This location refers to a source that is already listed.");
			case 'canceledOperation': return localize('editorMigration.diagnostic.canceled', "Reading this source was canceled.");
		}
	})();
	const path = diagnostic.details?.path ? localize('editorMigration.diagnostic.path', " Path: {0}", diagnostic.details.path) : '';
	return `${category}${message}${path}`;
}

function stageLabel(stage: EditorMigrationApplyProgress['stage']): string {
	switch (stage) {
		case 'admitted': return localize('editorMigration.stage.admitted', "Preparing the import");
		case 'attachingTarget': return localize('editorMigration.stage.attachingTarget', "Preparing the target profile");
		case 'snapshotting': return localize('editorMigration.stage.snapshotting', "Saving recovery copies");
		case 'materializing': return localize('editorMigration.stage.materializing', "Preparing inherited profile files");
		case 'applying': return localize('editorMigration.stage.applying', "Importing selected items");
		case 'settled': return localize('editorMigration.stage.settled', "Import finished");
		case 'rollbackPending': return localize('editorMigration.stage.rollbackPending', "Restoring file changes");
		case 'rolledBack': return localize('editorMigration.stage.rolledBack', "File changes restored");
	}
}

function outcomeLabel(outcome: EditorMigrationItemResult['outcome']): string {
	switch (outcome) {
		case 'completed': return localize('editorMigration.outcome.completed', "completed");
		case 'alreadyPresent': return localize('editorMigration.outcome.alreadyPresent', "already present");
		case 'skipped': return localize('editorMigration.outcome.skipped', "skipped");
		case 'unavailable': return localize('editorMigration.outcome.unavailable', "unavailable");
		case 'incompatible': return localize('editorMigration.outcome.incompatible', "incompatible");
		case 'canceled': return localize('editorMigration.outcome.canceled', "canceled");
		case 'failed': return localize('editorMigration.outcome.failed', "failed");
	}
}

function aggregateOutcomeLabel(outcome: NonNullable<EditorMigrationOperation['aggregateOutcome']>): string {
	switch (outcome) {
		case 'completed': return localize('editorMigration.aggregate.completed', "Import completed");
		case 'completedWithIssues': return localize('editorMigration.aggregate.completedWithIssues', "Import completed with issues");
		case 'recoverable': return localize('editorMigration.aggregate.recoverable', "Import can be resumed");
		case 'rolledBack': return localize('editorMigration.aggregate.rolledBack', "File changes were restored");
	}
}

function sourceModificationLabel(newestModificationTime: number): string {
	return newestModificationTime > 0
		? localize('editorMigration.profile.modified', "Newest source change: {0}", new Date(newestModificationTime).toLocaleString())
		: localize('editorMigration.profile.modifiedUnknown', "No readable source modification time was found.");
}

function resultDiagnosticLabel(code: string): string {
	switch (code) {
		case 'rollbackDrift': return localize('editorMigration.result.rollbackDrift', "Not restored because the file changed after rollback began.");
		case 'targetDrift': return localize('editorMigration.result.targetDrift', "Not imported because the target changed after review.");
		case 'categoryWriteFailed': return localize('editorMigration.result.categoryWriteFailed', "Hucode could not write this category. Check permissions and try again.");
		case 'extensionServiceUnavailable': return localize('editorMigration.result.extensionServiceUnavailable', "The extension service is unavailable. Reload Hucode and retry.");
		case 'extensionInstallDrift': return localize('editorMigration.result.extensionInstallDrift', "The extension changed after review and was not installed.");
		case 'extensionInstallFailed': return localize('editorMigration.result.extensionInstallFailed', "The extension installation failed. Retry from these results.");
		case 'exactReleaseUnavailable':
		case 'exactManifestUnavailable': return localize('editorMigration.result.releaseUnavailable', "The reviewed extension release is no longer available.");
		case 'exactReleaseChanged':
		case 'exactReleaseIncompatible': return localize('editorMigration.result.releaseChanged', "The reviewed extension release is no longer compatible.");
		default: return localize('editorMigration.result.failedSafely', "Hucode stopped this item safely. Copy the report for diagnostic details.");
	}
}

function progressStatusLabel(progress: EditorMigrationApplyProgress): string {
	if (progress.stage === 'rollbackPending' && progress.rollback) {
		const categories = progress.rollback.categories.map(category => CATEGORY_LABELS[category]).join(', ');
		return localize('editorMigration.apply.rollbackProgress', "Restoring {0}. {1} of {2} file resources restored.", categories, progress.rollback.restoredResourceCount, progress.rollback.resourceCount);
	}
	return localize('editorMigration.apply.progress', "{0}. {1} of {2} items recorded.", stageLabel(progress.stage), progress.results.length, progress.selectedItemCount);
}

function applyCategoryStateLabel(category: EditorMigrationCategory, progress: EditorMigrationApplyProgress | undefined, plan: EditorMigrationReviewedPlan | undefined): string {
	const results = (progress?.results ?? []).filter(result => result.category === category);
	const problems = results.filter(result => isEditorMigrationProblemOutcome(result.outcome));
	const planned = plan?.operations.filter(operation => operation.category === category).length ?? 0;
	if (problems.length) {
		return localize('editorMigration.apply.categoryProblems', "{0} recorded, {1} need attention.", results.length, problems.length);
	}
	if (results.some(result => result.id === category)) {
		return localize('editorMigration.apply.categoryComplete', "Complete. {0} recorded.", results.length);
	}
	if (results.length) {
		return planned
			? localize('editorMigration.apply.categoryProgress', "In progress. {0} of {1} recorded.", results.length, planned)
			: localize('editorMigration.apply.categoryStarted', "In progress. {0} recorded.", results.length);
	}
	return localize('editorMigration.apply.categoryWaiting', "Waiting.");
}

function activeProgressItem(progress: EditorMigrationApplyProgress | undefined, plan: EditorMigrationReviewedPlan | undefined): string | undefined {
	if (!progress || progress.stage !== 'applying' || !plan) {
		return undefined;
	}
	const completed = new Set(progress.results.map(result => result.id));
	for (const category of ORDERED_CATEGORIES) {
		if (!plan.choices.selectedCategories.includes(category) || completed.has(category)) {
			continue;
		}
		if (category !== 'extensions') {
			return CATEGORY_LABELS[category];
		}
		const durableIntent = progress.extensionInstallIntents?.find(intent => !completed.has(intent.operationId));
		if (!durableIntent) {
			return localize('editorMigration.apply.resolvingExtensions', "Resolving extensions");
		}
		return plan.operations.find(operation => operation.id === durableIntent.operationId)?.item ?? localize('editorMigration.apply.installingExtension', "Installing an extension");
	}
	return undefined;
}

function editorMigrationResultLabel(result: EditorMigrationItemResult, plan: EditorMigrationReviewedPlan | undefined): string {
	const operation = plan?.operations.find(candidate => candidate.id === result.id);
	return operation
		? `${CATEGORY_LABELS[result.category]} · ${operation.item} · ${outcomeLabel(result.outcome)}`
		: `${CATEGORY_LABELS[result.category]} · ${outcomeLabel(result.outcome)}`;
}

function displayValue(value: EditorMigrationJsonValue | undefined): string {
	if (value === undefined) {
		return localize('editorMigration.review.valueMissing', "not set");
	}
	const serialized = JSON.stringify(value);
	return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
}

function isJsonObject(value: EditorMigrationJsonValue): value is Readonly<Record<string, EditorMigrationJsonValue>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function preservedDecisionLabel(id: string): string {
	if (id.startsWith('settings:')) {
		return localize('editorMigration.results.preservedSetting', "Setting {0}", id.slice('settings:'.length));
	}
	if (id.startsWith('snippets:')) {
		return localize('editorMigration.results.preservedSnippet', "Snippet {0}", id.slice('snippets:'.length).split(':')[0]);
	}
	if (id.startsWith('extensions:')) {
		return localize('editorMigration.results.preservedExtension', "Extension {0}", id.slice('extensions:'.length).split(':')[0]);
	}
	return localize('editorMigration.results.preservedKeybinding', "Keyboard shortcut difference");
}

// #endregion
