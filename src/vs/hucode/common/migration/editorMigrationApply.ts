/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { applyEdits, setProperty } from '../../../base/common/jsonEdit.js';
import { parse } from '../../../base/common/json.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { EditorMigrationCategory, EditorMigrationJsonValue } from './editorMigrationSource.js';
import { EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION, EditorMigrationPlanningEvidence, EditorMigrationReviewedPlan, EditorMigrationKeybindingOperation, EditorMigrationSetSettingOperation } from './editorMigrationPlanning.js';
import { canonicalizeEditorMigrationValue, fingerprintEditorMigrationValue } from './editorMigrationPlanningCanonical.js';
import { acceptEditorMigrationPlanDraft, createEditorMigrationPlanDraft, editorMigrationKeybindingRowId } from './editorMigrationPlanner.js';

/** Version of durable editor migration Apply operation records. */
export const EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION = 2;

/** Planning schema embedded in operation schema v2 journals. */
export const EDITOR_MIGRATION_OPERATION_PLANNING_SCHEMA_VERSION = 2;

/** Version of the complete-plan integrity envelope in operation schema v2. */
export const EDITOR_MIGRATION_OPERATION_INTEGRITY_SCHEMA_VERSION = 1;

/** Expected Apply failures that callers can handle without parsing messages. */
export type EditorMigrationApplyErrorCode =
	| 'planDrift'
	| 'invalidAuthorization'
	| 'writerContention'
	| 'journalUnavailable'
	| 'rollbackDrift';

/** An expected migration Apply failure with a stable machine-readable code. */
export class EditorMigrationApplyError extends Error {
	constructor(readonly code: EditorMigrationApplyErrorCode, message: string) {
		super(message);
		this.name = 'EditorMigrationApplyError';
	}
}

/** Opaque, short-lived proof that Review confirmed a plan's publishers. */
export interface EditorMigrationApplyAuthorization {
	readonly nonce: string;
	readonly publisherSetFingerprint: string;
}

/** Non-reusable authorization facts retained with an admitted operation. */
export interface EditorMigrationConsumedAuthorization {
	readonly planningSchemaVersion: number;
	readonly planFingerprint: string;
	readonly publishers: readonly string[];
	readonly publisherSetFingerprint: string;
	readonly issuedAt: number;
	readonly consumedAt: number;
}

/** Issues and consumes process-local migration publisher authorizations. */
export class EditorMigrationApplyAuthorizationIssuer {
	private readonly pending = new Map<string, {
		readonly planningSchemaVersion: number;
		readonly planFingerprint: string;
		readonly publishers: readonly string[];
		readonly publisherSetFingerprint: string;
		readonly issuedAt: number;
	}>();

	constructor(private readonly now: () => number = Date.now, private readonly nonce: () => string = generateUuid) { }

	async create(plan: EditorMigrationReviewedPlan, confirmedPublishers: readonly string[]): Promise<EditorMigrationApplyAuthorization> {
		const planFingerprint = await verifiedEditorMigrationPlanFingerprint(plan);
		const expected = editorMigrationPublishers(plan);
		const confirmed = canonicalPublishers(confirmedPublishers);
		if (!equalStrings(expected, confirmed)) {
			throw new EditorMigrationApplyError('invalidAuthorization', 'Confirmed publisher set does not match the reviewed plan');
		}
		const publisherSetFingerprint = await fingerprintEditorMigrationValue(expected);
		let nonce = this.nonce();
		while (!nonce || this.pending.has(nonce)) {
			nonce = this.nonce();
		}
		this.pending.set(nonce, {
			planningSchemaVersion: plan.schemaVersion,
			planFingerprint,
			publishers: expected,
			publisherSetFingerprint,
			issuedAt: this.now(),
		});
		return Object.freeze({ nonce, publisherSetFingerprint });
	}

