/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { EditorMigrationCategory, EditorMigrationExtension, EditorMigrationJsonValue, EditorMigrationResourceState, EditorMigrationSnippet, EditorMigrationSourceSnapshot } from './editorMigrationSource.js';

/** Version of reviewed editor migration plans. */
export const EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION = 2;

/** Version of Hucode's planning and exclusion policy. */
export const EDITOR_MIGRATION_POLICY_VERSION = 2;

/** Explicit target selected by a migration caller. */
export type EditorMigrationTargetSelection =
	| { readonly kind: 'existing'; readonly profileId: string }
	| {
		readonly kind: 'proposed';
		readonly name: string;
		readonly options?: {
			readonly icon?: string;
			readonly useDefaultFlags?: Readonly<Partial<Record<EditorMigrationCategory, boolean>>>;
		};
	};

/** Stable error code for input rejected before planning. */
export type EditorMigrationPlanningErrorCode =
	| 'invalidTarget'
	| 'targetNotFound'
	| 'ineligibleTarget'
	| 'proposedNameUnavailable'
	| 'selectedCategoryInheritedByProposedTarget'
	| 'resourceUnavailable'
	| 'invalidExtensionManifest'
	| 'galleryUnavailable'
	| 'invalidChoices'
	| 'nonCanonicalInput';

/** An expected local planning failure with a machine-readable code. */
export class EditorMigrationPlanningError extends Error {
	constructor(readonly code: EditorMigrationPlanningErrorCode, message: string) {
		super(message);
		this.name = 'EditorMigrationPlanningError';
	}
}

/** Environment whose compatibility and policy affect a plan. */
export interface EditorMigrationTargetEnvironment {
	readonly targetPlatform: string;
	readonly productVersion: string;
	readonly productDate?: string;
	readonly hucodeVersion: string;
	readonly galleryIdentity: string;
	readonly policyVersion: typeof EDITOR_MIGRATION_POLICY_VERSION;
}

/** Normalized extension membership read directly from profile manifests. */
export interface EditorMigrationTargetExtension extends EditorMigrationExtension {
	readonly applicationScoped: boolean;
}

/** Ownership and exact parsed state of one target category. */
export type EditorMigrationTargetCategorySnapshot =
	| EditorMigrationTargetCategoryBase<'settings', Readonly<Record<string, EditorMigrationJsonValue>>>
	| EditorMigrationTargetCategoryBase<'keybindings', readonly Readonly<Record<string, EditorMigrationJsonValue>>[]>
	| EditorMigrationTargetCategoryBase<'snippets', readonly EditorMigrationSnippet[]>
	| EditorMigrationTargetCategoryBase<'extensions', readonly EditorMigrationTargetExtension[]>;

interface EditorMigrationTargetCategoryBase<TCategory extends EditorMigrationCategory, TValue> {
	readonly category: TCategory;
	readonly ownership: 'target' | 'default';
	readonly ownerProfileId?: string;
	readonly state: EditorMigrationResourceState;
	readonly contentHash?: string;
	readonly semanticHash?: string;
	readonly value?: TValue;
}

/** Built-in identity obtained only through the system scanner. */
export interface EditorMigrationBuiltInExtension {
	readonly id: string;
	readonly uuid?: string;
	readonly version: string;
}

/** Exact read-only target evidence used by the pure planner. */
export interface EditorMigrationTargetSnapshot {
	readonly schemaVersion: typeof EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION;
	readonly selection: EditorMigrationTargetSelection;
	readonly profile?: {
		readonly id: string;
		readonly name: string;
		readonly kind: 'default' | 'named';
	};
	readonly eligible: boolean;
	readonly nameAvailable?: boolean;
	readonly catalogFingerprint: string;
	readonly requestedCategories: readonly EditorMigrationCategory[];
	readonly categories: readonly EditorMigrationTargetCategorySnapshot[];
	readonly environment: EditorMigrationTargetEnvironment;
	readonly builtIns: readonly EditorMigrationBuiltInExtension[];
	readonly fingerprint: string;
}

