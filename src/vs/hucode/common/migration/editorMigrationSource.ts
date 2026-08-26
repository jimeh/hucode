/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';

/** Version of the editor migration source DTO contract. */
export const EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION = 1;

/** IPC channel used by desktop renderers for read-only editor discovery. */
export const EDITOR_MIGRATION_SOURCE_CHANNEL_NAME = 'hucodeEditorMigrationSource';

/** Editor products supported by automatic source discovery. */
export type EditorMigrationAdapterId = 'vscode' | 'vscode-insiders' | 'cursor';

/** Importable resource categories exposed by source discovery. */
export type EditorMigrationCategory = 'settings' | 'keybindings' | 'snippets' | 'extensions';

/** Stable diagnostic codes returned across the desktop IPC boundary. */
export type EditorMigrationDiagnosticCode =
	| 'candidateAbsent'
	| 'permissionDeniedOrLocked'
	| 'malformedKnownResource'
	| 'unsupportedNamedProfileCatalogSchema'
	| 'sourceChangedDuringRead'
	| 'oversizedResource'
	| 'duplicateAlias'
	| 'canceledOperation';

/** Local details that must never be copied into telemetry. */
export interface EditorMigrationDiagnosticDetails {
	readonly path?: string;
	readonly entry?: string;
	readonly limit?: number;
}
/** Structured source diagnostic. */
export interface EditorMigrationDiagnostic {
	readonly code: EditorMigrationDiagnosticCode;
	readonly severity: 'info' | 'warning' | 'error';
	readonly scope: 'candidate' | 'catalog' | 'profile' | 'resource';
	readonly adapterId: EditorMigrationAdapterId;
	readonly profileId?: string;
	readonly category?: EditorMigrationCategory;
	readonly details?: EditorMigrationDiagnosticDetails;
}

/** Opaque reference valid only for the current source-service generation. */
export interface EditorMigrationSourceProfileRef {
	readonly value: string;
}

/** Identity of a supported editor source adapter. */
export interface EditorMigrationSourceAdapterIdentity {
	readonly id: EditorMigrationAdapterId;
	readonly productName: string;
	readonly channel: 'stable' | 'insiders';
	readonly order: number;
}

/** Source profile identity shown by a future source picker. */
export interface EditorMigrationSourceProfileIdentity {
	readonly id: string;
	readonly name: string;
	readonly kind: 'default' | 'named';
	readonly icon?: string;
}

/** Summary of one available category without its private contents. */
export interface EditorMigrationCategorySummary {
	readonly category: EditorMigrationCategory;
	readonly state: EditorMigrationResourceState;
	readonly itemCount: number;
}

/** Deterministic ranking evidence for a source descriptor. */
export interface EditorMigrationSourceRanking {
	readonly completeness: number;
	readonly newestModificationTime: number;
	readonly stableChannelPreference: number;
	readonly adapterOrder: number;
	readonly normalizedProfileName: string;
	readonly canonicalReference: string;
}

/** Source descriptor returned by discovery. */
export interface EditorMigrationSourceDescriptor {
	readonly schemaVersion: typeof EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION;
	readonly ref: EditorMigrationSourceProfileRef;
	readonly adapter: EditorMigrationSourceAdapterIdentity;
	readonly profile: EditorMigrationSourceProfileIdentity;
	readonly localPaths: {
		readonly userData: string;
		readonly extensions: string;
	};
	readonly categories: readonly EditorMigrationCategorySummary[];
	readonly diagnostics: readonly EditorMigrationDiagnostic[];
	readonly ranking: EditorMigrationSourceRanking;
	readonly discoveryFingerprint: EditorMigrationSourceFingerprint;
}

/** Options for automatic desktop source discovery. */
export interface EditorMigrationDiscoveryOptions {
	readonly includeAbsentCandidateDiagnostics?: boolean;
}

/** Complete deterministic result from one discovery generation. */
export interface EditorMigrationDiscoveryResult {
	readonly schemaVersion: typeof EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION;
	readonly generation: number;
	readonly sources: readonly EditorMigrationSourceDescriptor[];
	readonly diagnostics: readonly EditorMigrationDiagnostic[];
}

