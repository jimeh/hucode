/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, clearNode, EventType, isHTMLElement, isHTMLInputElement, isKeyboardEvent } from '../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../base/browser/keyboardEvent.js';
import { IListRenderer, IListVirtualDelegate } from '../../../base/browser/ui/list/list.js';
import { List } from '../../../base/browser/ui/list/listWidget.js';
import { KeyCode } from '../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { EditorMigrationApplyProgress, EditorMigrationItemResult, EditorMigrationOperation } from '../../common/migration/editorMigrationApply.js';
import { EditorMigrationCategory, EditorMigrationDiagnostic, EditorMigrationJsonValue, EditorMigrationSourceDescriptor } from '../../common/migration/editorMigrationSource.js';
import { EditorMigrationDraftDecision, EditorMigrationPlanDraft, EditorMigrationReviewedPlan } from '../../common/migration/editorMigrationPlanning.js';
import { EditorMigrationFlowSession, EditorMigrationFlowState } from './editorMigrationFlow.js';
import {
	CATEGORY_LABELS,
	EditorMigrationAggregateGroup,
	EditorMigrationSection,
	EditorMigrationSectionStatus,
	NOT_IMPORTED_SECTION,
	OVERVIEW_SECTION,
	PUBLISHERS_SECTION,
	RESTORE_SECTION,
	editorMigrationApplySections,
	editorMigrationDefaultSection,
	editorMigrationExclusionGroups,
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

/** Filter and search controls only appear once a list is too long to scan. */
const FILTER_THRESHOLD = 8;

/** Beyond this many comparison rows the user needs the filter rather than more scrolling. */
const CONFLICT_ROW_LIMIT = 60;

const ORDERED: readonly EditorMigrationCategory[] = ['settings', 'keybindings', 'snippets', 'extensions'];

interface EditorMigrationVirtualListState {
	scrollTop: number;
	focusedIdentity?: string;
}

/** Shared migration flow view. Hosts supply only framing and completion behavior. */
export class EditorMigrationFlowView extends Disposable {
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly root: HTMLElement;
	private readonly status: HTMLElement;
	private readonly filters = new Map<string, string>();
	private readonly composingFilters = new Set<string>();
	private readonly virtualListStates = new Map<string, EditorMigrationVirtualListState>();
	private readonly rollbackSelections = new Map<string, Set<Exclude<EditorMigrationCategory, 'extensions'>>>();
	private readonly activeSections = new Map<string, string>();
	private readonly detailScrollTops = new Map<string, number>();
	private detail: HTMLElement | undefined;
	private detailScrollKey: string | undefined;
	private rowDisposables: DisposableStore | undefined;
	private initialFocus: HTMLElement | undefined;
	private sectionAnnouncement: string | undefined;

	constructor(
		parent: HTMLElement,
		private readonly session: EditorMigrationFlowSession,
		private readonly onDone: () => void,
	) {
		super();
		this.root = document.createElement('div');
		this.root.className = 'hucode-editor-migration-flow';
		this.root.setAttribute('role', 'region');
		this.root.setAttribute('aria-label', localize('editorMigration.region', "Editor Setup Import"));
		this.status = document.createElement('div');
		this.status.className = 'hucode-editor-migration-sr-only';
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.status.setAttribute('aria-atomic', 'true');
		parent.append(this.root, this.status);
		this._register(this.session.onDidChangeState(state => this.render(state)));
		this.render(this.session.state);
	}

	private render(state: EditorMigrationFlowState): void {
		const activeElement = this.root.ownerDocument.activeElement as HTMLInputElement | null;
		const focusedId = activeElement?.dataset.migrationFocusId;
		const selection = activeElement && typeof activeElement.selectionStart === 'number'
			? { start: activeElement.selectionStart, end: activeElement.selectionEnd ?? activeElement.selectionStart, direction: activeElement.selectionDirection ?? undefined }
			: undefined;
		this.rememberDetailScroll();
		this.renderDisposables.clear();
		clearNode(this.root);
		this.root.appendChild(this.header(state));
		if (state.error) {
			this.root.appendChild(element('div', 'hucode-editor-migration-error', state.error, { role: 'alert' }));
		}

		const sections = this.sectionsFor(state);
		const activeId = this.activeSectionId(state, sections);
		const active = sections.find(section => section.id === activeId);
		const body = element('div', `hucode-editor-migration-body${sections.length ? ' indexed' : ''}`);
		if (sections.length) {
			body.appendChild(this.index(state, sections, activeId));
		}
		const detail = element('div', 'hucode-editor-migration-detail', undefined, { role: 'region', tabindex: '0' });
		detail.dataset.migrationFocusId = 'detail';
		detail.setAttribute('aria-label', active?.label ?? phaseLabel(state.phase));
		body.appendChild(detail);
		this.root.appendChild(body);

		const footer = this.renderPhase(detail, state, activeId);
		this.root.appendChild(footer);
		this.restoreDetailScroll(state, activeId, detail);

		this.status.textContent = [state.announcement, this.sectionAnnouncement].filter(Boolean).join(' ');
		this.sectionAnnouncement = undefined;
		if (focusedId) {
			const restored = findElementByFocusId(this.root, focusedId);
			restored?.focus();
			if (selection && isHTMLInputElement(restored)) {
				restored.setSelectionRange(selection.start, selection.end, selection.direction);
			}
		} else {
			this.initialFocus?.focus();
		}
	}

	private renderPhase(detail: HTMLElement, state: EditorMigrationFlowState, activeId: string | undefined): HTMLElement {
		switch (state.phase) {
			case 'loading': return this.renderLoading(detail);
			case 'recovery': return this.renderRecovery(detail, state);
			case 'application': return this.renderApplications(detail, state);
			case 'profile': return this.renderProfiles(detail, state);
			case 'target': return this.renderTargets(detail, state);
			case 'review': return this.renderReview(detail, state, activeId);
			case 'publishers': return this.renderPublishers(detail, state, activeId);
			case 'apply': return this.renderApply(detail, state, activeId);
			case 'results': return this.renderResults(detail, state, activeId);
		}
	}

	// #region framing

	private header(state: EditorMigrationFlowState): HTMLElement {
		const header = element('header', 'hucode-editor-migration-header');
		const title = element('h1', undefined, localize('editorMigration.title', "Import Setup from Another Editor"), { tabIndex: '-1' });
		this.initialFocus = title;
		const steps = element('ol', 'hucode-editor-migration-steps');
		for (const [id, label] of [
			['discover', localize('editorMigration.step.discover', "Discover")],
			['review', localize('editorMigration.step.review', "Review")],
			['apply', localize('editorMigration.step.apply', "Apply")],
			['results', localize('editorMigration.step.results', "Results")],
		] as const) {
			const item = element('li', phaseGroup(state.phase) === id ? 'active' : undefined, label);
			if (phaseGroup(state.phase) === id) {
				item.setAttribute('aria-current', 'step');
			}
			steps.appendChild(item);
		}
		header.append(title, steps);
		return header;
	}

	private sectionsFor(state: EditorMigrationFlowState): readonly EditorMigrationSection[] {
		switch (state.phase) {
			case 'review': return editorMigrationReviewSections(state);
			case 'publishers': return editorMigrationPublisherSections(state);
			case 'apply': return editorMigrationApplySections(state);
			case 'results': return editorMigrationResultsSections(state);
			default: return [];
		}
	}

	private activeSectionId(state: EditorMigrationFlowState, sections: readonly EditorMigrationSection[]): string | undefined {
		if (!sections.length) {
			return undefined;
		}
		const stored = this.activeSections.get(state.phase);
		if (stored && sections.some(section => section.id === stored)) {
			return stored;
		}
		const preferred = state.phase === 'publishers'
			? PUBLISHERS_SECTION
			: state.phase === 'apply'
				? OVERVIEW_SECTION
				: state.phase === 'review'
					? editorMigrationDefaultSection(sections, 'settings')
					: editorMigrationDefaultSection(sections, OVERVIEW_SECTION, OVERVIEW_SECTION);
		const resolved = preferred && sections.some(section => section.id === preferred) ? preferred : sections[0].id;
		this.activeSections.set(state.phase, resolved);
		return resolved;
	}

	private index(state: EditorMigrationFlowState, sections: readonly EditorMigrationSection[], activeId: string | undefined): HTMLElement {
		const nav = element('nav', 'hucode-editor-migration-index');
		nav.setAttribute('aria-label', localize('editorMigration.index.label', "Import sections"));
		nav.appendChild(element('div', 'hucode-editor-migration-index-label', phaseLabel(state.phase)));
		for (const section of sections) {
			if (section.separated) {
				nav.appendChild(element('div', 'hucode-editor-migration-index-break', undefined, { 'aria-hidden': 'true' }));
			}
			const button = document.createElement('button');
			button.type = 'button';
			button.className = `hucode-editor-migration-section ${section.status}${section.id === activeId ? ' active' : ''}`;
			button.dataset.migrationSection = section.id;
			button.dataset.migrationFocusId = `section-${section.id}`;
			if (section.id === activeId) {
				button.setAttribute('aria-current', 'true');
			}
			button.append(
				element('span', 'hucode-editor-migration-section-mark', statusMark(section.status), { 'aria-hidden': 'true' }),
				element('span', 'hucode-editor-migration-section-label', section.label),
				element('span', 'hucode-editor-migration-section-count', section.count === undefined ? '' : String(section.count), { 'aria-hidden': 'true' }),
				element('span', 'hucode-editor-migration-sr-only', sectionStatusDescription(section)),
			);
			this.addListener(button, EventType.CLICK, () => this.selectSection(state, section));
			nav.appendChild(button);
		}
		return nav;
	}

	private selectSection(state: EditorMigrationFlowState, section: EditorMigrationSection): void {
		if (this.activeSections.get(state.phase) === section.id) {
			return;
		}
		this.activeSections.set(state.phase, section.id);
		this.sectionAnnouncement = localize('editorMigration.index.showing', "Showing {0}.", section.label);
		this.render(this.session.state);
	}

	/** Keeps the detail pane's scroll position across the view's full rerender model. */
	private rememberDetailScroll(): void {
		if (this.detail && this.detailScrollKey) {
			this.detailScrollTops.set(this.detailScrollKey, this.detail.scrollTop);
		}
	}

	private restoreDetailScroll(state: EditorMigrationFlowState, activeId: string | undefined, detail: HTMLElement): void {
		this.detail = detail;
		this.detailScrollKey = `${state.phase}:${activeId ?? ''}`;
		detail.scrollTop = this.detailScrollTops.get(this.detailScrollKey) ?? 0;
	}

	// #endregion

	// #region discovery phases

	private renderLoading(parent: HTMLElement): HTMLElement {
		parent.appendChild(element('h2', undefined, localize('editorMigration.loading', "Looking for editor profiles..."), { tabIndex: '-1' }));
		parent.appendChild(element('div', 'hucode-editor-migration-progress', localize('editorMigration.loading.detail', "Reading supported local editor installations."), { role: 'progressbar' }));
		return this.footer([]);
	}

	private renderRecovery(parent: HTMLElement, state: EditorMigrationFlowState): HTMLElement {
		parent.appendChild(element('h2', undefined, localize('editorMigration.recovery.title', "Continue an Earlier Import"), { tabIndex: '-1' }));
		parent.appendChild(element('p', 'hucode-editor-migration-lead', localize('editorMigration.recovery.description', "Hucode found import data that still has results or recovery actions available.")));
		this.virtualList(parent, 'recoveries', state.recoveries, 112, recovery => recovery.id, recovery => recovery.targetName ?? localize('editorMigration.recovery.unknownTarget', "Unknown Target"), recovery => {
			const card = element('article', 'hucode-editor-migration-card');
			card.append(
				element('h3', undefined, recovery.targetName ?? localize('editorMigration.recovery.unknownTarget', "Unknown Target")),
				element('p', undefined, recovery.unsupportedSchemaVersion === undefined ? `${stageLabel(recovery.stage)} · ${new Date(recovery.updatedAt).toLocaleString()}` : localize('editorMigration.recovery.unsupported', "This record was created by another Hucode version and will be kept untouched.")),
			);
			if (recovery.unsupportedSchemaVersion === undefined) {
				card.appendChild(this.button(localize('editorMigration.recovery.open', "View or Continue"), () => void this.session.showRecovery(recovery.id), `recovery-${recovery.id}`));
			}
			return card;
		}, recovery => recovery.unsupportedSchemaVersion === undefined && void this.session.showRecovery(recovery.id));
		return this.footer(
			[state.recoveries.length === 1
				? localize('editorMigration.recovery.footerStateOne', "1 recoverable import.")
				: localize('editorMigration.recovery.footerState', "{0} recoverable imports.", state.recoveries.length)],
			this.button(localize('editorMigration.recovery.new', "Start Another Import"), () => void this.session.startImport(), 'start-import'),
		);
	}

	private renderApplications(parent: HTMLElement, state: EditorMigrationFlowState): HTMLElement {
		parent.appendChild(element('h2', undefined, localize('editorMigration.application.title', "Which Application Should Hucode Import From?"), { tabIndex: '-1' }));
		parent.appendChild(element('p', 'hucode-editor-migration-lead', localize('editorMigration.application.description', "Choose an editor first. You will choose one of its profiles next.")));
		const filterText = this.filter('applications');
		if (state.applications.length > FILTER_THRESHOLD) {
			parent.appendChild(this.filterInput('applications', localize('editorMigration.application.filter', "Filter applications")));
		}
		const applications = state.applications.filter(application => application.productName.toLowerCase().includes(filterText.toLowerCase()));
		if (applications.length) {
			this.virtualList(parent, 'applications', applications, 76, application => application.id, application => application.productName, application => {
				const button = this.button('', () => this.session.selectApplication(application.id), `application-${application.id}`, 'hucode-editor-migration-choice-card');
				button.append(
					element('strong', undefined, application.productName),
					element('span', undefined, application.profiles.length === 1
						? localize('editorMigration.application.profile', "1 profile")
						: localize('editorMigration.application.profiles', "{0} profiles", application.profiles.length)),
				);
				return button;
			}, application => this.session.selectApplication(application.id));
		} else {
			parent.appendChild(element('p', undefined, localize('editorMigration.application.empty', "No supported editor profiles were found.")));
		}
		if (state.discoveryDiagnostics.length) {
			parent.appendChild(this.discoveryDetails(state.discoveryDiagnostics));
		}
		return this.footer(
			[state.applications.length === 1
				? localize('editorMigration.application.footerStateOne', "1 application found.")
				: localize('editorMigration.application.footerState', "{0} applications found.", state.applications.length)],
			this.button(localize('editorMigration.refresh', "Refresh"), () => void this.session.refreshDiscovery(), 'refresh'),
		);
	}

	private renderProfiles(parent: HTMLElement, state: EditorMigrationFlowState): HTMLElement {
		const application = state.applications.find(candidate => candidate.id === state.selectedApplicationId);
		parent.appendChild(element('h2', undefined, localize('editorMigration.profile.title', "Choose a {0} Profile", application?.productName ?? ''), { tabIndex: '-1' }));
		if (!application) {
			return this.footer([], this.button(localize('editorMigration.back', "Back"), () => this.session.back(), 'profile-back'));
		}
		const filterText = this.filter('profiles');
		if (application.profiles.length > FILTER_THRESHOLD) {
			parent.appendChild(this.filterInput('profiles', localize('editorMigration.profile.filter', "Filter profiles")));
		}
		const profiles = application.profiles.filter(profile => profile.profile.name.toLowerCase().includes(filterText.toLowerCase()));
		this.virtualList(parent, 'profiles', profiles, 84, source => source.ref.value, source => source.profile.name, source => {
			const row = element('div', 'hucode-editor-migration-radio-row');
			const choice = element('label', 'hucode-editor-migration-profile-choice');
			const radio = document.createElement('input');
			radio.type = 'radio';
			radio.name = 'migration-source-profile';
			radio.checked = state.selectedSourceRef?.value === source.ref.value;
			radio.dataset.migrationFocusId = `profile-${source.ref.value}`;
			this.addListener(radio, EventType.CHANGE, () => this.session.selectSourceProfile(source.ref));
			const summary = source.categories.map(category => `${CATEGORY_LABELS[category.category]}: ${resourceStateLabel(category.state, category.itemCount)}`).join(' · ');
			choice.append(radio, element('span', undefined, `${source.profile.name} · ${summary}`));
			row.append(choice);
			return row;
		}, source => this.session.selectSourceProfile(source.ref));
		const selectedSource = application.profiles.find(source => source.ref.value === state.selectedSourceRef?.value);
		if (selectedSource) {
			parent.appendChild(this.sourceDetails(selectedSource));
		}
		return this.footer(
			[selectedSource ? localize('editorMigration.profile.footerState', "{0} selected.", selectedSource.profile.name) : localize('editorMigration.profile.footerNone', "Choose a profile to continue.")],
			this.button(localize('editorMigration.back', "Back"), () => this.session.back(), 'profile-back'),
			this.button(localize('editorMigration.continue', "Continue"), () => void this.session.continueFromProfile(), 'profile-continue', 'primary', !state.selectedSourceRef || state.busy),
		);
	}

	private renderTargets(parent: HTMLElement, state: EditorMigrationFlowState): HTMLElement {
		parent.appendChild(element('h2', undefined, localize('editorMigration.target.title', "Where Should Hucode Import This Setup?"), { tabIndex: '-1' }));
		parent.appendChild(element('p', 'hucode-editor-migration-lead', localize('editorMigration.target.description', "Default is selected. You can choose another existing profile or name a new one.")));
		const list = element('div', 'hucode-editor-migration-card-list');
		for (const target of state.targets) {
			const row = element('label', 'hucode-editor-migration-radio-row');
			const radio = document.createElement('input');
			radio.type = 'radio';
			radio.name = 'migration-target';
			radio.checked = state.selectedTarget?.kind === 'existing' && state.selectedTarget.profileId === target.selection.profileId;
			radio.dataset.migrationFocusId = `target-${target.selection.profileId}`;
			this.addListener(radio, EventType.CHANGE, () => this.session.selectTarget(target.selection));
			row.append(radio, element('span', undefined, target.kind === 'default' ? localize('editorMigration.target.default', "Default (Recommended)") : target.name));
			list.appendChild(row);
		}
		const newProfile = document.createElement('input');
		newProfile.type = 'text';
		newProfile.placeholder = localize('editorMigration.target.new.placeholder', "New profile name");
		newProfile.setAttribute('aria-label', localize('editorMigration.target.new.label', "New profile name"));
		newProfile.value = state.selectedTarget?.kind === 'proposed' ? state.selectedTarget.name : '';
		newProfile.dataset.migrationFocusId = 'target-new-name';
		const useNew = this.button(localize('editorMigration.target.new.use', "Use New Profile"), () => {
			if (newProfile.value.trim()) {
				this.session.selectTarget({ kind: 'proposed', name: newProfile.value.trim() });
			}
		}, 'target-new-use');
		const newRow = element('div', 'hucode-editor-migration-new-target');
		newRow.append(newProfile, useNew);
		if (state.selectedTarget?.kind === 'proposed') {
			newRow.appendChild(element('span', 'hucode-editor-migration-target-selected', localize('editorMigration.target.new.selected', "Selected new profile: {0}", state.selectedTarget.name), { role: 'status' }));
		}
		parent.append(list, newRow);
		return this.footer(
			[],
			this.button(localize('editorMigration.back', "Back"), () => this.session.back(), 'target-back'),
			this.button(localize('editorMigration.review', "Review Import"), () => void this.session.continueFromTarget(), 'target-continue', 'primary', !state.selectedTarget || state.busy),
		);
	}

	// #endregion

	// #region review

	private renderReview(parent: HTMLElement, state: EditorMigrationFlowState, activeId: string | undefined): HTMLElement {
		const draft = state.draft;
		if (!draft) {
			parent.appendChild(element('h2', undefined, localize('editorMigration.review.title', "Review What Will Change"), { tabIndex: '-1' }));
			return this.footer([], this.button(localize('editorMigration.back', "Back"), () => this.session.back(), 'review-back'));
		}
		this.renderReviewSection(parent, state, draft, activeId, false);
		const plannedCount = draft.decisions.filter(decision => state.selectedCategories.includes(decision.category)).length;
		return this.footer(
			[
				localize('editorMigration.review.footerRoute', "{0} into {1}.", draft.source.profile.name, targetDisplayName(draft)),
				localize('editorMigration.review.footerState', "{0} items ready to import. {1} held back.", plannedCount, editorMigrationNotImportedCount(draft, state.selectedCategories)),
			],
			this.button(localize('editorMigration.back', "Back"), () => this.session.back(), 'review-back'),
			state.reviewNeedsRebuild
				? this.button(localize('editorMigration.review.rebuild', "Rebuild Review"), () => void this.session.rebuildReview(), 'review-rebuild', 'primary', state.busy)
				: this.button(localize('editorMigration.review.continue', "Continue"), () => void this.session.acceptReview(), 'review-continue', 'primary', state.busy || !state.selectedCategories.length),
		);
	}

	/** Renders one review topic. `readonly` keeps publisher confirmation from re-opening review choices. */
	private renderReviewSection(parent: HTMLElement, state: EditorMigrationFlowState, draft: EditorMigrationPlanDraft, activeId: string | undefined, readOnly: boolean): void {
		if (activeId === NOT_IMPORTED_SECTION) {
			this.renderNotImported(parent, state, draft);
			return;
		}
		const category = ORDERED.find(candidate => candidate === activeId);
		if (!category) {
			return;
		}
		const included = state.selectedCategories.includes(category);
		const decisions = draft.decisions.filter(decision => decision.category === category);
		const conflicts = decisions.filter(decision => decision.kind === 'conflict');
		const additions = decisions.filter(decision => decision.kind === 'add');
		const available = editorMigrationSourceItemCount(draft, category);

		parent.appendChild(element('h2', undefined, CATEGORY_LABELS[category], { tabIndex: '-1' }));
		parent.appendChild(element('p', 'hucode-editor-migration-lead', conflicts.length
			? localize('editorMigration.review.leadWithConflicts', "{0} of {1} will be imported. {2} differ from your current values.", decisions.length, available, conflicts.length)
			: localize('editorMigration.review.lead', "{0} of {1} will be imported.", decisions.length, available)));

		if (!readOnly) {
			const include = element('label', 'hucode-editor-migration-include');
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = included;
			checkbox.dataset.migrationFocusId = `category-${category}`;
			this.addListener(checkbox, EventType.CHANGE, () => this.session.toggleCategory(category, checkbox.checked));
			include.append(checkbox, element('span', undefined, localize('editorMigration.review.include', "Include {0} in this import", CATEGORY_LABELS[category])));
			parent.appendChild(include);
		}
		parent.appendChild(element('p', 'hucode-editor-migration-note', ownershipLabel(draft, category)));

		if (!included) {
			parent.appendChild(element('p', 'hucode-editor-migration-placeholder', localize('editorMigration.review.excludedCategory', "This category is not included. Its {0} source items are listed under Not Imported.", available)));
			return;
		}

		if (conflicts.length) {
			parent.appendChild(element('h3', undefined, localize('editorMigration.review.differences', "{0} differ from your current values", conflicts.length)));
			if (!readOnly && category === 'settings') {
				const bulk = element('div', 'hucode-editor-migration-bulk');
				bulk.append(
					this.button(localize('editorMigration.review.keepAll', "Keep All Current Values"), () => this.session.chooseAllSettingDifferences('preserveTarget'), 'keep-all-settings'),
					this.button(localize('editorMigration.review.useAll', "Use Imported Values for All"), () => this.session.chooseAllSettingDifferences('import'), 'import-all-settings'),
				);
				parent.appendChild(bulk);
			}
			const filterId = `conflicts-${category}`;
			const filterText = this.filter(filterId);
			if (conflicts.length > FILTER_THRESHOLD) {
				parent.appendChild(this.filterInput(filterId, localize('editorMigration.review.filterDifferences', "Filter {0} differences", CATEGORY_LABELS[category])));
			}
			const visible = conflicts.filter(decision => conflictSearchText(decision).toLowerCase().includes(filterText.toLowerCase()));
			const rows = element('div', 'hucode-editor-migration-conflicts');
			for (const decision of visible.slice(0, CONFLICT_ROW_LIMIT)) {
				rows.appendChild(this.conflictRow(decision, state, readOnly));
			}
			parent.appendChild(rows);
			if (visible.length > CONFLICT_ROW_LIMIT) {
				parent.appendChild(element('p', 'hucode-editor-migration-note', localize('editorMigration.review.moreDifferences', "Showing the first {0} of {1} differences. Filter to reach the rest.", CONFLICT_ROW_LIMIT, visible.length)));
			}
		}

		const warnings = editorMigrationWarningGroups(draft.warnings, category);
		if (warnings.length) {
			parent.appendChild(element('h3', undefined, localize('editorMigration.review.notes', "Review Notes")));
			parent.appendChild(this.groupList(warnings));
		}

		if (additions.length) {
			parent.appendChild(this.disclosure(additionsSummary(category, additions.length), additions.map(decision => decision.item), additionsExplanation(category)));
		}

		const exclusions = editorMigrationExclusionGroups(draft.exclusions, category);
		if (exclusions.length) {
			parent.appendChild(element('p', 'hucode-editor-migration-note', localize('editorMigration.review.categoryExcluded', "{0} {1} items are held back. See Not Imported.", exclusions.reduce((total, group) => total + group.count, 0), CATEGORY_LABELS[category])));
		}
		if (!conflicts.length && !additions.length && !warnings.length) {
			parent.appendChild(element('p', 'hucode-editor-migration-placeholder', localize('editorMigration.review.nothingToDo', "This category has no decisions or changes.")));
		}
	}

	private renderNotImported(parent: HTMLElement, state: EditorMigrationFlowState, draft: EditorMigrationPlanDraft): void {
		const total = editorMigrationNotImportedCount(draft, state.selectedCategories);
		parent.appendChild(element('h2', undefined, localize('editorMigration.section.notImported', "Not Imported"), { tabIndex: '-1' }));
		parent.appendChild(element('p', 'hucode-editor-migration-lead', localize('editorMigration.notImported.lead', "{0} items are held back, grouped by reason.", total)));
		const groups = editorMigrationNotImportedGroups(draft, state.selectedCategories);
		if (!groups.length) {
			parent.appendChild(element('p', 'hucode-editor-migration-placeholder', localize('editorMigration.notImported.empty', "Everything the source offers is included in this import.")));
			return;
		}
		parent.appendChild(this.groupList(groups));
	}

	private conflictRow(decision: EditorMigrationDraftDecision, state: EditorMigrationFlowState, readOnly: boolean): HTMLElement {
		const row = element('div', 'hucode-editor-migration-conflict', undefined, { role: 'group' });
		row.setAttribute('aria-label', decision.item);
		row.appendChild(element('span', 'hucode-editor-migration-conflict-name', conflictName(decision)));
		const values = element('span', 'hucode-editor-migration-conflict-values');
		const visibleValues = element('span', 'hucode-editor-migration-conflict-shown', undefined, { 'aria-hidden': 'true' });
		visibleValues.append(
			element('code', 'hucode-editor-migration-value current', displayValue(decision.target)),
			element('span', 'hucode-editor-migration-arrow', '→'),
			element('code', 'hucode-editor-migration-value imported', displayValue(decision.source)),
		);
		values.append(visibleValues, element('span', 'hucode-editor-migration-sr-only', localize('editorMigration.review.conflictValues', "Current value {0}. Imported value {1}.", displayValue(decision.target), displayValue(decision.source))));
		row.appendChild(values);
		if (readOnly) {
			row.appendChild(element('span', 'hucode-editor-migration-conflict-chosen', state.decisions[decision.id] === 'import'
				? localize('editorMigration.review.chosenImported', "Using imported value")
				: localize('editorMigration.review.chosenCurrent', "Keeping current value")));
			return row;
		}
		const choices = element('div', 'hucode-editor-migration-conflict-choices');
		choices.append(
			this.decisionRadio(decision, 'preserveTarget', localize('editorMigration.review.keepCurrent', "Keep"), localize('editorMigration.review.keepCurrentLabel', "Keep current value {0} for {1}", displayValue(decision.target), decision.item), state.decisions[decision.id] === 'preserveTarget'),
			this.decisionRadio(decision, 'import', localize('editorMigration.review.useImported', "Use imported"), localize('editorMigration.review.useImportedLabel', "Use imported value {0} for {1}", displayValue(decision.source), decision.item), state.decisions[decision.id] === 'import'),
		);
		row.appendChild(choices);
		return row;
	}

	private decisionRadio(decision: EditorMigrationDraftDecision, choice: 'import' | 'preserveTarget', visible: string, accessible: string, checked: boolean): HTMLElement {
		const label = element('label', `hucode-editor-migration-choice${checked ? ' chosen' : ''}`);
		const radio = document.createElement('input');
		radio.type = 'radio';
		radio.name = `decision-${decision.id}`;
		radio.checked = checked;
		radio.setAttribute('aria-label', accessible);
		radio.dataset.migrationFocusId = `decision-${decision.id}-${choice}`;
		this.addListener(radio, EventType.CHANGE, () => this.session.chooseDecision(decision.id, choice));
		label.append(radio, element('span', undefined, visible));
		return label;
	}

	// #endregion

	// #region publishers

	private renderPublishers(parent: HTMLElement, state: EditorMigrationFlowState, activeId: string | undefined): HTMLElement {
		if (activeId === PUBLISHERS_SECTION || !state.draft) {
			parent.appendChild(element('h2', undefined, localize('editorMigration.publishers.title', "Confirm Extension Publishers"), { tabIndex: '-1' }));
			parent.appendChild(element('p', 'hucode-editor-migration-lead', localize('editorMigration.publishers.description', "These publishers provide extensions in the reviewed import. This confirmation applies only to this import and does not change Hucode's trusted publisher settings.")));
			const groups = state.publishers.map(publisher => {
				const extensions = state.reviewedPlan?.operations.flatMap(operation => operation.kind === 'installExtension' && operation.source.id.toLowerCase().startsWith(`${publisher.toLowerCase()}.`) ? [operation.source.id] : []) ?? [];
				return {
					id: `publisher:${publisher}`,
					title: localize('editorMigration.publishers.entry', "{0} provides {1} extensions in this import.", publisher, extensions.length),
					count: extensions.length,
					items: extensions,
				};
			});
			parent.appendChild(groups.length
				? this.groupList(groups)
				: element('p', 'hucode-editor-migration-placeholder', localize('editorMigration.publishers.empty', "This import installs no extensions from a publisher.")));
		} else {
			this.renderReviewSection(parent, state, state.draft, activeId, true);
		}
		return this.footer(
			[localize('editorMigration.publishers.footerState', "{0} publishers · confirmation applies to this import only.", state.publishers.length)],
			this.button(localize('editorMigration.back', "Back"), () => this.session.back(), 'publishers-back'),
			this.button(localize('editorMigration.publishers.confirm', "Confirm Publishers and Import"), () => void this.session.confirmPublishers(), 'publishers-confirm', 'primary', state.busy),
		);
	}

	// #endregion

	// #region apply

	private renderApply(parent: HTMLElement, state: EditorMigrationFlowState, activeId: string | undefined): HTMLElement {
		const progress = state.progress;
		const plan = state.reviewedPlan ?? state.operation?.plan;
		const rollback = progress?.stage === 'rollbackPending' ? progress.rollback : undefined;
		if (activeId && activeId !== OVERVIEW_SECTION) {
			this.renderApplyCategory(parent, state, activeId as EditorMigrationCategory);
		} else {
			parent.appendChild(element('h2', undefined, state.canceling ? localize('editorMigration.apply.canceling', "Canceling...") : localize('editorMigration.apply.title', "Importing Setup..."), { tabIndex: '-1' }));
			parent.appendChild(element('div', 'hucode-editor-migration-progress', progress ? progressStatusLabel(progress) : localize('editorMigration.apply.admitting', "Verifying and admitting the reviewed import..."), {
				role: 'progressbar',
				'aria-valuemin': '0',
				'aria-valuemax': String(rollback?.resourceCount ?? progress?.selectedItemCount ?? 1),
				'aria-valuenow': String(rollback?.restoredResourceCount ?? progress?.results.length ?? 0),
			}));
			if (!rollback && plan) {
				const rows = element('div', 'hucode-editor-migration-progress-rows');
				for (const category of ORDERED) {
					if (!plan.choices.selectedCategories.includes(category)) {
						continue;
					}
					rows.appendChild(applyProgressRow(category, progress, plan));
				}
				parent.appendChild(rows);
				const active = activeProgressItem(progress, plan);
				if (active) {
					parent.appendChild(element('p', 'hucode-editor-migration-current-item', localize('editorMigration.apply.currentItem', "Working on {0}.", active)));
				}
			}
			parent.appendChild(element('p', 'hucode-editor-migration-note', localize('editorMigration.apply.recoveryNote', "Recovery copies are saved before any file changes.")));
		}
		return this.footer(
			[progress ? progressStatusLabel(progress) : localize('editorMigration.apply.admitting', "Verifying and admitting the reviewed import...")],
			this.button(state.canceling ? localize('editorMigration.apply.canceling', "Canceling...") : localize('editorMigration.apply.cancel', "Cancel Import"), () => this.session.requestCancellation(), 'apply-cancel', undefined, state.canceling),
		);
	}

	private renderApplyCategory(parent: HTMLElement, state: EditorMigrationFlowState, category: EditorMigrationCategory): void {
		const plan = state.reviewedPlan ?? state.operation?.plan;
		const results = (state.progress?.results ?? []).filter(result => result.category === category);
		const problems = results.filter(result => isEditorMigrationProblemOutcome(result.outcome));
		parent.appendChild(element('h2', undefined, CATEGORY_LABELS[category], { tabIndex: '-1' }));
		parent.appendChild(element('p', 'hucode-editor-migration-lead', applyCategoryStateLabel(category, state.progress, plan)));
		if (problems.length) {
			parent.appendChild(this.problemList(problems, plan, `apply-problems-${category}`));
		}
		const succeeded = results.length - problems.length;
		if (succeeded > 0) {
			parent.appendChild(element('p', 'hucode-editor-migration-note', localize('editorMigration.apply.recorded', "{0} items recorded so far.", succeeded)));
		}
	}

	// #endregion

	// #region results

	private renderResults(parent: HTMLElement, state: EditorMigrationFlowState, activeId: string | undefined): HTMLElement {
		const operation = state.operation;
		if (!operation) {
			parent.appendChild(element('h2', undefined, localize('editorMigration.results.title', "Import Results"), { tabIndex: '-1' }));
			return this.footer([]);
		}
		if (activeId === RESTORE_SECTION) {
			this.renderRestore(parent, state, operation);
		} else if (activeId === NOT_IMPORTED_SECTION) {
			this.renderResultsNotImported(parent, operation);
		} else if (activeId && activeId !== OVERVIEW_SECTION) {
			this.renderResultsCategory(parent, operation, activeId as EditorMigrationCategory);
		} else {
			this.renderResultsOverview(parent, operation);
		}

		const actions: HTMLElement[] = [
			this.button(localize('editorMigration.results.copy', "Copy Report"), () => void this.session.copyReport(), 'results-copy'),
			this.button(localize('editorMigration.results.another', "Import Another Setup"), () => void this.session.startImport(), 'results-another'),
		];
		if (operation.stage !== 'rolledBack' && operation.stage !== 'rollbackPending' && !operation.rollbackIntent?.mutationStarted && operation.results.some(result => ['failed', 'unavailable', 'canceled'].includes(result.outcome))) {
			actions.push(this.button(localize('editorMigration.results.retry', "Retry Failed Items"), () => void this.session.retry(operation.id), 'results-retry'));
		}
		if (operation.stage !== 'settled' && operation.stage !== 'rolledBack') {
			actions.push(this.button(localize('editorMigration.results.resume', "Resume"), () => void this.session.resume(operation.id), 'results-resume'));
		}
		const lines = [operation.aggregateOutcome ? aggregateOutcomeLabel(operation.aggregateOutcome) : stageLabel(operation.stage)];
		if (operation.rollbackIntent?.mutationStarted) {
			lines.push(localize('editorMigration.results.rollbackForwardRetryUnavailable', "Forward import retry is unavailable because file restoration already began."));
		}
		if ((operation.stage === 'settled' || operation.stage === 'rolledBack') && operation.aggregateOutcome) {
			lines.push(localize('editorMigration.results.acknowledge.description', "Removing recovery data deletes the retained snapshots used for file rollback."));
			actions.push(
				this.button(localize('editorMigration.results.done', "Done"), this.onDone, 'results-done', 'primary'),
				this.button(localize('editorMigration.results.acknowledge', "Done and Remove Recovery Data"), () => void this.session.acknowledge(), 'results-acknowledge', 'danger'),
			);
		}
		return this.footer(lines, ...actions);
	}

	private renderResultsOverview(parent: HTMLElement, operation: EditorMigrationOperation): void {
		const problems = operation.results.filter(result => isEditorMigrationProblemOutcome(result.outcome));
		parent.appendChild(element('h2', undefined, localize('editorMigration.results.title', "Import Results"), { tabIndex: '-1' }));
		parent.appendChild(element('p', 'hucode-editor-migration-outcome', operation.aggregateOutcome ? aggregateOutcomeLabel(operation.aggregateOutcome) : stageLabel(operation.stage)));
		parent.appendChild(element('p', 'hucode-editor-migration-lead', problems.length
			? localize('editorMigration.results.leadProblems', "{0} of {1} recorded items need attention. Open the marked sections to act on them.", problems.length, operation.results.length)
			: localize('editorMigration.results.lead', "{0} items were recorded without problems.", operation.results.length)));

		const placements = editorMigrationPlacementGroups(operation);
		if (placements.length) {
			parent.appendChild(element('h3', undefined, localize('editorMigration.results.extensionPlacement', "Extension Placement")));
			parent.appendChild(this.groupList(placements));
		}
		const preserved = operation.plan.choices.decisions.filter(decision => decision.choice === 'preserveTarget');
		if (preserved.length) {
			parent.appendChild(this.disclosure(
				localize('editorMigration.results.preserved', "{0} current values were kept during review", preserved.length),
				preserved.map(decision => preservedDecisionLabel(decision.id)),
			));
		}
		if (operation.rollbackIntent?.mutationStarted) {
			parent.appendChild(element('h3', undefined, localize('editorMigration.results.rollbackOutcome', "File Rollback Outcome")));
			const rows = element('div', 'hucode-editor-migration-progress-rows');
			for (const category of operation.rollbackIntent.categories) {
				const resources = operation.rollbackIntent.resources.filter(resource => resource.category === category);
				const restored = resources.filter(resource => resource.state === 'restored').length;
				rows.appendChild(element('p', 'hucode-editor-migration-progress-row', localize('editorMigration.results.rollbackStatus', "{0}: {1} restored; {2} remaining or refused.", CATEGORY_LABELS[category], restored, resources.length - restored)));
			}
			parent.append(rows, element('p', 'hucode-editor-migration-note', localize('editorMigration.results.rollbackForwardRetryUnavailable', "Forward import retry is unavailable because file restoration already began.")));
		}
	}

	private renderResultsCategory(parent: HTMLElement, operation: EditorMigrationOperation, category: EditorMigrationCategory): void {
		const results = operation.results.filter(result => result.category === category);
		const problems = results.filter(result => isEditorMigrationProblemOutcome(result.outcome));
		parent.appendChild(element('h2', undefined, CATEGORY_LABELS[category], { tabIndex: '-1' }));
		parent.appendChild(element('p', 'hucode-editor-migration-lead', problems.length
			? localize('editorMigration.results.categoryProblems', "{0} succeeded, {1} need attention.", results.length - problems.length, problems.length)
			: localize('editorMigration.results.categoryClean', "{0} items completed without problems.", results.length)));
		if (problems.length) {
			parent.appendChild(element('h3', 'hucode-editor-migration-problem-heading', localize('editorMigration.results.needAttention', "{0} need attention", problems.length)));
			parent.appendChild(this.problemList(problems, operation.plan, `results-problems-${category}`));
		}
		const succeeded = results.filter(result => !isEditorMigrationProblemOutcome(result.outcome));
		if (succeeded.length) {
			parent.appendChild(this.disclosure(
				localize('editorMigration.results.completed', "{0} completed successfully", succeeded.length),
				succeeded.map(result => editorMigrationResultLabel(result, operation.plan)),
				localize('editorMigration.results.completedNote', "Routine successes stay collapsed. Copy the report for the complete record."),
			));
		}
		if (!results.length) {
			parent.appendChild(element('p', 'hucode-editor-migration-placeholder', localize('editorMigration.results.categoryEmpty', "No results were recorded for this category.")));
		}
	}

	private renderResultsNotImported(parent: HTMLElement, operation: EditorMigrationOperation): void {
		const selectedCategories = operation.plan.choices.selectedCategories;
		parent.appendChild(element('h2', undefined, localize('editorMigration.section.notImported', "Not Imported"), { tabIndex: '-1' }));
		parent.appendChild(element('p', 'hucode-editor-migration-lead', localize('editorMigration.results.notImportedLead', "{0} items were held back during review, grouped by reason.", editorMigrationNotImportedCount(operation.plan, selectedCategories))));
		parent.appendChild(this.groupList(editorMigrationNotImportedGroups(operation.plan, selectedCategories)));
	}

	private renderRestore(parent: HTMLElement, state: EditorMigrationFlowState, operation: EditorMigrationOperation): void {
		parent.appendChild(element('h2', undefined, localize('editorMigration.section.restore', "Undo File Changes"), { tabIndex: '-1' }));
		const rollbackCategories = editorMigrationRollbackEligibleCategories(operation);
		if (operation.rollbackIntent?.mutationStarted) {
			parent.appendChild(element('p', 'hucode-editor-migration-lead', localize('editorMigration.rollback.alreadyStarted', "File restoration already began for this import.")));
			return;
		}
		if (operation.stage !== 'settled' || !rollbackCategories.length) {
			parent.appendChild(element('p', 'hucode-editor-migration-placeholder', localize('editorMigration.rollback.unavailable', "No proven file changes from this import can be restored.")));
			return;
		}
		parent.appendChild(element('p', 'hucode-editor-migration-lead', localize('editorMigration.rollback.lead', "Settings, keyboard shortcuts, and snippets can be restored. Extension changes stay installed.")));
		const selection = this.rollbackSelections.get(operation.id) ?? new Set(rollbackCategories);
		this.rollbackSelections.set(operation.id, selection);
		const fieldset = element('fieldset', 'hucode-editor-migration-rollback-selection');
		fieldset.appendChild(element('legend', undefined, localize('editorMigration.results.rollbackCategories', "File categories to restore")));
		for (const category of rollbackCategories) {
			const label = element('label');
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = selection.has(category);
			checkbox.dataset.migrationFocusId = `rollback-category-${category}`;
			this.addListener(checkbox, EventType.CHANGE, () => {
				checkbox.checked ? selection.add(category) : selection.delete(category);
				this.session.clearRollbackInspection();
				this.render(this.session.state);
			});
			label.append(checkbox, element('span', undefined, CATEGORY_LABELS[category]));
			fieldset.appendChild(label);
		}
		parent.appendChild(fieldset);
		parent.appendChild(this.actions(this.button(localize('editorMigration.results.inspectRollback', "Check File Rollback"), () => void this.session.inspectRollback([...selection]), 'results-rollback-inspect', undefined, selection.size === 0)));
		if (!state.rollbackInspection) {
			return;
		}
		const selected = [...selection];
		const rollback = element('section', 'hucode-editor-migration-rollback');
		if (state.rollbackInspection.driftedCategories.length) {
			const changedCategories = state.rollbackInspection.driftedCategories.map(category => CATEGORY_LABELS[category]).join(', ');
			rollback.append(
				element('h3', undefined, localize('editorMigration.rollback.changed', "Files Changed After Import")),
				element('p', undefined, localize('editorMigration.rollback.changed.description', "{0} changed after import. Force rollback will save copies of the current files before restoring those categories. Extension changes stay installed.", changedCategories)),
				this.button(localize('editorMigration.rollback.force', "Force Rollback and Save Current Copies"), () => void this.session.rollback(selected, state.rollbackInspection!.driftedCategories), 'results-rollback-force', 'danger'),
			);
		} else {
			rollback.append(
				element('p', undefined, localize('editorMigration.rollback.ready', "Settings, keyboard shortcuts, and snippets can be restored. Extension changes stay installed.")),
				this.button(localize('editorMigration.rollback.run', "Roll Back File Changes"), () => void this.session.rollback(selected), 'results-rollback', 'danger'),
			);
		}
		parent.appendChild(rollback);
	}

	// #endregion

	// #region shared building blocks

	/** One row per aggregated cause: the cause stated once, its count, and its names on request. */
	private groupList(groups: readonly EditorMigrationAggregateGroup[]): HTMLElement {
		const list = element('div', 'hucode-editor-migration-groups');
		for (const group of groups) {
			const row = element('div', 'hucode-editor-migration-group');
			row.append(
				element('span', 'hucode-editor-migration-group-count', String(group.count), { 'aria-hidden': 'true' }),
				element('span', 'hucode-editor-migration-group-title', group.title),
			);
			if (group.items.length) {
				row.appendChild(this.disclosure(localize('editorMigration.group.show', "Show {0} items", group.items.length), group.items));
			}
			list.appendChild(row);
		}
		return list;
	}

	/** Names stay inside a collapsed disclosure and are truncated instead of nesting a scroll region. */
	private disclosure(summaryText: string, items: readonly string[], note?: string): HTMLElement {
		const details = element('details', 'hucode-editor-migration-disclosure');
		details.appendChild(element('summary', undefined, summaryText));
		const body = element('div', 'hucode-editor-migration-disclosure-body');
		if (note) {
			body.appendChild(element('p', undefined, note));
		}
		const { shown, remaining } = editorMigrationVisibleItems(items);
		if (shown.length) {
			const list = element('ul', 'hucode-editor-migration-item-names');
			shown.forEach(item => list.appendChild(element('li', undefined, item)));
			body.appendChild(list);
		}
		if (remaining) {
			body.appendChild(element('p', undefined, localize('editorMigration.group.more', "and {0} more.", remaining)));
		}
		details.appendChild(body);
		return details;
	}

	private problemList(problems: readonly EditorMigrationItemResult[], plan: EditorMigrationReviewedPlan | undefined, scope: string): HTMLElement {
		const list = element('div', 'hucode-editor-migration-problems');
		const { shown, remaining } = editorMigrationVisibleItems(problems.map(problem => problem.id));
		for (const id of shown) {
			const problem = problems.find(candidate => candidate.id === id)!;
			const row = element('div', `hucode-editor-migration-result-row ${problem.outcome}`);
			row.append(element('span', undefined, editorMigrationResultLabel(problem, plan)));
			if (problem.diagnostic) {
				row.appendChild(element('span', 'hucode-editor-migration-result-detail', resultDiagnosticLabel(problem.diagnostic.code)));
			}
			list.appendChild(row);
		}
		if (remaining) {
			list.appendChild(element('p', 'hucode-editor-migration-note', localize('editorMigration.results.moreProblems', "and {0} more in the copied report.", remaining)));
		}
		list.dataset.migrationProblemScope = scope;
		return list;
	}

	private filter(id: string): string {
		return this.filters.get(id) ?? '';
	}

	private filterInput(id: string, label: string): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'search';
		input.className = 'hucode-editor-migration-filter';
		input.placeholder = label;
		input.setAttribute('aria-label', label);
		input.value = this.filter(id);
		input.dataset.migrationFocusId = `filter-${id}`;
		this.addListener(input, 'compositionstart', () => this.composingFilters.add(id));
		this.addListener(input, 'compositionend', () => {
			this.composingFilters.delete(id);
			this.filters.set(id, input.value);
			this.render(this.session.state);
		});
		this.addListener(input, EventType.INPUT, () => {
			this.filters.set(id, input.value);
			if (!this.composingFilters.has(id)) {
				this.render(this.session.state);
			}
		});
		return input;
	}

	private virtualList<T>(parent: HTMLElement, listId: string, items: readonly T[], rowHeight: number, identity: (item: T) => string, label: (item: T) => string, renderRow: (item: T) => HTMLElement, activate?: (item: T) => void): void {
		const container = element('div', 'hucode-editor-migration-virtual-list');
		container.dataset.migrationListId = listId;
		parent.appendChild(container);
		const delegate: IListVirtualDelegate<T> = {
			getHeight: () => rowHeight,
			getTemplateId: () => 'hucode-editor-migration-row',
		};
		interface TemplateData {
			readonly container: HTMLElement;
			readonly disposables: DisposableStore;
		}
		const renderer: IListRenderer<T, TemplateData> = {
			templateId: 'hucode-editor-migration-row',
			renderTemplate: rowContainer => ({ container: rowContainer, disposables: new DisposableStore() }),
			renderElement: (item, _index, template) => {
				template.disposables.clear();
				clearNode(template.container);
				this.rowDisposables = template.disposables;
				try {
					const row = renderRow(item);
					template.container.appendChild(row);
				} finally {
					this.rowDisposables = undefined;
				}
			},
			disposeElement: (_item, _index, template) => template.disposables.clear(),
			disposeTemplate: template => template.disposables.dispose(),
		};
		const list = new List<T>('HucodeEditorMigration', container, delegate, [renderer], {
			accessibilityProvider: { getAriaLabel: label, getWidgetAriaLabel: () => localize('editorMigration.list', "Editor migration choices") },
			identityProvider: { getId: identity },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: label },
			multipleSelectionSupport: false,
		});
		this.renderDisposables.add(list);
		list.splice(0, 0, items);
		const height = Math.min(480, Math.max(rowHeight, items.length * rowHeight));
		container.style.height = `${height}px`;
		list.layout(height);
		const saved = this.virtualListStates.get(listId);
		if (saved) {
			list.scrollTop = saved.scrollTop;
			const focusedIndex = saved.focusedIdentity ? items.findIndex(item => identity(item) === saved.focusedIdentity) : -1;
			if (focusedIndex >= 0) {
				list.setFocus([focusedIndex]);
			}
		}
		const remember = () => {
			const focusedIndex = list.getFocus()[0];
			this.virtualListStates.set(listId, { scrollTop: list.scrollTop, focusedIdentity: focusedIndex === undefined ? saved?.focusedIdentity : identity(list.element(focusedIndex)) });
		};
		this.renderDisposables.add(list.onDidScroll(remember));
		this.renderDisposables.add(list.onDidChangeFocus(remember));
		this.renderDisposables.add(addDisposableListener(container, EventType.KEY_DOWN, event => {
			const keyCode = new StandardKeyboardEvent(event).keyCode;
			if (!items.length || (keyCode !== KeyCode.Home && keyCode !== KeyCode.End)) {
				return;
			}
			const index = keyCode === KeyCode.Home ? 0 : items.length - 1;
			event.preventDefault();
			event.stopPropagation();
			list.setFocus([index], event);
			list.reveal(index);
		}, true));
		this.renderDisposables.add(list.onDidChangeSelection(event => {
			if (activate && event.elements.length === 1 && isKeyboardEvent(event.browserEvent) && new StandardKeyboardEvent(event.browserEvent).keyCode === KeyCode.Enter) {
				activate(event.elements[0]);
			}
		}));
	}

	private discoveryDetails(diagnostics: readonly EditorMigrationDiagnostic[]): HTMLElement {
		const details = element('details', 'hucode-editor-migration-disclosure');
		details.appendChild(element('summary', undefined, localize('editorMigration.discovery.details', "Discovery Details")));
		const list = element('ul', 'hucode-editor-migration-item-names');
		diagnostics.forEach(diagnostic => list.appendChild(element('li', undefined, diagnosticLabel(diagnostic))));
		details.appendChild(list);
		return details;
	}

	private sourceDetails(source: EditorMigrationSourceDescriptor): HTMLElement {
		const details = element('details', 'hucode-editor-migration-disclosure');
		details.appendChild(element('summary', undefined, localize('editorMigration.profile.details', "Profile Details")));
		const list = element('ul', 'hucode-editor-migration-item-names');
		list.append(
			element('li', undefined, sourceModificationLabel(source.ranking.newestModificationTime)),
			element('li', undefined, localize('editorMigration.profile.userDataPath', "User data path: {0}", source.localPaths.userData)),
			element('li', undefined, localize('editorMigration.profile.extensionsPath', "Extensions path: {0}", source.localPaths.extensions)),
		);
		source.diagnostics.forEach(diagnostic => list.appendChild(element('li', undefined, diagnosticLabel(diagnostic))));
		details.appendChild(list);
		return details;
	}

	private button(label: string, listener: () => void, focusId: string, kind?: 'primary' | 'danger' | string, disabled = false): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `hucode-editor-migration-button${kind ? ` ${kind}` : ''}`;
		button.textContent = label;
		button.disabled = disabled;
		button.dataset.migrationFocusId = focusId;
		this.addListener(button, EventType.CLICK, listener);
		return button;
	}

	private addListener<K extends keyof HTMLElementEventMap>(node: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void): void {
		(this.rowDisposables ?? this.renderDisposables).add(addDisposableListener(node, type, listener));
	}

	private actions(...children: HTMLElement[]): HTMLElement {
		const result = element('div', 'hucode-editor-migration-actions');
		result.append(...children);
		return result;
	}

	private footer(stateLines: readonly string[], ...actions: HTMLElement[]): HTMLElement {
		const footer = element('footer', 'hucode-editor-migration-footer');
		const status = element('div', 'hucode-editor-migration-footer-state');
		stateLines.filter(line => line.length > 0).forEach(line => status.appendChild(element('p', undefined, line)));
		footer.append(status, this.actions(...actions));
		return footer;
	}

	// #endregion
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string, attributes?: Readonly<Record<string, string>>): HTMLElementTagNameMap[K] {
	const result = document.createElement(tag);
	if (className) {
		result.className = className;
	}
	if (text !== undefined) {
		result.textContent = text;
	}
	for (const [name, value] of Object.entries(attributes ?? {})) {
		result.setAttribute(name, value);
	}
	return result;
}

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

