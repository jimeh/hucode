/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IUserDataProfilesService } from '../../../platform/userDataProfile/common/userDataProfile.js';
import {
	EditorMigrationApplyError,
	EditorMigrationApplyProgress,
	EditorMigrationOperation,
	EditorMigrationOperationSummary,
	EditorMigrationRollbackInspection,
	IEditorMigrationApplyService,
	editorMigrationPublishers,
} from '../../common/migration/editorMigrationApply.js';
import { formatEditorMigrationReport } from '../../common/migration/editorMigrationReport.js';
import {
	EditorMigrationCategory,
	EditorMigrationDiagnostic,
	EditorMigrationSourceDescriptor,
	EditorMigrationSourceProfileRef,
	EditorMigrationSourceSnapshot,
	IEditorMigrationSourceService,
} from '../../common/migration/editorMigrationSource.js';
import {
	EditorMigrationPlanDraft,
	EditorMigrationReviewedPlan,
	EditorMigrationTargetSelection,
	IEditorMigrationPlanningService,
} from '../../common/migration/editorMigrationPlanning.js';

const ALL_CATEGORIES: readonly EditorMigrationCategory[] = ['settings', 'keybindings', 'snippets', 'extensions'];

/** One source application and its currently discovered profiles. */
export interface EditorMigrationSourceApplication {
	readonly id: string;
	readonly productName: string;
	readonly channel: 'stable' | 'insiders';
	readonly profiles: readonly EditorMigrationSourceDescriptor[];
}

/** One eligible Hucode target exposed to the target picker. */
export interface EditorMigrationTargetOption {
	readonly selection: Extract<EditorMigrationTargetSelection, { readonly kind: 'existing' }>;
	readonly name: string;
	readonly kind: 'default' | 'named';
}

export type EditorMigrationFlowPhase = 'loading' | 'recovery' | 'application' | 'profile' | 'target' | 'review' | 'publishers' | 'apply' | 'results';

/** Immutable presentation state shared by standalone and onboarding hosts. */
export interface EditorMigrationFlowState {
	readonly phase: EditorMigrationFlowPhase;
	readonly busy: boolean;
	readonly canceling: boolean;
	readonly error?: string;
	readonly announcement?: string;
	readonly recoveries: readonly EditorMigrationOperationSummary[];
	readonly applications: readonly EditorMigrationSourceApplication[];
	readonly discoveryDiagnostics: readonly EditorMigrationDiagnostic[];
	readonly selectedApplicationId?: string;
	readonly selectedSourceRef?: EditorMigrationSourceProfileRef;
	readonly source?: EditorMigrationSourceSnapshot;
	readonly targets: readonly EditorMigrationTargetOption[];
	readonly selectedTarget?: EditorMigrationTargetSelection;
	readonly draft?: EditorMigrationPlanDraft;
	readonly selectedCategories: readonly EditorMigrationCategory[];
	readonly decisions: Readonly<Record<string, 'import' | 'preserveTarget' | undefined>>;
	readonly reviewedPlan?: EditorMigrationReviewedPlan;
	readonly publishers: readonly string[];
	readonly progress?: EditorMigrationApplyProgress;
	readonly operation?: EditorMigrationOperation;
	readonly rollbackInspection?: EditorMigrationRollbackInspection;
	readonly reviewNeedsRebuild: boolean;
}

/** Groups deterministic discovery results for application-first navigation. */
export function groupEditorMigrationSources(sources: readonly EditorMigrationSourceDescriptor[]): readonly EditorMigrationSourceApplication[] {
	const groups = new Map<string, EditorMigrationSourceApplication>();
	for (const source of sources) {
		const id = source.adapter.id;
		const existing = groups.get(id);
		groups.set(id, existing
			? { ...existing, profiles: [...existing.profiles, source] }
			: { id, productName: source.adapter.productName, channel: source.adapter.channel, profiles: [source] });
	}
	return Object.freeze([...groups.values()].map(group => Object.freeze({ ...group, profiles: Object.freeze([...group.profiles]) })));
}

/** Returns the Default source profile when one exists for an application. */
export function defaultEditorMigrationSourceProfile(application: EditorMigrationSourceApplication): EditorMigrationSourceDescriptor | undefined {
	return application.profiles.find(source => source.profile.kind === 'default');
}