/** Controlled result of the gallery's existence and compatibility phases. */
export type EditorMigrationGalleryResult =
	| {
		readonly id: string;
		readonly requestedChannel: 'stable' | 'preRelease';
		readonly status: 'available';
		readonly uuid?: string;
		readonly version: string;
		readonly targetPlatform: string;
		readonly selectedChannel: 'stable' | 'preRelease';
		readonly engine: string;
		readonly galleryIdentity: string;
	}
	| {
		readonly id: string;
		readonly requestedChannel: 'stable' | 'preRelease';
		readonly status: 'incompatible' | 'unavailable';
	};

/** Registry, keybinding, and gallery evidence gathered outside pure planning. */
export interface EditorMigrationPlanningEvidence {
	readonly registryIgnoredSettings: readonly string[];
	readonly normalizedKeys: Readonly<Record<string, string>>;
	readonly keybindingPlatform: string;
	readonly gallery: readonly EditorMigrationGalleryResult[];
}

/** Why a source item will not become an accepted operation. */
export type EditorMigrationExclusionReason =
	| 'machineSpecific'
	| 'accountOrAuthentication'
	| 'telemetryIdentity'
	| 'updateChannel'
	| 'remoteAuthority'
	| 'applicationPath'
	| 'sourceProductIntegration'
	| 'registryIgnored'
	| 'builtIn'
	| 'alreadyInstalled'
	| 'galleryUnavailable'
	| 'galleryIncompatible';

/** User-reviewable decision in a draft. */
export interface EditorMigrationDraftDecision {
	readonly id: string;
	readonly category: EditorMigrationCategory;
	readonly item: string;
	readonly kind: 'add' | 'conflict';
	readonly defaultChoice: 'import' | 'preserveTarget';
	readonly source: EditorMigrationJsonValue;
	readonly target?: EditorMigrationJsonValue;
	readonly relatedTargetIds?: readonly string[];
}

/** Excluded or already satisfied source item. */
export interface EditorMigrationDraftExclusion {
	readonly category: 'settings' | 'extensions';
	readonly item: string;
	readonly reason: EditorMigrationExclusionReason;
}

/** Apply prerequisite produced for an inherited selected category. */
export interface EditorMigrationMaterializationPrerequisite {
	readonly kind: 'materializeInheritedResource';
	readonly category: EditorMigrationCategory;
	readonly ownerProfileId: string;
	readonly baselineFingerprint: string;
}

/** Warning shown by the future Review UI. */
export interface EditorMigrationPlanWarning {
	readonly code: 'defaultProfileBacksOmni' | 'preReleaseFellBackToStable' | 'unknownSettingSchema' | 'unavailableThemeExtension';
	readonly item?: string;
}

/** Pure, stable review draft before user choices are accepted. */
export interface EditorMigrationPlanDraft {
	readonly schemaVersion: typeof EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION;
	readonly source: EditorMigrationSourceSnapshot;
	readonly target: EditorMigrationTargetSnapshot;
	readonly evidence: EditorMigrationPlanningEvidence;
	readonly decisions: readonly EditorMigrationDraftDecision[];
	readonly exclusions: readonly EditorMigrationDraftExclusion[];
	readonly prerequisites: readonly EditorMigrationMaterializationPrerequisite[];
	readonly warnings: readonly EditorMigrationPlanWarning[];
	readonly draftFingerprintSeed: string;
}

/** Choices owned by the caller, referring only to stable draft IDs. */
export interface EditorMigrationPlanChoices {
	readonly selectedCategories: readonly EditorMigrationCategory[];
	readonly decisions: readonly {
		readonly id: string;
		readonly choice: 'import' | 'preserveTarget';
	}[];
}

/** One accepted, kind-specific operation handed to Apply. */
export type EditorMigrationPlanOperation =
	| EditorMigrationSetSettingOperation
	| EditorMigrationKeybindingOperation
	| EditorMigrationSnippetOperation
	| EditorMigrationInstallExtensionOperation;