function statusMark(status: EditorMigrationSectionStatus): string {
	switch (status) {
		case 'attention': return '!';
		case 'ok': return '✓';
		case 'neutral': return '·';
	}
}

function sectionStatusDescription(section: EditorMigrationSection): string {
	const count = section.count === undefined ? '' : localize('editorMigration.index.count', "{0} items.", section.count);
	switch (section.status) {
		case 'attention': return `${localize('editorMigration.index.attention', "Needs attention.")} ${count}`.trim();
		case 'ok': return `${localize('editorMigration.index.ok', "Ready.")} ${count}`.trim();
		case 'neutral': return count;
	}
}

function targetDisplayName(draft: EditorMigrationPlanDraft): string {
	return draft.target.profile?.name ?? (draft.target.selection.kind === 'proposed' ? draft.target.selection.name : '');
}

function ownershipLabel(draft: EditorMigrationPlanDraft, category: EditorMigrationCategory): string {
	const snapshot = draft.target.categories.find(candidate => candidate.category === category);
	const materializes = draft.prerequisites.some(prerequisite => prerequisite.category === category);
	return snapshot?.ownership === 'default' || materializes
		? localize('editorMigration.review.ownershipDefault', "Currently inherited from Default; Hucode will copy it into {0} before importing.", targetDisplayName(draft))
		: localize('editorMigration.review.ownershipTarget', "Stored directly in {0}.", targetDisplayName(draft));
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

function conflictSearchText(decision: EditorMigrationDraftDecision): string {
	return `${decision.item} ${conflictName(decision)}`;
}

function resourceStateLabel(state: 'present' | 'absent' | 'unreadable', itemCount: number): string {
	switch (state) {
		case 'present': return localize('editorMigration.discovery.present', "{0} items", itemCount);
		case 'absent': return localize('editorMigration.discovery.absent', "not found");
		case 'unreadable': return localize('editorMigration.discovery.unreadable', "could not be read");
	}
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

function applyProgressRow(category: EditorMigrationCategory, progress: EditorMigrationApplyProgress | undefined, plan: EditorMigrationReviewedPlan): HTMLElement {
	const row = element('div', 'hucode-editor-migration-progress-row');
	row.append(
		element('strong', undefined, CATEGORY_LABELS[category]),
		element('span', 'hucode-editor-migration-progress-state', applyCategoryStateLabel(category, progress, plan)),
	);
	return row;
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
	for (const category of ORDERED) {
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

function findElementByFocusId(root: HTMLElement, focusId: string): HTMLElement | undefined {
	const pending = [...root.children];
	while (pending.length) {
		const element = pending.shift();
		if (!isHTMLElement(element)) {
			continue;
		}
		if (element.dataset.migrationFocusId === focusId) {
			return element;
		}
		pending.push(...element.children);
	}
	return undefined;
}