/** Applies one bulk choice to every setting difference, independent of filtering. */
export function chooseAllEditorMigrationSettingDifferences(
	draft: EditorMigrationPlanDraft,
	decisions: Readonly<Record<string, 'import' | 'preserveTarget' | undefined>>,
	choice: 'import' | 'preserveTarget',
): Readonly<Record<string, 'import' | 'preserveTarget' | undefined>> {
	const next = { ...decisions };
	for (const decision of draft.decisions) {
		if (decision.category === 'settings' && decision.kind === 'conflict') {
			next[decision.id] = choice;
		}
	}
	return Object.freeze(next);
}

/** Host-neutral migration orchestration session. */
export class EditorMigrationFlowSession extends Disposable {
	private readonly stateEmitter = this._register(new Emitter<EditorMigrationFlowState>());
	readonly onDidChangeState: Event<EditorMigrationFlowState> = this.stateEmitter.event;

	private stateValue: EditorMigrationFlowState = emptyState();
	private generation = 0;
	private rollbackInspectionGeneration = 0;
	private rollbackInspectionCategories: readonly Exclude<EditorMigrationCategory, 'extensions'>[] | undefined;
	private readonly operationToken = this._register(new MutableDisposable<CancellationTokenSource>());

	constructor(
		private readonly sourceService: IEditorMigrationSourceService,
		private readonly planningService: IEditorMigrationPlanningService,
		private readonly applyService: IEditorMigrationApplyService,
		private readonly profilesService: IUserDataProfilesService,
		private readonly clipboardService: IClipboardService,
		private readonly logService: ILogService,
	) {
		super();
	}

	get state(): EditorMigrationFlowState {
		return this.stateValue;
	}

	override dispose(): void {
		this.operationToken.value?.cancel();
		super.dispose();
	}

	/** Loads recovery first, then enters a fresh read-only discovery flow when none exists. */
	async initialize(): Promise<void> {
		const generation = this.nextGeneration();
		this.update({ phase: 'loading', busy: true, error: undefined });
		try {
			const recoveries = await this.applyService.listRecoverableOperations();
			if (!this.isCurrent(generation)) {
				return;
			}
			if (recoveries.length) {
				this.update({ phase: 'recovery', busy: false, recoveries, announcement: localize('editorMigration.flow.recoveriesFound', "Recoverable imports found.") });
				return;
			}
			await this.discover(generation);
		} catch (error) {
			this.fail(generation, error);
		}
	}

	/** Starts another import without acknowledging or deleting earlier operations. */
	async startImport(): Promise<void> {
		const generation = this.nextGeneration();
		this.update({ ...emptyState(), phase: 'loading', busy: true, recoveries: this.stateValue.recoveries });
		await this.discover(generation);
	}

	async refreshDiscovery(): Promise<void> {
		const generation = this.nextGeneration();
		this.update({
			...emptyState(),
			phase: 'loading',
			busy: true,
			recoveries: this.stateValue.recoveries,
		});
		await this.discover(generation);
	}

	selectApplication(applicationId: string): void {
		const application = this.stateValue.applications.find(candidate => candidate.id === applicationId);
		if (!application) {
			return;
		}
		if (this.stateValue.selectedApplicationId === applicationId) {
			this.nextGeneration();
			this.update({ phase: 'profile', busy: false, error: undefined });
			return;
		}
		this.nextGeneration();
		this.update({
			phase: 'profile',
			selectedApplicationId: applicationId,
			selectedSourceRef: defaultEditorMigrationSourceProfile(application)?.ref,
			source: undefined,
			targets: [],
			selectedTarget: undefined,
			draft: undefined,
			selectedCategories: [],
			decisions: Object.freeze({}),
			reviewedPlan: undefined,
			publishers: [],
			progress: undefined,
			operation: undefined,
			rollbackInspection: undefined,
			reviewNeedsRebuild: false,
			error: undefined,
		});
	}