	async consume(plan: EditorMigrationReviewedPlan, authorization: EditorMigrationApplyAuthorization): Promise<EditorMigrationConsumedAuthorization> {
		const planFingerprint = await verifiedEditorMigrationPlanFingerprint(plan);
		if (!authorization || typeof authorization.nonce !== 'string' || typeof authorization.publisherSetFingerprint !== 'string') {
			throw new EditorMigrationApplyError('invalidAuthorization', 'Apply authorization is malformed');
		}
		const pending = this.pending.get(authorization.nonce);
		if (!pending) {
			throw new EditorMigrationApplyError('invalidAuthorization', 'Apply authorization is unknown or has already been consumed');
		}
		if (pending.planningSchemaVersion !== plan.schemaVersion
			|| pending.planFingerprint !== planFingerprint
			|| pending.publisherSetFingerprint !== authorization.publisherSetFingerprint
			|| !equalStrings(pending.publishers, editorMigrationPublishers(plan))) {
			throw new EditorMigrationApplyError('invalidAuthorization', 'Apply authorization does not match the reviewed plan');
		}
		const consumedAt = this.now();
		if (consumedAt - pending.issuedAt > 10 * 60 * 1_000) {
			this.pending.delete(authorization.nonce);
			throw new EditorMigrationApplyError('invalidAuthorization', 'Apply authorization has expired');
		}
		this.pending.delete(authorization.nonce);
		return Object.freeze({ ...pending, consumedAt });
	}
}

/** Returns the canonical publisher set represented by exact extension operations. */
export function editorMigrationPublishers(plan: EditorMigrationReviewedPlan): readonly string[] {
	return canonicalPublishers(plan.operations
		.filter(operation => operation.kind === 'installExtension')
		.map(operation => publisherFromExtensionId(operation.source.id)));
}

