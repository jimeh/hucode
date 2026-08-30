/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { applyEdits, setProperty } from '../../../base/common/jsonEdit.js';
import { parse } from '../../../base/common/json.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { EditorMigrationCategory } from './editorMigrationSource.js';
import { EditorMigrationPlanningEvidence, EditorMigrationReviewedPlan, EditorMigrationKeybindingOperation, EditorMigrationSetSettingOperation } from './editorMigrationPlanning.js';
import { fingerprintEditorMigrationValue } from './editorMigrationPlanningCanonical.js';
import { editorMigrationKeybindingRowId } from './editorMigrationPlanner.js';

/** Version of durable editor migration Apply operation records. */
export const EDITOR_MIGRATION_OPERATION_SCHEMA_VERSION = 1;

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

	constructor(private readonly now: () => number = Date.now, private readonly nonce: () => string = () => crypto.randomUUID()) { }

	async create(plan: EditorMigrationReviewedPlan, confirmedPublishers: readonly string[]): Promise<EditorMigrationApplyAuthorization> {
		const planFingerprint = await verifiedEditorMigrationPlanFingerprint(plan);
		const expected = editorMigrationPublishers(plan);
		const confirmed = canonicalPublishers(confirmedPublishers);
		if (!equalStrings(expected, confirmed)) {
			throw new Error('Confirmed publisher set does not match the reviewed plan');
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
			throw new Error('Apply authorization is malformed');
		}
		const pending = this.pending.get(authorization.nonce);
		if (!pending) {
			throw new Error('Apply authorization is unknown or has already been consumed');
		}
		if (pending.planningSchemaVersion !== plan.schemaVersion
			|| pending.planFingerprint !== planFingerprint
			|| pending.publisherSetFingerprint !== authorization.publisherSetFingerprint
			|| !equalStrings(pending.publishers, editorMigrationPublishers(plan))) {
			throw new Error('Apply authorization does not match the reviewed plan');
		}
		const consumedAt = this.now();
		if (consumedAt - pending.issuedAt > 10 * 60 * 1_000) {
			this.pending.delete(authorization.nonce);
			throw new Error('Apply authorization has expired');
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

/** Recomputes and verifies the canonical aggregate fingerprint of a reviewed plan. */
export async function verifiedEditorMigrationPlanFingerprint(plan: EditorMigrationReviewedPlan): Promise<string> {
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
		throw new Error('Reviewed migration plan fingerprint is stale or corrupt');
	}
	return actual;
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
}

/** Public desktop Apply coordinator. */
export const IEditorMigrationApplyService = createDecorator<IEditorMigrationApplyService>('editorMigrationApplyService');

/** Executes, recovers, and cleans up durable editor migration operations. */
export interface IEditorMigrationApplyService {
	readonly _serviceBrand: undefined;
	createApplyAuthorization(plan: EditorMigrationReviewedPlan, confirmedPublishers: readonly string[]): Promise<EditorMigrationApplyAuthorization>;
	apply(plan: EditorMigrationReviewedPlan, authorization: EditorMigrationApplyAuthorization, token: CancellationToken): Promise<EditorMigrationOperationResult>;
	getOperation(operationId: string): Promise<EditorMigrationOperation>;
	listRecoverableOperations(): Promise<readonly EditorMigrationOperationSummary[]>;
	resume(operationId: string, token: CancellationToken): Promise<EditorMigrationOperationResult>;
	retry(operationId: string, token: CancellationToken): Promise<EditorMigrationOperationResult>;
	rollback(operationId: string, options: EditorMigrationRollbackOptions, token: CancellationToken): Promise<EditorMigrationOperationResult>;
	acknowledge(operationId: string): Promise<void>;
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

/** Builds the intentionally closed telemetry payload. */
export function toEditorMigrationTelemetry(input: EditorMigrationTelemetryInput): unknown {
	const outcomeCounts: Partial<Record<EditorMigrationItemOutcome, number>> = {};
	for (const outcome of input.outcomes) {
		outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
	}
	return Object.freeze({
		operationSchemaVersion: input.operationSchemaVersion,
		planningSchemaVersion: input.planningSchemaVersion,
		aggregateOutcome: input.aggregateOutcome,
		phase: input.phase,
		outcomeCounts,
		durationBucket: input.durationMs < 60_000 ? 'underMinute' : input.durationMs < 5 * 60_000 ? 'underFiveMinutes' : 'fiveMinutesOrMore',
	});
}

function canonicalPublishers(publishers: readonly string[]): readonly string[] {
	return [...new Set(publishers.map(publisher => publisher.trim().toLowerCase()).filter(Boolean))].sort();
}

function publisherFromExtensionId(id: string): string {
	const separator = id.indexOf('.');
	if (separator <= 0) {
		throw new Error(`Extension '${id}' has no publisher`);
	}
	return id.slice(0, separator);
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatting(contents: string): { readonly tabSize: number; readonly insertSpaces: boolean; readonly eol: string } {
	const eol = contents.includes('\r\n') ? '\r\n' : '\n';
	const indentation = /(?:^|\r?\n)([ \t]+)["{/]/.exec(contents)?.[1] ?? '\t';
	return { tabSize: indentation[0] === '\t' ? 4 : indentation.length, insertSpaces: indentation[0] !== '\t', eol };
}

function isJsonObject(value: unknown): value is Readonly<Record<string, import('./editorMigrationSource.js').EditorMigrationJsonValue>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