	selectSourceProfile(ref: EditorMigrationSourceProfileRef): void {
		const application = this.selectedApplication();
		if (!application?.profiles.some(source => source.ref.value === ref.value)) {
			return;
		}
		if (this.stateValue.selectedSourceRef?.value === ref.value) {
			return;
		}
		this.nextGeneration();
		this.update({ selectedSourceRef: ref, source: undefined, targets: [], selectedTarget: undefined, draft: undefined, selectedCategories: [], decisions: Object.freeze({}), reviewedPlan: undefined, publishers: [], progress: undefined, operation: undefined, rollbackInspection: undefined, reviewNeedsRebuild: false, error: undefined });
	}

	async continueFromProfile(): Promise<void> {
		const descriptor = this.selectedSourceDescriptor();
		if (!descriptor) {
			this.update({ error: localize('editorMigration.flow.chooseSource', "Choose a source profile to continue.") });
			return;
		}
		const generation = this.nextGeneration();
		const token = this.operationToken.value!.token;
		const categories = ALL_CATEGORIES.filter(category => descriptor.categories.some(summary => summary.category === category && summary.state === 'present'));
		if (this.stateValue.source?.ref.value === descriptor.ref.value) {
			this.update({ phase: 'target', busy: false, error: undefined });
			return;
		}
		this.update({ busy: true, error: undefined });
		try {
			const source = await this.sourceService.readSourceProfile(descriptor.ref, categories, token);
			if (!this.isCurrent(generation)) {
				return;
			}
			const targets = this.targetOptions();
			const defaultTarget = targets.find(target => target.kind === 'default');
			this.update({
				phase: 'target',
				busy: false,
				source,
				targets,
				selectedTarget: defaultTarget?.selection,
				selectedCategories: categories,
				draft: undefined,
				decisions: Object.freeze({}),
				reviewedPlan: undefined,
				publishers: [],
				reviewNeedsRebuild: false,
				announcement: localize('editorMigration.flow.sourceLoaded', "Source profile loaded. Hucode Default is selected as the target."),
			});
		} catch (error) {
			this.fail(generation, error);
		}
	}

	selectTarget(selection: EditorMigrationTargetSelection): void {
		if (sameTargetSelection(this.stateValue.selectedTarget, selection)) {
			return;
		}
		this.nextGeneration();
		this.update({ selectedTarget: selection, draft: undefined, selectedCategories: selectedSourceCategories(this.stateValue.source), decisions: Object.freeze({}), reviewedPlan: undefined, publishers: [], reviewNeedsRebuild: false, error: undefined });
	}

	async continueFromTarget(): Promise<void> {
		const source = this.stateValue.source;
		const selection = this.stateValue.selectedTarget;
		if (!source || !selection) {
			this.update({ error: localize('editorMigration.flow.chooseTarget', "Choose a target profile to continue.") });
			return;
		}
		if (this.stateValue.draft
			&& this.stateValue.draft.source.ref.value === source.ref.value
			&& sameTargetSelection(this.stateValue.draft.target.selection, selection)
			&& !this.stateValue.reviewNeedsRebuild) {
			this.nextGeneration();
			this.update({ phase: 'review', busy: false, error: undefined });
			return;
		}
		await this.buildReview();
	}

	async rebuildReview(): Promise<void> {
		await this.buildReview(true);
	}

	toggleCategory(category: EditorMigrationCategory, selected: boolean): void {
		const selectedCategories = ALL_CATEGORIES.filter(candidate => candidate === category ? selected : this.stateValue.selectedCategories.includes(candidate));
		if (selectedCategories.length === this.stateValue.selectedCategories.length && selectedCategories.every((candidate, index) => candidate === this.stateValue.selectedCategories[index])) {
			return;
		}
		this.nextGeneration();
		this.update({ selectedCategories, busy: false, reviewedPlan: undefined, publishers: [], reviewNeedsRebuild: false, error: undefined });
	}

	chooseDecision(id: string, choice: 'import' | 'preserveTarget'): void {
		if (!this.stateValue.draft?.decisions.some(decision => decision.id === id && decision.kind === 'conflict')) {
			return;
		}
		if (this.stateValue.decisions[id] === choice) {
			return;
		}
		this.nextGeneration();
		this.update({ decisions: Object.freeze({ ...this.stateValue.decisions, [id]: choice }), busy: false, reviewedPlan: undefined, publishers: [], reviewNeedsRebuild: false, error: undefined });
	}

