/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, clearNode, EventType, isHTMLElement } from '../../../base/browser/dom.js';
import { IListRenderer, IListVirtualDelegate } from '../../../base/browser/ui/list/list.js';
import { List } from '../../../base/browser/ui/list/listWidget.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { EditorMigrationItemResult } from '../../common/migration/editorMigrationApply.js';
import { EditorMigrationCategory, EditorMigrationJsonValue } from '../../common/migration/editorMigrationSource.js';
import { EditorMigrationDraftDecision, EditorMigrationDraftExclusion, EditorMigrationExclusionReason, EditorMigrationPlanDraft, EditorMigrationPlanWarning, EditorMigrationReviewedPlan } from '../../common/migration/editorMigrationPlanning.js';
import { EditorMigrationFlowSession, EditorMigrationFlowState } from './editorMigrationFlow.js';

const CATEGORY_LABELS: Readonly<Record<EditorMigrationCategory, string>> = {
	settings: localize('editorMigration.category.settings', "Settings"),
	keybindings: localize('editorMigration.category.keybindings', "Keyboard Shortcuts"),
	snippets: localize('editorMigration.category.snippets', "Snippets"),
	extensions: localize('editorMigration.category.extensions', "Extensions"),
};

type EditorMigrationFilterId = 'applications' | 'profiles' | 'settings' | 'extensions';