/** A reviewed setting assignment. */
export interface EditorMigrationSetSettingOperation {
	readonly id: string;
	readonly category: 'settings';
	readonly kind: 'setSetting';
	readonly item: string;
	readonly source: EditorMigrationJsonValue;
}

/** A reviewed keybinding addition or exact indexed replacement. */
export interface EditorMigrationKeybindingOperation {
	readonly id: string;
	readonly category: 'keybindings';
	readonly kind: 'addKeybinding' | 'replaceKeybinding';
	readonly item: string;
	readonly source: Readonly<Record<string, EditorMigrationJsonValue>>;
	readonly relatedTargetIds: readonly string[];
}

/** A reviewed snippet addition or replacement. */
export interface EditorMigrationSnippetOperation {
	readonly id: string;
	readonly category: 'snippets';
	readonly kind: 'addSnippet' | 'replaceSnippet';
	readonly item: string;
	readonly source: EditorMigrationSnippet;
}

/** A reviewed exact extension gallery coordinate. */
export interface EditorMigrationInstallExtensionOperation {
	readonly id: string;
	readonly category: 'extensions';
	readonly kind: 'installExtension';
	readonly item: string;
	readonly source: Extract<EditorMigrationGalleryResult, { readonly status: 'available' }>;
}

/** Deeply immutable reviewed plan handed to Apply admission. */
export interface EditorMigrationReviewedPlan {
	readonly schemaVersion: typeof EDITOR_MIGRATION_PLANNING_SCHEMA_VERSION;
	readonly source: EditorMigrationSourceSnapshot;
	readonly target: EditorMigrationTargetSnapshot;
	readonly evidence: EditorMigrationPlanningEvidence;
	readonly choices: EditorMigrationPlanChoices;
	readonly operations: readonly EditorMigrationPlanOperation[];
	readonly exclusions: readonly EditorMigrationDraftExclusion[];
	readonly prerequisites: readonly EditorMigrationMaterializationPrerequisite[];
	readonly warnings: readonly EditorMigrationPlanWarning[];
	readonly fingerprints: {
		readonly source: string;
		readonly target: string;
		readonly choices: string;
		readonly policy: string;
		readonly gallery: string;
		readonly plan: string;
	};
}

/** Stable reason that a reviewed plan no longer describes current inputs. */
export type EditorMigrationPlanDriftReason =
	| 'sourceChanged'
	| 'sourceUnavailable'
	| 'targetContentChanged'
	| 'targetOwnershipChanged'
	| 'profileCatalogChanged'
	| 'proposedNameChanged'
	| 'policyChanged'
	| 'choicesChanged'
	| 'galleryChanged'
	| 'environmentChanged';

/** Read-only result of checking a reviewed plan before Apply admission. */
export interface EditorMigrationPlanVerification {
	readonly status: 'unchanged' | 'changed' | 'unavailable';
	readonly reasons: readonly EditorMigrationPlanDriftReason[];
}

/** Public planning coordinator consumed by later migration flows. */
export const IEditorMigrationPlanningService = createDecorator<IEditorMigrationPlanningService>('editorMigrationPlanningService');

/** Read-only editor migration planning service. */
export interface IEditorMigrationPlanningService {
	readonly _serviceBrand: undefined;

	inspectTarget(target: EditorMigrationTargetSelection, categories: readonly EditorMigrationCategory[], token: CancellationToken): Promise<EditorMigrationTargetSnapshot>;
	createDraft(source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot, evidence: EditorMigrationPlanningEvidence): EditorMigrationPlanDraft;
	createDraftFromCurrentEvidence(source: EditorMigrationSourceSnapshot, target: EditorMigrationTargetSnapshot, token: CancellationToken): Promise<EditorMigrationPlanDraft>;
	acceptDraft(draft: EditorMigrationPlanDraft, choices: EditorMigrationPlanChoices): Promise<EditorMigrationReviewedPlan>;
	verifyPlan(plan: EditorMigrationReviewedPlan, token: CancellationToken): Promise<EditorMigrationPlanVerification>;
}