	chooseAllSettingDifferences(choice: 'import' | 'preserveTarget'): void {
		if (!this.stateValue.draft) {
			return;
		}
		const decisions = chooseAllEditorMigrationSettingDifferences(this.stateValue.draft, this.stateValue.decisions, choice);
		if (Object.keys(decisions).every(id => decisions[id] === this.stateValue.decisions[id])) {
			return;
		}
		this.nextGeneration();
		this.update({ decisions, busy: false, reviewedPlan: undefined, publishers: [], reviewNeedsRebuild: false, error: undefined });
	}

	async acceptReview(): Promise<void> {
		const draft = this.stateValue.draft;
		if (!draft || !this.stateValue.selectedCategories.length) {
			this.update({ error: localize('editorMigration.flow.chooseCategory', "Select at least one category to continue.") });
			return;
		}
		const generation = this.nextGeneration();
		const token = this.operationToken.value!.token;
		this.update({ busy: true, error: undefined });
		try {
			const conflictIds = draft.decisions.filter(decision => decision.kind === 'conflict' && this.stateValue.selectedCategories.includes(decision.category)).map(decision => decision.id);
			const reviewedPlan = await this.planningService.acceptDraft(draft, {
				selectedCategories: this.stateValue.selectedCategories,
				decisions: conflictIds.map(id => ({ id, choice: this.stateValue.decisions[id]! })),
			});
			const verification = await this.planningService.verifyPlan(reviewedPlan, token);
			if (!this.isCurrent(generation)) {
				return;
			}
			if (verification.status !== 'unchanged') {
				const message = localize('editorMigration.flow.planChanged', "The source or target changed: {0}. Rebuild the review to continue.", verification.reasons.join(', '));
				this.update({ phase: 'review', busy: false, reviewedPlan: undefined, publishers: [], reviewNeedsRebuild: true, error: message, announcement: message });
				return;
			}
			const publishers = editorMigrationPublishers(reviewedPlan);
			this.update({ reviewedPlan, publishers, busy: false });
			if (publishers.length) {
				this.update({ phase: 'publishers', announcement: localize('editorMigration.flow.confirmPublishers', "Confirm extension publishers before importing.") });
			} else {
				await this.applyReviewedPlan(reviewedPlan, []);
			}
		} catch (error) {
			this.fail(generation, error);
		}
	}

	async confirmPublishers(): Promise<void> {
		if (!this.stateValue.reviewedPlan) {
			return;
		}
		await this.applyReviewedPlan(this.stateValue.reviewedPlan, this.stateValue.publishers);
	}

	requestCancellation(): void {
		if (this.stateValue.phase !== 'apply' || !this.operationToken.value) {
			return;
		}
		this.update({ canceling: true, announcement: localize('editorMigration.flow.canceling', "Canceling at the next safe checkpoint.") });
		this.operationToken.value.cancel();
	}

	async showRecovery(operationId: string): Promise<void> {
		this.rollbackInspectionGeneration++;
		this.rollbackInspectionCategories = undefined;
		try {
			const operation = await this.applyService.getOperation(operationId);
			this.update({ phase: 'results', operation, rollbackInspection: undefined, busy: false, error: undefined, announcement: localize('editorMigration.flow.resultsLoaded', "Migration results loaded.") });
		} catch (error) {
			this.update({ error: errorMessage(error) });
		}
	}

	async resume(operationId: string): Promise<void> {
		await this.runRecovery(operationId, (token, reporter) => this.applyService.resume(operationId, token, reporter));
	}

	async retry(operationId: string): Promise<void> {
		await this.runRecovery(operationId, (token, reporter) => this.applyService.retry(operationId, token, reporter));
	}