/** Shared migration flow view. Hosts supply only framing and completion behavior. */
export class EditorMigrationFlowView extends Disposable {
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly root: HTMLElement;
	private readonly status: HTMLElement;
	private readonly filters: Record<EditorMigrationFilterId, string> = { applications: '', profiles: '', settings: '', extensions: '' };
	private rowDisposables: DisposableStore | undefined;
	private initialFocus: HTMLElement | undefined;

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
		const focusedId = (this.root.ownerDocument.activeElement as HTMLElement | null)?.dataset.migrationFocusId;
		this.renderDisposables.clear();
		clearNode(this.root);
		this.root.appendChild(this.header(state));
		if (state.error) {
			this.root.appendChild(element('div', 'hucode-editor-migration-error', state.error, { role: 'alert' }));
		}
		const content = element('main', 'hucode-editor-migration-content');
		this.root.appendChild(content);
		switch (state.phase) {
			case 'loading': this.renderLoading(content); break;
			case 'recovery': this.renderRecovery(content, state); break;
			case 'application': this.renderApplications(content, state); break;
			case 'profile': this.renderProfiles(content, state); break;
			case 'target': this.renderTargets(content, state); break;
			case 'review': this.renderReview(content, state); break;
			case 'publishers': this.renderPublishers(content, state); break;
			case 'apply': this.renderApply(content, state); break;
			case 'results': this.renderResults(content, state); break;
		}
		this.status.textContent = state.announcement ?? '';
		if (focusedId) {
			findElementByFocusId(this.root, focusedId)?.focus();
		} else {
			this.initialFocus?.focus();
		}
	}

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

	private renderLoading(parent: HTMLElement): void {
		parent.appendChild(element('h2', undefined, localize('editorMigration.loading', "Looking for editor profiles..."), { tabIndex: '-1' }));
		parent.appendChild(element('div', 'hucode-editor-migration-progress', localize('editorMigration.loading.detail', "Reading supported local editor installations."), { role: 'progressbar' }));
	}

	private renderRecovery(parent: HTMLElement, state: EditorMigrationFlowState): void {
		parent.appendChild(element('h2', undefined, localize('editorMigration.recovery.title', "Continue an Earlier Import"), { tabIndex: '-1' }));
		parent.appendChild(element('p', undefined, localize('editorMigration.recovery.description', "Hucode found import data that still has results or recovery actions available.")));
		const list = element('div', 'hucode-editor-migration-card-list');
		for (const recovery of state.recoveries) {
			const card = element('article', 'hucode-editor-migration-card');
			card.append(
				element('h3', undefined, recovery.targetName ?? localize('editorMigration.recovery.unknownTarget', "Unknown Target")),
				element('p', undefined, recovery.unsupportedSchemaVersion === undefined ? `${recovery.stage} · ${new Date(recovery.updatedAt).toLocaleString()}` : localize('editorMigration.recovery.unsupported', "This record was created by another Hucode version and will be kept untouched.")),
			);
			if (recovery.unsupportedSchemaVersion === undefined) {
				card.appendChild(this.button(localize('editorMigration.recovery.open', "View or Continue"), () => void this.session.showRecovery(recovery.id), `recovery-${recovery.id}`));
			}
			list.appendChild(card);
		}
		parent.append(list, this.button(localize('editorMigration.recovery.new', "Start Another Import"), () => void this.session.startImport(), 'start-import'));
	}

	private renderApplications(parent: HTMLElement, state: EditorMigrationFlowState): void {
		parent.appendChild(element('h2', undefined, localize('editorMigration.application.title', "Which Application Should Hucode Import From?"), { tabIndex: '-1' }));
		parent.appendChild(element('p', undefined, localize('editorMigration.application.description', "Choose an editor first. You will choose one of its profiles next.")));
		const filter = this.filterInput('applications', localize('editorMigration.application.filter', "Filter applications"));
		parent.appendChild(filter);
		const applications = state.applications.filter(application => application.productName.toLowerCase().includes(this.filters.applications.toLowerCase()));
		if (applications.length) {
			this.virtualList(parent, applications, 76, application => application.id, application => application.productName, application => {
				const button = this.button('', () => this.session.selectApplication(application.id), `application-${application.id}`, 'hucode-editor-migration-choice-card');
				button.append(
					element('strong', undefined, application.productName),
					element('span', undefined, localize('editorMigration.application.profiles', "{0} profiles", application.profiles.length)),
				);
				return button;
			});
		} else {
			parent.appendChild(element('p', undefined, localize('editorMigration.application.empty', "No supported editor profiles were found.")));
		}
		parent.appendChild(this.button(localize('editorMigration.refresh', "Refresh"), () => void this.session.refreshDiscovery(), 'refresh'));
	}

	private renderProfiles(parent: HTMLElement, state: EditorMigrationFlowState): void {
		const application = state.applications.find(candidate => candidate.id === state.selectedApplicationId);
		parent.appendChild(element('h2', undefined, localize('editorMigration.profile.title', "Choose a {0} Profile", application?.productName ?? ''), { tabIndex: '-1' }));
		if (!application) {
			return;
		}
		const filter = this.filterInput('profiles', localize('editorMigration.profile.filter', "Filter profiles"));
		parent.appendChild(filter);
		const profiles = application.profiles.filter(profile => profile.profile.name.toLowerCase().includes(this.filters.profiles.toLowerCase()));
		this.virtualList(parent, profiles, 68, source => source.ref.value, source => source.profile.name, source => {
			const row = element('label', 'hucode-editor-migration-radio-row');
			const radio = document.createElement('input');
			radio.type = 'radio';
			radio.name = 'migration-source-profile';
			radio.checked = state.selectedSourceRef?.value === source.ref.value;
			radio.dataset.migrationFocusId = `profile-${source.ref.value}`;
			this.addListener(radio, EventType.CHANGE, () => this.session.selectSourceProfile(source.ref));
			const available = source.categories.filter(category => category.state === 'present');
			row.append(radio, element('span', undefined, `${source.profile.name} · ${available.map(category => `${CATEGORY_LABELS[category.category]} ${category.itemCount}`).join(', ')}`));
			return row;
		});
		parent.appendChild(this.actions(
			this.button(localize('editorMigration.back', "Back"), () => this.session.back(), 'profile-back'),
			this.button(localize('editorMigration.continue', "Continue"), () => void this.session.continueFromProfile(), 'profile-continue', 'primary', !state.selectedSourceRef || state.busy),
		));
	}

	private renderTargets(parent: HTMLElement, state: EditorMigrationFlowState): void {
		parent.appendChild(element('h2', undefined, localize('editorMigration.target.title', "Where Should Hucode Import This Setup?"), { tabIndex: '-1' }));
		parent.appendChild(element('p', undefined, localize('editorMigration.target.description', "Default is selected. You can choose another existing profile or name a new one.")));
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
		parent.append(list, newRow, this.actions(
			this.button(localize('editorMigration.back', "Back"), () => this.session.back(), 'target-back'),
			this.button(localize('editorMigration.review', "Review Import"), () => void this.session.continueFromTarget(), 'target-continue', 'primary', !state.selectedTarget || state.busy),
		));
	}

	private renderReview(parent: HTMLElement, state: EditorMigrationFlowState): void {
		const draft = state.draft;
		parent.appendChild(element('h2', undefined, localize('editorMigration.review.title', "Review What Will Change"), { tabIndex: '-1' }));
		if (!draft) {
			return;
		}
		const targetName = draft.target.profile?.name ?? (draft.target.selection.kind === 'proposed' ? draft.target.selection.name : '');
		parent.appendChild(element('p', undefined, localize('editorMigration.review.target', "Importing {0} into Hucode profile {1}.", draft.source.profile.name, targetName)));
		const categories = element('fieldset', 'hucode-editor-migration-categories');
		categories.appendChild(element('legend', undefined, localize('editorMigration.review.categories', "Categories")));
		for (const category of draft.target.requestedCategories) {
			const label = element('label', 'hucode-editor-migration-category');
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = state.selectedCategories.includes(category);
			checkbox.dataset.migrationFocusId = `category-${category}`;
			this.addListener(checkbox, EventType.CHANGE, () => this.session.toggleCategory(category, checkbox.checked));
			const decisionCount = draft.decisions.filter(decision => decision.category === category).length;
			const conflictCount = draft.decisions.filter(decision => decision.category === category && decision.kind === 'conflict').length;
			const exclusionCount = draft.exclusions.filter(exclusion => exclusion.category === category).length;
			const availableCount = sourceCategoryItemCount(draft, category);
			label.append(checkbox, element('span', undefined, localize('editorMigration.review.categorySummary', "{0} · {1} available · {2} planned · {3} different · {4} excluded", CATEGORY_LABELS[category], availableCount, decisionCount, conflictCount, exclusionCount)));
			categories.appendChild(label);
		}
		parent.appendChild(categories);
		this.renderOwnership(parent, draft, state);

		const settingAdditions = draft.decisions.filter(decision => decision.category === 'settings' && decision.kind === 'add');
		const settingExclusions = draft.exclusions.filter(exclusion => exclusion.category === 'settings');
		const settingsDifferences = draft.decisions.filter(decision => decision.category === 'settings' && decision.kind === 'conflict');
		if (state.selectedCategories.includes('settings')) {
			if (settingAdditions.length) {
				parent.appendChild(element('h3', undefined, localize('editorMigration.review.settingsAdditions', "New Settings")));
				const additions = element('ul', 'hucode-editor-migration-review-list');
				settingAdditions.forEach(decision => additions.appendChild(element('li', undefined, localize('editorMigration.review.settingAddition', "Add {0} with imported value {1}", decision.item, displayValue(decision.source)))));
				parent.appendChild(additions);
			}
			if (settingExclusions.length) {
				parent.appendChild(element('h3', undefined, localize('editorMigration.review.settingsExcluded', "Settings Not Imported")));
				parent.appendChild(this.exclusionList(settingExclusions));
			}
			if (settingsDifferences.length) {
				parent.appendChild(element('h3', undefined, localize('editorMigration.review.settingsDifferences', "Different Settings")));
				parent.appendChild(element('p', undefined, localize('editorMigration.review.settingsDifferences.description', "Choose which value Hucode should keep for each of the {0} different settings.", settingsDifferences.length)));
				parent.appendChild(this.actions(
					this.button(localize('editorMigration.review.keepAll', "Keep All Current Values"), () => this.session.chooseAllSettingDifferences('preserveTarget'), 'keep-all-settings'),
					this.button(localize('editorMigration.review.useAll', "Use Imported Values for All"), () => this.session.chooseAllSettingDifferences('import'), 'import-all-settings'),
				));
				parent.appendChild(this.filterInput('settings', localize('editorMigration.review.filterSettings', "Filter different settings")));
				this.renderDecisions(parent, settingsDifferences.filter(decision => decision.item.toLowerCase().includes(this.filters.settings.toLowerCase())), state);
			}
		}

		if (state.selectedCategories.includes('keybindings')) {
			this.renderResourceDecisions(parent, 'keybindings', draft.decisions.filter(decision => decision.category === 'keybindings'), state);
		}
		if (state.selectedCategories.includes('snippets')) {
			this.renderResourceDecisions(parent, 'snippets', draft.decisions.filter(decision => decision.category === 'snippets'), state);
		}
		if (state.selectedCategories.includes('extensions')) {
			this.renderExtensionReview(parent, draft);
		}
		const warnings = draft.warnings.filter(warning => warning.code !== 'defaultProfileBacksOmni');
		if (warnings.length) {
			const warningList = element('ul', 'hucode-editor-migration-warnings');
			warnings.forEach(warning => warningList.appendChild(element('li', undefined, warningLabel(warning))));
			parent.append(element('h3', undefined, localize('editorMigration.review.warnings', "Review Notes")), warningList);
		}
		parent.appendChild(this.actions(
			this.button(localize('editorMigration.back', "Back"), () => this.session.back(), 'review-back'),
			state.reviewNeedsRebuild
				? this.button(localize('editorMigration.review.rebuild', "Rebuild Review"), () => void this.session.rebuildReview(), 'review-rebuild', 'primary', state.busy)
				: this.button(localize('editorMigration.review.continue', "Continue"), () => void this.session.acceptReview(), 'review-continue', 'primary', state.busy || !state.selectedCategories.length),
		));
	}

	private renderDecisions(parent: HTMLElement, decisions: readonly EditorMigrationDraftDecision[], state: EditorMigrationFlowState): void {
		this.virtualList(parent, decisions, 132, decision => decision.id, decision => decision.item, decision => {
			const row = element('fieldset', 'hucode-editor-migration-decision');
			row.appendChild(element('legend', undefined, decision.item));
			row.appendChild(element('div', 'hucode-editor-migration-values', localize('editorMigration.review.settingValues', "Current: {0} · Imported: {1}", displayValue(decision.target), displayValue(decision.source))));
			row.append(
				this.decisionRadio(decision.id, 'preserveTarget', localize('editorMigration.review.keepCurrent', "Keep Current Value"), state.decisions[decision.id] === 'preserveTarget'),
				this.decisionRadio(decision.id, 'import', localize('editorMigration.review.useImported', "Use Imported Value"), state.decisions[decision.id] === 'import'),
			);
			return row;
		});
	}

	private renderOwnership(parent: HTMLElement, draft: EditorMigrationPlanDraft, state: EditorMigrationFlowState): void {
		const list = element('ul', 'hucode-editor-migration-ownership');
		for (const category of state.selectedCategories) {
			const snapshot = draft.target.categories.find(candidate => candidate.category === category);
			const materializes = draft.prerequisites.some(prerequisite => prerequisite.category === category);
			const description = snapshot?.ownership === 'default' || materializes
				? localize('editorMigration.review.ownershipDefault', "{0}: currently inherited from Default; Hucode will copy it into this profile before importing.", CATEGORY_LABELS[category])
				: localize('editorMigration.review.ownershipTarget', "{0}: stored directly in this target profile.", CATEGORY_LABELS[category]);
			list.appendChild(element('li', undefined, description));
		}
		parent.append(element('h3', undefined, localize('editorMigration.review.ownership', "Target Storage")), list);
	}

	private exclusionList(exclusions: readonly EditorMigrationDraftExclusion[]): HTMLElement {
		const list = element('ul', 'hucode-editor-migration-review-list');
		exclusions.forEach(exclusion => list.appendChild(element('li', undefined, `${exclusion.item} · ${exclusionReasonLabel(exclusion.reason)}`)));
		return list;
	}

	private renderResourceDecisions(parent: HTMLElement, category: 'keybindings' | 'snippets', decisions: readonly EditorMigrationDraftDecision[], state: EditorMigrationFlowState): void {
		if (!decisions.length) {
			return;
		}
		parent.appendChild(element('h3', undefined, category === 'keybindings'
			? localize('editorMigration.review.keybindings', "Keyboard Shortcut Changes")
			: localize('editorMigration.review.snippets', "Snippet File Changes")));
		this.virtualList(parent, decisions, 112, decision => decision.id, decision => decision.item, decision => {
			const row = element('div', 'hucode-editor-migration-resource-decision');
			row.appendChild(element('strong', undefined, resourceDecisionLabel(decision)));
			if (decision.kind === 'conflict') {
				row.append(
					this.decisionRadio(decision.id, 'preserveTarget', localize('editorMigration.review.keepCurrent', "Keep Current Value"), state.decisions[decision.id] === 'preserveTarget'),
					this.decisionRadio(decision.id, 'import', localize('editorMigration.review.useImported', "Use Imported Value"), state.decisions[decision.id] === 'import'),
				);
			}
			return row;
		});
	}

	private renderExtensionReview(parent: HTMLElement, draft: EditorMigrationPlanDraft): void {
		const items = extensionReviewItems(draft);
		parent.appendChild(element('h3', undefined, localize('editorMigration.review.extensions', "Extension Review")));
		parent.appendChild(this.filterInput('extensions', localize('editorMigration.review.filterExtensions', "Filter extensions")));
		const filter = this.filters.extensions.toLowerCase();
		const filtered = items.filter(item => `${item.id} ${item.detail}`.toLowerCase().includes(filter));
		this.virtualList(parent, filtered, 72, item => item.identity, item => item.id, item => {
			const row = element('div', 'hucode-editor-migration-extension-row');
			row.append(element('strong', undefined, item.id), element('span', undefined, item.detail));
			return row;
		});
	}

	private renderPublishers(parent: HTMLElement, state: EditorMigrationFlowState): void {
		parent.appendChild(element('h2', undefined, localize('editorMigration.publishers.title', "Confirm Extension Publishers"), { tabIndex: '-1' }));
		parent.appendChild(element('p', undefined, localize('editorMigration.publishers.description', "These publishers provide extensions in the reviewed import. This confirmation applies only to this import and does not change Hucode's trusted publisher settings.")));
		const list = element('ul', 'hucode-editor-migration-publishers');
		for (const publisher of state.publishers) {
			const extensions = state.reviewedPlan?.operations.flatMap(operation => operation.kind === 'installExtension' && operation.source.id.toLowerCase().startsWith(`${publisher}.`) ? [operation.source.id] : []) ?? [];
			list.appendChild(element('li', undefined, `${publisher}: ${extensions.join(', ')}`));
		}
		parent.append(list, this.actions(
			this.button(localize('editorMigration.back', "Back"), () => this.session.back(), 'publishers-back'),
			this.button(localize('editorMigration.publishers.confirm', "Confirm Publishers and Import"), () => void this.session.confirmPublishers(), 'publishers-confirm', 'primary'),
		));
	}

	private renderApply(parent: HTMLElement, state: EditorMigrationFlowState): void {
		parent.appendChild(element('h2', undefined, state.canceling ? localize('editorMigration.apply.canceling', "Canceling...") : localize('editorMigration.apply.title', "Importing Setup..."), { tabIndex: '-1' }));
		const progress = state.progress;
		parent.appendChild(element('div', 'hucode-editor-migration-progress', progress ? `${progress.stage} · ${progress.results.length} of ${progress.selectedItemCount} items recorded` : localize('editorMigration.apply.admitting', "Verifying and admitting the reviewed import..."), {
			role: 'progressbar',
			ariaValueMin: '0',
			ariaValueMax: String(progress?.selectedItemCount ?? 1),
			ariaValueNow: String(progress?.results.length ?? 0),
		}));
		if (progress?.results.length) {
			const list = element('ul', 'hucode-editor-migration-results');
			const plan = state.reviewedPlan ?? state.operation?.plan;
			progress.results.forEach(result => list.appendChild(element('li', undefined, editorMigrationResultLabel(result, plan))));
			parent.appendChild(list);
		}
		parent.appendChild(this.button(state.canceling ? localize('editorMigration.apply.canceling', "Canceling...") : localize('editorMigration.apply.cancel', "Cancel Import"), () => this.session.requestCancellation(), 'apply-cancel', undefined, state.canceling));
	}

	private renderResults(parent: HTMLElement, state: EditorMigrationFlowState): void {
		const operation = state.operation;
		parent.appendChild(element('h2', undefined, localize('editorMigration.results.title', "Import Results"), { tabIndex: '-1' }));
		if (!operation) {
			return;
		}
		parent.appendChild(element('p', 'hucode-editor-migration-outcome', operation.aggregateOutcome ?? operation.stage));
		const list = element('ul', 'hucode-editor-migration-results');
		for (const result of operation.results) {
			const label = editorMigrationResultLabel(result, operation.plan);
			list.appendChild(element('li', result.outcome, `${label}${result.diagnostic ? ` · ${result.diagnostic.code}` : ''}`));
		}
		parent.appendChild(list);
		const preserved = operation.plan.choices.decisions.filter(decision => decision.choice === 'preserveTarget');
		if (preserved.length) {
			const preservedList = element('ul', 'hucode-editor-migration-results');
			preserved.forEach(decision => preservedList.appendChild(element('li', undefined, preservedDecisionLabel(decision.id))));
			parent.append(element('h3', undefined, localize('editorMigration.results.preserved', "Kept Current During Review")), preservedList);
		}
		if (operation.plan.exclusions.length) {
			const exclusionList = element('ul', 'hucode-editor-migration-results');
			operation.plan.exclusions.forEach(exclusion => exclusionList.appendChild(element('li', undefined, `${CATEGORY_LABELS[exclusion.category]} · ${exclusion.item} · ${exclusion.reason}`)));
			parent.append(element('h3', undefined, localize('editorMigration.results.excluded', "Excluded During Review")), exclusionList);
		}
		const actions = this.actions(
			this.button(localize('editorMigration.results.copy', "Copy Report"), () => void this.session.copyReport(), 'results-copy'),
			this.button(localize('editorMigration.results.another', "Import Another Setup"), () => void this.session.startImport(), 'results-another'),
		);
		if (operation.stage !== 'rolledBack' && operation.results.some(result => ['failed', 'unavailable', 'canceled'].includes(result.outcome))) {
			actions.appendChild(this.button(localize('editorMigration.results.retry', "Retry Failed Items"), () => void this.session.retry(operation.id), 'results-retry'));
		}
		if (operation.stage !== 'settled' && operation.stage !== 'rolledBack') {
			actions.appendChild(this.button(localize('editorMigration.results.resume', "Resume"), () => void this.session.resume(operation.id), 'results-resume'));
		}
		const rollbackCategories = rollbackEligibleCategories(operation.plan.choices.selectedCategories);
		if (operation.stage === 'settled' && rollbackCategories.length) {
			actions.appendChild(this.button(localize('editorMigration.results.inspectRollback', "Check File Rollback"), () => void this.session.inspectRollback(rollbackCategories), 'results-rollback-inspect'));
		}
		parent.appendChild(actions);
		if (state.rollbackInspection) {
			const rollback = element('section', 'hucode-editor-migration-rollback');
			if (state.rollbackInspection.driftedCategories.length) {
				const changedCategories = state.rollbackInspection.driftedCategories.map(category => CATEGORY_LABELS[category]).join(', ');
				rollback.append(
					element('h3', undefined, localize('editorMigration.rollback.changed', "Files Changed After Import")),
					element('p', undefined, localize('editorMigration.rollback.changed.description', "{0} changed after import. Force rollback will save copies of the current files before restoring those categories. Extension changes stay installed.", changedCategories)),
					this.button(localize('editorMigration.rollback.force', "Force Rollback and Save Current Copies"), () => void this.session.rollback(rollbackCategories, state.rollbackInspection!.driftedCategories), 'results-rollback-force', 'danger'),
				);
			} else {
				rollback.append(
					element('p', undefined, localize('editorMigration.rollback.ready', "Settings, keyboard shortcuts, and snippets can be restored. Extension changes stay installed.")),
					this.button(localize('editorMigration.rollback.run', "Roll Back File Changes"), () => void this.session.rollback(rollbackCategories), 'results-rollback', 'danger'),
				);
			}
			parent.appendChild(rollback);
		}
		if ((operation.stage === 'settled' || operation.stage === 'rolledBack') && operation.aggregateOutcome) {
			parent.appendChild(element('p', 'hucode-editor-migration-acknowledgement-note', localize('editorMigration.results.acknowledge.description', "Removing recovery data deletes the retained snapshots used for file rollback.")));
			parent.appendChild(this.actions(
				this.button(localize('editorMigration.results.done', "Done"), this.onDone, 'results-done', 'primary'),
				this.button(localize('editorMigration.results.acknowledge', "Done and Remove Recovery Data"), () => void this.session.acknowledge(), 'results-acknowledge', 'danger'),
			));
		}
	}

	private decisionRadio(id: string, choice: 'import' | 'preserveTarget', labelText: string, checked: boolean): HTMLElement {
		const label = element('label', 'hucode-editor-migration-decision-choice');
		const radio = document.createElement('input');
		radio.type = 'radio';
		radio.name = `decision-${id}`;
		radio.checked = checked;
		radio.dataset.migrationFocusId = `decision-${id}-${choice}`;
		this.addListener(radio, EventType.CHANGE, () => this.session.chooseDecision(id, choice));
		label.append(radio, element('span', undefined, labelText));
		return label;
	}

	private filterInput(id: EditorMigrationFilterId, label: string): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'search';
		input.className = 'hucode-editor-migration-filter';
		input.placeholder = label;
		input.setAttribute('aria-label', label);
		input.value = this.filters[id];
		input.dataset.migrationFocusId = `filter-${id}`;
		this.addListener(input, EventType.INPUT, () => {
			this.filters[id] = input.value;
			this.render(this.session.state);
		});
		return input;
	}

	private virtualList<T>(parent: HTMLElement, items: readonly T[], rowHeight: number, identity: (item: T) => string, label: (item: T) => string, renderRow: (item: T) => HTMLElement): void {
		const container = element('div', 'hucode-editor-migration-virtual-list');
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
		list.layout(Math.min(480, Math.max(rowHeight, items.length * rowHeight)));
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

function rollbackEligibleCategories(categories: readonly EditorMigrationCategory[]): Exclude<EditorMigrationCategory, 'extensions'>[] {
	return categories.filter((category): category is Exclude<EditorMigrationCategory, 'extensions'> => category !== 'extensions');
}

function sourceCategoryItemCount(draft: EditorMigrationPlanDraft, category: EditorMigrationCategory): number {
	const source = draft.source.categories.find(candidate => candidate.category === category);
	if (source?.state !== 'present' || !source.value) {
		return 0;
	}
	return Array.isArray(source.value) ? source.value.length : Object.keys(source.value as Readonly<Record<string, EditorMigrationJsonValue>>).length;
}

function editorMigrationResultLabel(result: EditorMigrationItemResult, plan: EditorMigrationReviewedPlan | undefined): string {
	const operation = plan?.operations.find(candidate => candidate.id === result.id);
	return operation
		? `${CATEGORY_LABELS[result.category]} · ${operation.item} · ${result.outcome}`
		: `${CATEGORY_LABELS[result.category]} · ${result.outcome}`;
}

interface EditorMigrationExtensionReviewItem {
	readonly identity: string;
	readonly id: string;
	readonly detail: string;
}

function extensionReviewItems(draft: EditorMigrationPlanDraft): readonly EditorMigrationExtensionReviewItem[] {
	const installable = draft.decisions.filter(decision => decision.category === 'extensions').map(decision => {
		const source = isJsonObject(decision.source) ? decision.source : {};
		const version = typeof source.version === 'string' ? source.version : localize('editorMigration.review.extensionUnknownVersion', "unknown version");
		const platform = typeof source.targetPlatform === 'string' ? source.targetPlatform : localize('editorMigration.review.extensionUnknownPlatform', "current platform");
		const channel = source.selectedChannel === 'preRelease' ? localize('editorMigration.review.extensionPreRelease', "pre-release") : localize('editorMigration.review.extensionStable', "stable");
		return {
			identity: decision.id,
			id: decision.item,
			detail: localize('editorMigration.review.extensionInstall', "Install exact {0} ({1}, {2}).", version, platform, channel),
		};
	});
	const excluded = draft.exclusions.filter(exclusion => exclusion.category === 'extensions').map(exclusion => ({
		identity: `excluded:${exclusion.item}:${exclusion.reason}`,
		id: exclusion.item,
		detail: exclusionReasonLabel(exclusion.reason),
	}));
	return [...installable, ...excluded].sort((left, right) => left.id.localeCompare(right.id) || left.identity.localeCompare(right.identity));
}

function exclusionReasonLabel(reason: EditorMigrationExclusionReason): string {
	switch (reason) {
		case 'machineSpecific': return localize('editorMigration.exclusion.machineSpecific', "Kept out because this setting is specific to the source machine.");
		case 'accountOrAuthentication': return localize('editorMigration.exclusion.accountOrAuthentication', "Kept out because account and sign-in data must not be imported.");
		case 'telemetryIdentity': return localize('editorMigration.exclusion.telemetryIdentity', "Kept out because telemetry identity data must not be imported.");
		case 'updateChannel': return localize('editorMigration.exclusion.updateChannel', "Kept out because update-channel settings belong to the source application.");
		case 'remoteAuthority': return localize('editorMigration.exclusion.remoteAuthority', "Kept out because remote connection settings are machine-specific.");
		case 'applicationPath': return localize('editorMigration.exclusion.applicationPath', "Kept out because the value contains a source-application path.");
		case 'sourceProductIntegration': return localize('editorMigration.exclusion.sourceProductIntegration', "Not imported because it integrates with the source application.");
		case 'registryIgnored': return localize('editorMigration.exclusion.registryIgnored', "Not imported because Hucode's settings registry excludes it.");
		case 'builtIn': return localize('editorMigration.exclusion.builtIn', "Already provided by Hucode as a built-in extension.");
		case 'alreadyInstalled': return localize('editorMigration.exclusion.alreadyInstalled', "Already installed in the target profile.");
		case 'galleryUnavailable': return localize('editorMigration.exclusion.galleryUnavailable', "Unavailable from Hucode's extension gallery.");
		case 'galleryIncompatible': return localize('editorMigration.exclusion.galleryIncompatible', "Available extension is incompatible with this Hucode version or platform.");
	}
}

function warningLabel(warning: EditorMigrationPlanWarning): string {
	switch (warning.code) {
		case 'preReleaseFellBackToStable': return localize('editorMigration.warning.preReleaseFallback', "{0} requested a pre-release version; the gallery will install the compatible stable version.", warning.item ?? localize('editorMigration.warning.extension', "An extension"));
		case 'unknownSettingSchema': return localize('editorMigration.warning.unknownSettingSchema', "Review {0}: Hucode could not find a registered setting schema for it.", warning.item ?? localize('editorMigration.warning.setting', "this setting"));
		case 'unavailableThemeExtension': return localize('editorMigration.warning.unavailableThemeExtension', "The theme extension {0} is unavailable; choose another theme after import if needed.", warning.item ?? localize('editorMigration.warning.theme', "from the source editor"));
		case 'defaultProfileBacksOmni': return '';
	}
}

function resourceDecisionLabel(decision: EditorMigrationDraftDecision): string {
	if (decision.category === 'snippets') {
		return decision.kind === 'add'
			? localize('editorMigration.review.snippetAdd', "Add snippet file {0}", decision.item)
			: localize('editorMigration.review.snippetConflict', "Different snippet file {0}", decision.item);
	}
	const source = isJsonObject(decision.source) ? decision.source : {};
	const key = typeof source.key === 'string' ? source.key : localize('editorMigration.review.keybindingUnknownKey', "an unassigned key");
	const command = typeof source.command === 'string' ? source.command : localize('editorMigration.review.keybindingUnknownCommand', "an unknown command");
	return decision.kind === 'add'
		? localize('editorMigration.review.keybindingAdd', "Add {0} for {1}", key, command)
		: localize('editorMigration.review.keybindingConflict', "Different shortcut {0} for {1}", key, command);
}

function displayValue(value: EditorMigrationJsonValue | undefined): string {
	if (value === undefined) {
		return localize('editorMigration.review.valueMissing', "not set");
	}
	const serialized = JSON.stringify(value);
	return serialized.length > 160 ? `${serialized.slice(0, 157)}...` : serialized;
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