/** JSON values accepted from settings, keybindings, and snippets. */
export type EditorMigrationJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly EditorMigrationJsonValue[]
	| { readonly [key: string]: EditorMigrationJsonValue };

/** Normalized installed-extension record. */
export interface EditorMigrationExtension {
	readonly id: string;
	readonly uuid?: string;
	readonly version: string;
	readonly preRelease?: boolean;
	readonly hasPreReleaseVersion?: boolean;
}

/** Normalized snippet file. */
export interface EditorMigrationSnippet {
	readonly name: string;
	readonly contents: EditorMigrationJsonValue;
	readonly contentHash: string;
}

/** Read state of one logical source resource. */
export type EditorMigrationResourceState = 'present' | 'absent' | 'unreadable';

/** Fingerprint entry for one exact parsed input. */
export interface EditorMigrationSourceFingerprintEntry {
	readonly category: EditorMigrationCategory | 'profileCatalog';
	readonly identityDigest: string;
	readonly state: EditorMigrationResourceState;
	readonly contentHash?: string;
}

/** Versioned fingerprint of the exact bytes parsed for a source snapshot. */
export interface EditorMigrationSourceFingerprint {
	readonly schemaVersion: typeof EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION;
	readonly algorithm: 'sha256';
	readonly categories: readonly EditorMigrationCategory[];
	readonly entries: readonly EditorMigrationSourceFingerprintEntry[];
	readonly value: string;
}

/** One normalized category in a source snapshot. */
export type EditorMigrationCategorySnapshot =
	| {
		readonly category: 'settings';
		readonly state: EditorMigrationResourceState;
		readonly value?: Readonly<Record<string, EditorMigrationJsonValue>>;
	}
	| {
		readonly category: 'keybindings';
		readonly state: EditorMigrationResourceState;
		readonly value?: readonly Readonly<Record<string, EditorMigrationJsonValue>>[];
	}
	| {
		readonly category: 'snippets';
		readonly state: EditorMigrationResourceState;
		readonly value?: readonly EditorMigrationSnippet[];
	}
	| {
		readonly category: 'extensions';
		readonly state: EditorMigrationResourceState;
		readonly value?: readonly EditorMigrationExtension[];
	};

/** Normalized source contents read for selected categories. */
export interface EditorMigrationSourceSnapshot {
	readonly schemaVersion: typeof EDITOR_MIGRATION_SOURCE_SCHEMA_VERSION;
	readonly ref: EditorMigrationSourceProfileRef;
	readonly adapter: EditorMigrationSourceAdapterIdentity;
	readonly profile: EditorMigrationSourceProfileIdentity;
	readonly categories: readonly EditorMigrationCategorySnapshot[];
	readonly diagnostics: readonly EditorMigrationDiagnostic[];
	readonly fingerprint: EditorMigrationSourceFingerprint;
}

/** Result of verifying a prior source fingerprint. */
export interface EditorMigrationSourceVerification {
	readonly status: 'unchanged' | 'changed' | 'unavailable';
	readonly currentFingerprint?: EditorMigrationSourceFingerprint;
	readonly diagnostics: readonly EditorMigrationDiagnostic[];
}

/** Desktop-only read service for migration sources. */
export const IEditorMigrationSourceService = createDecorator<IEditorMigrationSourceService>('editorMigrationSourceService');

/** Read-only source-discovery service consumed by later migration flows. */
export interface IEditorMigrationSourceService {
	readonly _serviceBrand: undefined;

	discoverSources(options: EditorMigrationDiscoveryOptions, token: CancellationToken): Promise<EditorMigrationDiscoveryResult>;
	readSourceProfile(ref: EditorMigrationSourceProfileRef, categories: readonly EditorMigrationCategory[], token: CancellationToken): Promise<EditorMigrationSourceSnapshot>;
	verifySourceSnapshot(ref: EditorMigrationSourceProfileRef, fingerprint: EditorMigrationSourceFingerprint, token: CancellationToken): Promise<EditorMigrationSourceVerification>;
}