	async inspectRollback(categories: readonly Exclude<EditorMigrationCategory, 'extensions'>[]): Promise<void> {
		const operationId = this.stateValue.operation?.id;
		if (!operationId) {
			return;
		}
		const requestedCategories = fileCategories(categories);
		const generation = ++this.rollbackInspectionGeneration;
		try {
			const rollbackInspection = await this.applyService.inspectRollback(operationId, requestedCategories);
			if (generation !== this.rollbackInspectionGeneration || this.stateValue.operation?.id !== operationId) {
				return;
			}
			this.rollbackInspectionCategories = requestedCategories;
			this.update({
				rollbackInspection,
				error: undefined,
				announcement: rollbackInspection.driftedCategories.length
					? localize('editorMigration.flow.rollbackDrift', "Files changed after import in {0}.", rollbackInspection.driftedCategories.join(', '))
					: localize('editorMigration.flow.rollbackReady', "File changes can be rolled back safely."),
			});
		} catch (error) {
			if (generation === this.rollbackInspectionGeneration && this.stateValue.operation?.id === operationId) {
				this.update({ error: errorMessage(error) });
			}
		}
	}

	clearRollbackInspection(): void {
		this.rollbackInspectionGeneration++;
		this.rollbackInspectionCategories = undefined;
		if (this.stateValue.rollbackInspection) {
			this.update({ rollbackInspection: undefined, error: undefined });
		}
	}

	async rollback(categories: readonly Exclude<EditorMigrationCategory, 'extensions'>[], forceCategories: readonly Exclude<EditorMigrationCategory, 'extensions'>[] = []): Promise<void> {
		const operation = this.stateValue.operation;
		if (!operation) {
			return;
		}
		try {
			const requestedCategories = fileCategories(categories);
			const inspection = this.stateValue.rollbackInspection && sameFileCategories(requestedCategories, this.rollbackInspectionCategories ?? [])
				? this.stateValue.rollbackInspection
				: await this.applyService.inspectRollback(operation.id, requestedCategories);
			await this.runRecovery(operation.id, (token, reporter) => this.applyService.rollback(operation.id, { categories, forceCategories, inspectionFingerprint: inspection.fingerprint }, token, reporter));
		} catch (error) {
			this.update({ error: errorMessage(error), announcement: errorMessage(error) });
		}
	}

	async copyReport(): Promise<void> {
		try {
			if (this.stateValue.operation) {
				await this.clipboardService.writeText(formatEditorMigrationReport(this.stateValue.operation));
				this.update({ error: undefined, announcement: localize('editorMigration.flow.reportCopied', "Migration report copied.") });
			}
		} catch (error) {
			this.update({ error: errorMessage(error), announcement: errorMessage(error) });
		}
	}

	async acknowledge(): Promise<void> {
		if (!this.stateValue.operation) {
			return;
		}
		try {
			await this.applyService.acknowledge(this.stateValue.operation.id);
			await this.startImport();
		} catch (error) {
			this.update({ error: errorMessage(error), announcement: errorMessage(error) });
		}
	}

	back(): void {
		switch (this.stateValue.phase) {
			case 'profile': this.nextGeneration(); this.update({ phase: 'application', busy: false, error: undefined }); break;
			case 'target': this.nextGeneration(); this.update({ phase: 'profile', busy: false, error: undefined }); break;
			case 'review': this.nextGeneration(); this.update({ phase: 'target', busy: false, error: undefined }); break;
			case 'publishers': this.nextGeneration(); this.update({ phase: 'review', busy: false, reviewedPlan: undefined, publishers: [], error: undefined }); break;
		}
	}

	private async discover(generation: number): Promise<void> {
		try {
			const result = await this.sourceService.discoverSources({}, this.operationToken.value!.token);
			if (!this.isCurrent(generation)) {
				return;
			}
			this.update({ phase: 'application', busy: false, applications: groupEditorMigrationSources(result.sources), discoveryDiagnostics: result.diagnostics, announcement: localize('editorMigration.flow.sourcesFound', "{0} source profiles found.", result.sources.length) });
		} catch (error) {
			this.fail(generation, error);
		}
	}

	private async applyReviewedPlan(plan: EditorMigrationReviewedPlan, publishers: readonly string[]): Promise<void> {
		const generation = this.nextGeneration();
		const token = this.operationToken.value!.token;
		this.update({ phase: 'apply', busy: true, canceling: false, progress: undefined, operation: undefined, rollbackInspection: undefined, error: undefined, announcement: localize('editorMigration.flow.started', "Import started.") });
		try {
			const authorization = await this.applyService.createApplyAuthorization(plan, publishers);
			const result = await this.applyService.apply(plan, authorization, token, progress => {
				if (this.isCurrent(generation, true)) {
					this.update({ progress, announcement: progressAnnouncement(progress) });
				}
			});
			if (!this.isCurrent(generation, true)) {
				return;
			}
			const operation = await this.applyService.getOperation(result.operationId);
			this.update({ phase: 'results', busy: false, canceling: false, operation, announcement: result.aggregateOutcome === 'completed' ? localize('editorMigration.flow.completed', "Import completed.") : localize('editorMigration.flow.completedWithIssues', "Import completed with issues.") });
		} catch (error) {
			await this.handleNewApplyFailure(generation, error);
		}
	}