/** Rebuilds and verifies the canonical reviewed plan and returns its fingerprint. */
export async function verifiedEditorMigrationPlanFingerprint(plan: EditorMigrationReviewedPlan): Promise<string> {
	if (plan.schemaVersion !== EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION) {
		throw new Error(`Unsupported reviewed migration plan schema version '${plan.schemaVersion}'`);
	}
	let canonical: EditorMigrationReviewedPlan;
	try {
		canonical = await acceptEditorMigrationPlanDraft(
			createEditorMigrationPlanDraft(plan.source, plan.target, plan.evidence),
			plan.choices,
		);
	} catch (error) {
		throw new Error(`Reviewed migration plan is malformed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const actual = canonicalizeEditorMigrationValue({
		operations: plan.operations,
		prerequisites: plan.prerequisites,
		fingerprints: plan.fingerprints,
	});
	const expected = canonicalizeEditorMigrationValue({
		operations: canonical.operations,
		prerequisites: canonical.prerequisites,
		fingerprints: canonical.fingerprints,
	});
	if (actual !== expected) {
		throw new Error('Reviewed migration plan is non-canonical, stale, or corrupt');
	}
	return canonical.fingerprints.plan;
}

/** Verifies the stable plan aggregate embedded in a durable Apply journal. */
export async function verifiedPersistedEditorMigrationPlanFingerprint(plan: EditorMigrationReviewedPlan): Promise<string> {
	if (plan.schemaVersion !== EDITOR_MIGRATION_OPERATION_PLANNING_SCHEMA_VERSION) {
		throw new Error(`Unsupported persisted migration plan schema version '${plan.schemaVersion}'`);
	}
	const actual = await fingerprintEditorMigrationValue({
		schemaVersion: plan.schemaVersion,
		fingerprints: {
			source: plan.fingerprints.source,
			target: plan.fingerprints.target,
			choices: plan.fingerprints.choices,
			policy: plan.fingerprints.policy,
			gallery: plan.fingerprints.gallery,
		},
		operations: plan.operations,
		prerequisites: plan.prerequisites,
	});
	if (actual !== plan.fingerprints.plan) {
		throw new Error('Persisted migration plan aggregate fingerprint is corrupt');
	}
	return actual;
}

/** Versioned digest binding a durable operation to every raw reviewed-plan field. */
export interface EditorMigrationOperationIntegrity {
	readonly schemaVersion: typeof EDITOR_MIGRATION_OPERATION_INTEGRITY_SCHEMA_VERSION;
	readonly algorithm: 'sha256';
	readonly planDigest: string;
}

/** Creates the complete-plan integrity envelope persisted at admission. */
export async function createEditorMigrationOperationIntegrity(plan: EditorMigrationReviewedPlan): Promise<EditorMigrationOperationIntegrity> {
	return Object.freeze({
		schemaVersion: EDITOR_MIGRATION_OPERATION_INTEGRITY_SCHEMA_VERSION,
		algorithm: 'sha256',
		planDigest: await fingerprintEditorMigrationValue(plan),
	});
}

/** Verifies a durable complete-plan digest without invoking the current planner. */
export async function verifyEditorMigrationOperationIntegrity(plan: EditorMigrationReviewedPlan, integrity: EditorMigrationOperationIntegrity): Promise<void> {
	if (!integrity || integrity.schemaVersion !== EDITOR_MIGRATION_OPERATION_INTEGRITY_SCHEMA_VERSION || integrity.algorithm !== 'sha256'
		|| integrity.planDigest !== await fingerprintEditorMigrationValue(plan)) {
		throw new Error('Persisted migration operation plan integrity is corrupt');
	}
}

/** Produces the complete settings JSONC text for reviewed assignments. */
export function reduceEditorMigrationSettings(contents: string, operations: readonly EditorMigrationSetSettingOperation[]): string {
	let result = contents.trim() ? contents : '{}\n';
	for (const operation of operations) {
		result = applyEdits(result, setProperty(result, [operation.item], operation.source, formatting(result)));
	}
	return result;
}

/** Produces complete keybindings JSONC text for reviewed indexed changes. */
export function reduceEditorMigrationKeybindings(contents: string, evidence: EditorMigrationPlanningEvidence, operations: readonly EditorMigrationKeybindingOperation[]): string {
	let result = contents.trim() ? contents : '[]\n';
	const parsed = parse(result);
	if (!Array.isArray(parsed) || !parsed.every(isJsonObject)) {
		throw new Error('Target keybindings must contain a JSON array of objects');
	}
	const rowIds = parsed.map((entry, index) => editorMigrationKeybindingRowId(entry, evidence, index));
	const replacements = operations.filter(operation => operation.kind === 'replaceKeybinding').map(operation => {
		const indexes = operation.relatedTargetIds.map(id => rowIds.indexOf(id)).filter(index => index >= 0).sort((a, b) => a - b);
		if (indexes.length !== operation.relatedTargetIds.length || indexes.length === 0) {
			throw new Error('Reviewed keybinding conflicts no longer match the target');
		}
		return { operation, indexes };
	});
	const claimed = new Set<number>();
	for (const replacement of replacements) {
		if (replacement.indexes.some(index => claimed.has(index))) {
			throw new Error('Reviewed keybinding replacements overlap');
		}
		replacement.indexes.forEach(index => claimed.add(index));
	}
	const replacementByIndex = new Map(replacements.map(replacement => [replacement.indexes[0], replacement.operation.source]));
	for (const index of [...claimed].sort((a, b) => b - a)) {
		const replacement = replacementByIndex.get(index);
		result = applyEdits(result, setProperty(result, [index], undefined, formatting(result)));
		if (replacement) {
			result = applyEdits(result, setProperty(result, [index], replacement, formatting(result)));
		}
	}
	for (const operation of operations.filter(operation => operation.kind === 'addKeybinding')) {
		result = applyEdits(result, setProperty(result, [-1], operation.source, formatting(result)));
	}
	return result;
}

export type EditorMigrationItemOutcome = 'completed' | 'alreadyPresent' | 'skipped' | 'unavailable' | 'incompatible' | 'canceled' | 'failed';
export type EditorMigrationAggregateOutcome = 'completed' | 'completedWithIssues' | 'recoverable' | 'rolledBack';

/** Durable stage of one category or operation. */
export type EditorMigrationOperationStage = 'admitted' | 'attachingTarget' | 'snapshotting' | 'materializing' | 'applying' | 'settled' | 'rollbackPending' | 'rolledBack';

/** Stable local diagnostic attached to an item result. */
export interface EditorMigrationOperationDiagnostic {
	readonly code: string;
	readonly message: string;
}

/** Durable result of one reviewed category or extension item. */
export interface EditorMigrationItemResult {
	readonly id: string;
	readonly category: EditorMigrationCategory;
	readonly outcome: EditorMigrationItemOutcome;
	readonly attempts: number;
	readonly diagnostic?: EditorMigrationOperationDiagnostic;
}

/** Resource state retained for idempotence and rollback. */
export interface EditorMigrationSnapshotManifestEntry {
	readonly category: EditorMigrationCategory;
	readonly item?: string;
	readonly state: 'absent' | 'present';
	readonly ownership: 'target' | 'default';
	readonly resource: string;
	readonly snapshotPath?: string;
	readonly byteHash: string;
	/** Hidden owned contents preserved before inherited data is materialized. */
	readonly hiddenOwnedState?: 'absent' | 'present';
	readonly hiddenOwnedSnapshotPath?: string;
	readonly hiddenOwnedByteHash?: string;
	readonly semanticHash?: string;
	/** Hash proven immediately after an inherited resource is seeded locally. */
	readonly materializedHash?: string;
	readonly postApplyHash?: string;
}

/** Complete profile inheritance flags retained across ownership transitions. */
export type EditorMigrationProfileFlags = Readonly<Record<string, boolean | undefined>>;

/** Target identity reserved and attached by an admitted operation. */
export interface EditorMigrationOperationTarget {
	readonly state: 'pending' | 'reserved' | 'attached';
	readonly profileId?: string;
	readonly profileName?: string;
}

/** Durable intent recorded before an extension installation leaves the process. */
export interface EditorMigrationExtensionInstallIntent {
	readonly operationId: string;
	readonly actualProfileLocation: string;
}

/** Secondary snapshot retained before a force rollback overwrites drift. */
export interface EditorMigrationRollbackDriftSnapshot {
	readonly category: Exclude<EditorMigrationCategory, 'extensions'>;
	readonly item?: string;
	readonly resource: string;
	readonly snapshotPath: string;
	readonly byteHash: string;
}

/** Exact profile-ownership transition journaled before profile metadata changes. */
export interface EditorMigrationOwnershipChangeIntent {
	readonly categories: readonly EditorMigrationCategory[];
	readonly beforeFlags: EditorMigrationProfileFlags;
	readonly afterFlags: EditorMigrationProfileFlags;
	readonly state: 'pending' | 'completed';
}

/** One rollback resource whose Apply postcondition was durably proven. */
export interface EditorMigrationRollbackResourceProgress {
	readonly category: Exclude<EditorMigrationCategory, 'extensions'>;
	readonly item?: string;
	readonly resource: string;
	readonly expectedPostApplyHash: string;
	readonly expectedRestoredHash: string;
	readonly state: 'pending' | 'restored';
	readonly forceSnapshotPath?: string;
	readonly forceObservedHash?: string;
}

/** Durable rollback request and its safe-boundary progress. */
export interface EditorMigrationRollbackIntent {
	readonly categories: readonly Exclude<EditorMigrationCategory, 'extensions'>[];
	readonly forceCategories: readonly Exclude<EditorMigrationCategory, 'extensions'>[];
	readonly beforeFlags: EditorMigrationProfileFlags;
	readonly afterFlags: EditorMigrationProfileFlags;
	readonly ownershipState: 'pending' | 'restored';
	/** Set durably before the first ownership or resource mutation. */
	readonly mutationStarted: boolean;
	readonly resources: readonly EditorMigrationRollbackResourceProgress[];
}

/** Durable, versioned Apply operation. */
export interface EditorMigrationOperation {
	readonly schemaVersion: typeof EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION;
	readonly id: string;
	readonly revision: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly plan: EditorMigrationReviewedPlan;
	readonly integrity: EditorMigrationOperationIntegrity;
	readonly authorization: EditorMigrationConsumedAuthorization;
	readonly stage: EditorMigrationOperationStage;
	readonly cancellationRequested: boolean;
	readonly target: EditorMigrationOperationTarget;
	readonly snapshots: readonly EditorMigrationSnapshotManifestEntry[];
	readonly snapshotCompletedCategories?: readonly EditorMigrationCategory[];
	readonly ownershipChange?: EditorMigrationOwnershipChangeIntent;
	readonly extensionInstallIntents: readonly EditorMigrationExtensionInstallIntent[];
	readonly retryItemIds: readonly string[];
	readonly rollbackDriftSnapshots: readonly EditorMigrationRollbackDriftSnapshot[];
	readonly rollbackIntent?: EditorMigrationRollbackIntent;
	readonly results: readonly EditorMigrationItemResult[];
	readonly aggregateOutcome?: EditorMigrationAggregateOutcome;
	readonly acknowledged: boolean;
	readonly unsupportedSchemaVersion?: number;
}

/** Stable operation fields suitable for a recovery picker. */
export interface EditorMigrationOperationSummary {
	readonly id: string;
	readonly stage: EditorMigrationOperationStage;
	readonly aggregateOutcome?: EditorMigrationAggregateOutcome;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly targetName?: string;
	readonly recoverable: boolean;
	readonly unsupportedSchemaVersion?: number;
}

/** Result returned only after the final checkpoint is durable. */
export interface EditorMigrationOperationResult {
	readonly operationId: string;
	readonly aggregateOutcome: EditorMigrationAggregateOutcome;
	readonly stage: EditorMigrationOperationStage;
	readonly results: readonly EditorMigrationItemResult[];
}

/** Explicit categories authorized for rollback. */
export interface EditorMigrationRollbackOptions {
	readonly categories: readonly Exclude<EditorMigrationCategory, 'extensions'>[];
	readonly forceCategories?: readonly Exclude<EditorMigrationCategory, 'extensions'>[];
	readonly inspectionFingerprint?: string;
}

/** Read-only rollback evidence that a force confirmation is bound to. */
export interface EditorMigrationRollbackInspection {
	readonly operationId: string;
	readonly operationRevision: number;
	readonly eligibleCategories: readonly Exclude<EditorMigrationCategory, 'extensions'>[];
	readonly driftedCategories: readonly Exclude<EditorMigrationCategory, 'extensions'>[];
	readonly fingerprint: string;
}

/** One progress snapshot emitted only after the matching journal revision is durable. */
export interface EditorMigrationApplyProgress {
	readonly operationId: string;
	readonly revision: number;
	readonly stage: EditorMigrationOperationStage;
	readonly target: EditorMigrationOperationTarget;
	readonly selectedItemCount: number;
	readonly results: readonly EditorMigrationItemResult[];
	readonly cancellationRequested: boolean;
	readonly rollback?: {
		readonly categories: readonly Exclude<EditorMigrationCategory, 'extensions'>[];
		readonly restoredResourceCount: number;
		readonly resourceCount: number;
		readonly mutationStarted: boolean;
	};
}

/** Presentation-only observer for durable Apply checkpoints. */
export type EditorMigrationApplyProgressReporter = (progress: EditorMigrationApplyProgress) => void;

/** Public desktop Apply coordinator. */
export const IEditorMigrationApplyService = createDecorator<IEditorMigrationApplyService>('editorMigrationApplyService');

/** Executes, recovers, and cleans up durable editor migration operations. */
export interface IEditorMigrationApplyService {
	readonly _serviceBrand: undefined;
	createApplyAuthorization(plan: EditorMigrationReviewedPlan, confirmedPublishers: readonly string[]): Promise<EditorMigrationApplyAuthorization>;
	apply(plan: EditorMigrationReviewedPlan, authorization: EditorMigrationApplyAuthorization, token: CancellationToken, reporter?: EditorMigrationApplyProgressReporter): Promise<EditorMigrationOperationResult>;
	getOperation(operationId: string): Promise<EditorMigrationOperation>;
	listRecoverableOperations(): Promise<readonly EditorMigrationOperationSummary[]>;
	resume(operationId: string, token: CancellationToken, reporter?: EditorMigrationApplyProgressReporter): Promise<EditorMigrationOperationResult>;
	retry(operationId: string, token: CancellationToken, reporter?: EditorMigrationApplyProgressReporter): Promise<EditorMigrationOperationResult>;
	inspectRollback(operationId: string, categories: readonly Exclude<EditorMigrationCategory, 'extensions'>[]): Promise<EditorMigrationRollbackInspection>;
	rollback(operationId: string, options: EditorMigrationRollbackOptions, token: CancellationToken, reporter?: EditorMigrationApplyProgressReporter): Promise<EditorMigrationOperationResult>;
	acknowledge(operationId: string): Promise<void>;
}

/** Builds an immutable presentation snapshot from one durable operation revision. */
export function toEditorMigrationApplyProgress(operation: EditorMigrationOperation): EditorMigrationApplyProgress {
	const rollback = operation.rollbackIntent ? {
		categories: operation.rollbackIntent.categories,
		restoredResourceCount: operation.rollbackIntent.resources.filter(resource => resource.state === 'restored').length,
		resourceCount: operation.rollbackIntent.resources.length,
		mutationStarted: operation.rollbackIntent.mutationStarted,
	} : undefined;
	return Object.freeze({
		operationId: operation.id,
		revision: operation.revision,
		stage: operation.stage,
		target: Object.freeze({ ...operation.target }),
		selectedItemCount: new Set([
			...operation.plan.choices.selectedCategories,
			...operation.plan.operations.filter(item => item.category === 'snippets' || item.category === 'extensions').map(item => item.id),
		]).size,
		results: Object.freeze(operation.results.map(result => Object.freeze({ ...result }))),
		cancellationRequested: operation.cancellationRequested,
		...(rollback ? { rollback: Object.freeze(rollback) } : {}),
	});
}

/** Derives the aggregate operation result from durable item outcomes. */
export function deriveEditorMigrationAggregateOutcome(outcomes: readonly EditorMigrationItemOutcome[], recoverable = false): EditorMigrationAggregateOutcome {
	if (recoverable) {
		return 'recoverable';
	}
	return outcomes.every(outcome => outcome === 'completed' || outcome === 'alreadyPresent') ? 'completed' : 'completedWithIssues';
}

/** Telemetry-safe Apply event input. */
export interface EditorMigrationTelemetryInput {
	readonly operationSchemaVersion: number;
	readonly planningSchemaVersion: number;
	readonly aggregateOutcome: EditorMigrationAggregateOutcome;
	readonly phase: string;
	readonly outcomes: readonly EditorMigrationItemOutcome[];
	readonly durationMs: number;
}

/** Exact telemetry-safe Apply event payload. */
export interface EditorMigrationTelemetryPayload {
	readonly operationSchemaVersion: number;
	readonly planningSchemaVersion: number;
	readonly aggregateOutcome: EditorMigrationAggregateOutcome;
	readonly phase: string;
	readonly outcomeCounts: Readonly<Partial<Record<EditorMigrationItemOutcome, number>>>;
	readonly durationBucket: 'underMinute' | 'underFiveMinutes' | 'fiveMinutesOrMore';
}

/** Builds the intentionally closed telemetry payload. */
export function toEditorMigrationTelemetry(input: EditorMigrationTelemetryInput): EditorMigrationTelemetryPayload {
	const outcomeCounts: Partial<Record<EditorMigrationItemOutcome, number>> = {};
	for (const outcome of input.outcomes) {
		outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
	}
	const payload: EditorMigrationTelemetryPayload = {
		operationSchemaVersion: input.operationSchemaVersion,
		planningSchemaVersion: input.planningSchemaVersion,
		aggregateOutcome: input.aggregateOutcome,
		phase: input.phase,
		outcomeCounts,
		durationBucket: input.durationMs < 60_000 ? 'underMinute' : input.durationMs < 5 * 60_000 ? 'underFiveMinutes' : 'fiveMinutesOrMore',
	};
	return Object.freeze(payload);
}

/** Normalizes publishers into a sorted, case-insensitive set. */
function canonicalPublishers(publishers: readonly string[]): readonly string[] {
	return [...new Set(publishers.map(publisher => publisher.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Extracts the publisher segment from a canonical extension identifier. */
function publisherFromExtensionId(id: string): string {
	const separator = id.indexOf('.');
	if (separator <= 0) {
		throw new Error(`Extension '${id}' has no publisher`);
	}
	return id.slice(0, separator);
}

/** Compares two already-canonical string sequences for exact equality. */
function equalStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Infers indentation and line-ending preferences from existing JSONC content. */
function formatting(contents: string): { readonly tabSize: number; readonly insertSpaces: boolean; readonly eol: string } {
	const eol = contents.includes('\r\n') ? '\r\n' : '\n';
	const indentation = /(?:^|\r?\n)([ \t]+)["{/]/.exec(contents)?.[1] ?? '\t';
	return { tabSize: indentation[0] === '\t' ? 4 : indentation.length, insertSpaces: indentation[0] !== '\t', eol };
}

/** Narrows an unknown value to a JSON object. */
function isJsonObject(value: unknown): value is Readonly<Record<string, EditorMigrationJsonValue>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