	private async runRecovery(operationId: string, run: (token: CancellationTokenSource['token'], reporter: (progress: EditorMigrationApplyProgress) => void) => Promise<unknown>): Promise<void> {
		const generation = this.nextGeneration();
		const token = this.operationToken.value!.token;
		this.update({ phase: 'apply', busy: true, canceling: false, progress: undefined, error: undefined });
		try {
			await run(token, progress => {
				if (this.isCurrent(generation, true)) {
					this.update({ progress, announcement: progressAnnouncement(progress) });
				}
			});
			const operation = await this.applyService.getOperation(operationId);
			this.update({ phase: 'results', busy: false, operation, canceling: false, rollbackInspection: undefined, announcement: localize('editorMigration.flow.operationFinished', "Migration operation finished.") });
		} catch (error) {
			await this.handleRecoveryFailure(generation, operationId, error);
		}
	}

	private async handleNewApplyFailure(generation: number, error: unknown): Promise<void> {
		if (!this.isCurrent(generation, true)) {
			return;
		}
		const operationId = this.stateValue.progress?.operationId;
		if (operationId) {
			try {
				const operation = await this.applyService.getOperation(operationId);
				if (this.isCurrent(generation, true)) {
					this.update({ phase: 'results', busy: false, canceling: false, operation, rollbackInspection: undefined, error: errorMessage(error), announcement: errorMessage(error) });
				}
				return;
			} catch (readError) {
				this.logService.error(readError instanceof Error ? readError : String(readError));
				const message = errorMessage(error);
				this.update({ phase: 'recovery', busy: false, canceling: false, error: message, announcement: message });
				return;
			}
		}
		if (isCancellationError(error)) {
			const message = localize('editorMigration.flow.canceledBeforeAdmission', "The operation was canceled before admission.");
			this.update({ phase: this.stateValue.publishers.length ? 'publishers' : 'review', busy: false, canceling: false, error: message, announcement: message });
			return;
		}
		if (error instanceof EditorMigrationApplyError && error.code === 'planDrift') {
			this.update({ phase: 'review', busy: false, canceling: false, reviewedPlan: undefined, publishers: [], reviewNeedsRebuild: true, error: error.message, announcement: error.message });
			return;
		}
		if (error instanceof EditorMigrationApplyError && error.code === 'invalidAuthorization') {
			this.update({ phase: this.stateValue.publishers.length ? 'publishers' : 'review', busy: false, canceling: false, error: error.message, announcement: error.message });
			return;
		}
		if (error instanceof EditorMigrationApplyError && (error.code === 'writerContention' || error.code === 'journalUnavailable')) {
			this.update({ phase: this.stateValue.publishers.length ? 'publishers' : 'review', busy: false, canceling: false, error: error.message, announcement: error.message });
			return;
		}
		this.update({ phase: this.stateValue.publishers.length ? 'publishers' : 'review', busy: false, canceling: false, error: errorMessage(error), announcement: errorMessage(error) });
	}

	private async buildReview(force = false): Promise<void> {
		const source = this.stateValue.source;
		const selection = this.stateValue.selectedTarget;
		if (!source || !selection) {
			this.update({ error: localize('editorMigration.flow.chooseTarget', "Choose a target profile to continue.") });
			return;
		}
		// A pending rebuild means the reviewed evidence is known stale, so returning through Target
		// and continuing must rebuild the draft rather than reuse it.
		if (!force && !this.stateValue.reviewNeedsRebuild && this.stateValue.draft && sameTargetSelection(this.stateValue.draft.target.selection, selection)) {
			this.update({ phase: 'review', busy: false, error: undefined });
			return;
		}
		const generation = this.nextGeneration();
		const token = this.operationToken.value!.token;
		this.update({ busy: true, error: undefined });
		try {
			const target = await this.planningService.inspectTarget(selection, this.stateValue.selectedCategories, token);
			const draft = await this.planningService.createDraftFromCurrentEvidence(source, target, token);
			if (!this.isCurrent(generation)) {
				return;
			}
			const decisions = Object.fromEntries(draft.decisions
				.filter(decision => decision.kind === 'conflict')
				.map(decision => [decision.id, decision.defaultChoice === 'import' ? 'import' as const : 'preserveTarget' as const]));
			this.update({ phase: 'review', busy: false, draft, decisions: Object.freeze(decisions), reviewedPlan: undefined, publishers: [], reviewNeedsRebuild: false, announcement: localize('editorMigration.flow.reviewReady', "Import review is ready.") });
		} catch (error) {
			this.fail(generation, error);
		}
	}

	private async handleRecoveryFailure(generation: number, operationId: string, error: unknown): Promise<void> {
		if (!this.isCurrent(generation, true)) {
			return;
		}
		const message = errorMessage(error);
		try {
			const operation = await this.applyService.getOperation(operationId);
			if (this.isCurrent(generation, true)) {
				this.update({ phase: 'results', busy: false, canceling: false, operation, rollbackInspection: undefined, error: message, announcement: message });
			}
		} catch (readError) {
			this.logService.error(readError instanceof Error ? readError : String(readError));
			this.update({ phase: 'recovery', busy: false, canceling: false, error: message, announcement: message });
		}
	}

	private selectedApplication(): EditorMigrationSourceApplication | undefined {
		return this.stateValue.applications.find(application => application.id === this.stateValue.selectedApplicationId);
	}

	private selectedSourceDescriptor(): EditorMigrationSourceDescriptor | undefined {
		return this.selectedApplication()?.profiles.find(source => source.ref.value === this.stateValue.selectedSourceRef?.value);
	}

	private targetOptions(): readonly EditorMigrationTargetOption[] {
		return this.profilesService.profiles
			.filter(profile => !profile.isInternal && !profile.isTransient)
			.map(profile => Object.freeze({
				selection: Object.freeze({ kind: 'existing' as const, profileId: profile.id }),
				name: profile.name,
				kind: profile.isDefault ? 'default' as const : 'named' as const,
			}));
	}

	private nextGeneration(): number {
		this.operationToken.value?.cancel();
		this.operationToken.value = new CancellationTokenSource();
		return ++this.generation;
	}

	private isCurrent(generation: number, acceptCanceled = false): boolean {
		return generation === this.generation && (acceptCanceled || !this.operationToken.value?.token.isCancellationRequested);
	}

	private fail(generation: number, error: unknown): void {
		if (!this.isCurrent(generation)) {
			return;
		}
		this.logService.error(error instanceof Error ? error : String(error));
		this.update({ busy: false, error: errorMessage(error) });
	}

	private update(update: Partial<EditorMigrationFlowState> | EditorMigrationFlowState): void {
		this.stateValue = Object.freeze({ ...this.stateValue, ...update });
		this.stateEmitter.fire(this.stateValue);
	}
}

function fileCategories(categories: readonly Exclude<EditorMigrationCategory, 'extensions'>[]): readonly Exclude<EditorMigrationCategory, 'extensions'>[] {
	return ALL_CATEGORIES.filter((category): category is Exclude<EditorMigrationCategory, 'extensions'> => category !== 'extensions' && categories.includes(category));
}

function sameFileCategories(left: readonly Exclude<EditorMigrationCategory, 'extensions'>[], right: readonly Exclude<EditorMigrationCategory, 'extensions'>[]): boolean {
	return left.length === right.length && left.every(category => right.includes(category));
}

/** Factory and owner for the command's reattachable session. */
export const IEditorMigrationFlowService = createDecorator<IEditorMigrationFlowService>('editorMigrationFlowService');

export interface IEditorMigrationFlowService {
	readonly _serviceBrand: undefined;
	createSession(): EditorMigrationFlowSession;
	getStandaloneSession(): EditorMigrationFlowSession;
}

class EditorMigrationFlowService implements IEditorMigrationFlowService {
	declare readonly _serviceBrand: undefined;
	private standaloneSession: EditorMigrationFlowSession | undefined;

	constructor(
		@IEditorMigrationSourceService private readonly sourceService: IEditorMigrationSourceService,
		@IEditorMigrationPlanningService private readonly planningService: IEditorMigrationPlanningService,
		@IEditorMigrationApplyService private readonly applyService: IEditorMigrationApplyService,
		@IUserDataProfilesService private readonly profilesService: IUserDataProfilesService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ILogService private readonly logService: ILogService,
	) { }

	createSession(): EditorMigrationFlowSession {
		return new EditorMigrationFlowSession(this.sourceService, this.planningService, this.applyService, this.profilesService, this.clipboardService, this.logService);
	}

	getStandaloneSession(): EditorMigrationFlowSession {
		if (!this.standaloneSession) {
			this.standaloneSession = this.createSession();
			void this.standaloneSession.initialize();
		}
		return this.standaloneSession;
	}
}

function emptyState(): EditorMigrationFlowState {
	return Object.freeze({
		phase: 'loading',
		busy: false,
		canceling: false,
		error: undefined,
		announcement: undefined,
		recoveries: [],
		applications: [],
		discoveryDiagnostics: [],
		selectedApplicationId: undefined,
		selectedSourceRef: undefined,
		source: undefined,
		targets: [],
		selectedTarget: undefined,
		draft: undefined,
		selectedCategories: [],
		decisions: Object.freeze({}),
		reviewedPlan: undefined,
		publishers: [],
		progress: undefined,
		operation: undefined,
		rollbackInspection: undefined,
		reviewNeedsRebuild: false,
	});
}

function sameTargetSelection(left: EditorMigrationTargetSelection | undefined, right: EditorMigrationTargetSelection | undefined): boolean {
	if (!left || !right || left.kind !== right.kind) {
		return false;
	}
	if (left.kind === 'existing') {
		return left.profileId === (right as Extract<EditorMigrationTargetSelection, { readonly kind: 'existing' }>).profileId;
	}
	const proposed = right as Extract<EditorMigrationTargetSelection, { readonly kind: 'proposed' }>;
	if (left.name !== proposed.name || left.options?.icon !== proposed.options?.icon) {
		return false;
	}
	const leftFlags = left.options?.useDefaultFlags ?? {};
	const rightFlags = proposed.options?.useDefaultFlags ?? {};
	const keys = new Set([...Object.keys(leftFlags), ...Object.keys(rightFlags)]);
	return [...keys].every(key => leftFlags[key as EditorMigrationCategory] === rightFlags[key as EditorMigrationCategory]);
}

function selectedSourceCategories(source: EditorMigrationSourceSnapshot | undefined): readonly EditorMigrationCategory[] {
	return source ? ALL_CATEGORIES.filter(category => source.categories.some(candidate => candidate.category === category && candidate.state === 'present')) : [];
}

function progressAnnouncement(progress: EditorMigrationApplyProgress): string {
	return localize('editorMigration.flow.progress', "{0}. {1} of {2} items recorded.", progressStageLabel(progress.stage), progress.results.length, progress.selectedItemCount);
}

function progressStageLabel(stage: EditorMigrationApplyProgress['stage']): string {
	switch (stage) {
		case 'admitted': return localize('editorMigration.flow.stage.admitted', "Preparing the import");
		case 'attachingTarget': return localize('editorMigration.flow.stage.attachingTarget', "Preparing the target profile");
		case 'snapshotting': return localize('editorMigration.flow.stage.snapshotting', "Saving recovery copies");
		case 'materializing': return localize('editorMigration.flow.stage.materializing', "Preparing inherited profile files");
		case 'applying': return localize('editorMigration.flow.stage.applying', "Importing selected items");
		case 'settled': return localize('editorMigration.flow.stage.settled', "Import finished");
		case 'rollbackPending': return localize('editorMigration.flow.stage.rollbackPending', "Restoring file changes");
		case 'rolledBack': return localize('editorMigration.flow.stage.rolledBack', "File changes restored");
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

registerSingleton(IEditorMigrationFlowService, EditorMigrationFlowService, InstantiationType.Delayed);
