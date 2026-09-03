/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Canonical wire protocol between the Hucode setup webview host and its renderer.
 *
 * This module is dependency-free on purpose. `build/hucode/setup-ui-protocol.ts` copies it
 * byte-for-byte into `extensions/hucode-setup-ui/src/generated/`, so both sides compile the same
 * types and the same runtime validators. Anything imported here would have to exist in the
 * extension too, which it does not.
 */

/** Bumped whenever a message shape changes. Both sides reject any other value. */
export const EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION = 1;

/** The four import categories, repeated here so the protocol stays dependency-free. */
export const EDITOR_MIGRATION_SETUP_CATEGORIES = ['settings', 'keybindings', 'snippets', 'extensions'] as const;

export type EditorMigrationSetupCategory = (typeof EDITOR_MIGRATION_SETUP_CATEGORIES)[number];

/** File categories rollback can restore. Extensions stay installed. */
export const EDITOR_MIGRATION_SETUP_FILE_CATEGORIES = ['settings', 'keybindings', 'snippets'] as const;

export type EditorMigrationSetupFileCategory = (typeof EDITOR_MIGRATION_SETUP_FILE_CATEGORIES)[number];

export type EditorMigrationSetupPhase =
	| 'loading'
	| 'recovery'
	| 'application'
	| 'profile'
	| 'target'
	| 'review'
	| 'publishers'
	| 'apply'
	| 'results';

export type EditorMigrationSetupSectionStatus = 'attention' | 'ok' | 'neutral';

export type EditorMigrationSetupDecisionChoice = 'import' | 'preserveTarget';

// #region renderer to host

/**
 * Closed set of renderer intents.
 *
 * Every variant except `ready` and `close` maps one-for-one onto a public user-action method of
 * `EditorMigrationFlowSession`. `editorMigrationSetupProtocol.test.ts` fails when one side gains
 * an action without the other.
 */
export type EditorMigrationSetupIntent =
	| { readonly type: 'ready' }
	| { readonly type: 'close' }
	| { readonly type: 'startImport' }
	| { readonly type: 'refreshDiscovery' }
	| { readonly type: 'selectApplication'; readonly applicationId: string }
	| { readonly type: 'selectSourceProfile'; readonly sourceRef: string }
	| { readonly type: 'continueFromProfile' }
	| { readonly type: 'selectTarget'; readonly target: EditorMigrationSetupTargetIntent }
	| { readonly type: 'continueFromTarget' }
	| { readonly type: 'rebuildReview' }
	| { readonly type: 'toggleCategory'; readonly category: EditorMigrationSetupCategory; readonly selected: boolean }
	| { readonly type: 'chooseDecision'; readonly decisionId: string; readonly choice: EditorMigrationSetupDecisionChoice }
	| { readonly type: 'chooseAllSettingDifferences'; readonly choice: EditorMigrationSetupDecisionChoice }
	| { readonly type: 'acceptReview' }
	| { readonly type: 'confirmPublishers' }
	| { readonly type: 'requestCancellation' }
	| { readonly type: 'showRecovery'; readonly operationId: string }
	| { readonly type: 'resume'; readonly operationId: string }
	| { readonly type: 'retry'; readonly operationId: string }
	| { readonly type: 'inspectRollback'; readonly categories: readonly EditorMigrationSetupFileCategory[] }
	| { readonly type: 'clearRollbackInspection' }
	| { readonly type: 'rollback'; readonly categories: readonly EditorMigrationSetupFileCategory[]; readonly forceCategories: readonly EditorMigrationSetupFileCategory[] }
	| { readonly type: 'copyReport' }
	| { readonly type: 'acknowledge' }
	| { readonly type: 'back' };

/** Target selection reduced to what the renderer may express: an offered profile, or a new name. */
export type EditorMigrationSetupTargetIntent =
	| { readonly kind: 'existing'; readonly profileId: string }
	| { readonly kind: 'proposed'; readonly name: string };

export type EditorMigrationSetupIntentType = EditorMigrationSetupIntent['type'];

/**
 * Intents that name something from a specific snapshot. They are refused when the revision they
 * were formed against is no longer current, so a click landing after a state change cannot resolve
 * against a different list.
 */
export const EDITOR_MIGRATION_SETUP_REVISION_BOUND_INTENTS: readonly EditorMigrationSetupIntentType[] = [
	'selectApplication',
	'selectSourceProfile',
	'selectTarget',
	'toggleCategory',
	'chooseDecision',
	'showRecovery',
	'resume',
	'retry',
	'inspectRollback',
	'rollback',
];

/** Envelope the renderer posts. `revision` is the snapshot the user was looking at. */
export interface EditorMigrationSetupIntentMessage {
	readonly protocolVersion: typeof EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION;
	readonly revision: number;
	readonly intent: EditorMigrationSetupIntent;
}

// #endregion

// #region host to renderer

export type EditorMigrationSetupHostMessage =
	| { readonly protocolVersion: typeof EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION; readonly type: 'state'; readonly revision: number; readonly presentation: EditorMigrationSetupPresentation }
	| { readonly protocolVersion: typeof EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION; readonly type: 'accepted'; readonly revision: number; readonly intentType: EditorMigrationSetupIntentType }
	| { readonly protocolVersion: typeof EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION; readonly type: 'error'; readonly revision: number; readonly message: string }
	| { readonly protocolVersion: typeof EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION; readonly type: 'focus'; readonly revision: number; readonly focusId: string }
	| { readonly protocolVersion: typeof EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION; readonly type: 'disposed' };

// #endregion

// #region presentation

/** One action the renderer renders and posts back verbatim. */
export interface EditorMigrationSetupAction {
	readonly id: string;
	readonly label: string;
	readonly kind: 'default' | 'primary' | 'danger';
	readonly disabled: boolean;
	readonly intent: EditorMigrationSetupIntent;
}

/** One navigable row of the compact section rail. */
export interface EditorMigrationSetupSection {
	readonly id: string;
	readonly label: string;
	readonly status: EditorMigrationSetupSectionStatus;
	readonly count?: number;
	readonly separated?: boolean;
	/** Spoken description of the state marker, so no meaning depends on the glyph alone. */
	readonly statusDescription: string;
}

/** Names behind an aggregate, already truncated by core so no disclosure becomes a scroll region. */
export interface EditorMigrationSetupDisclosure {
	readonly id: string;
	readonly summary: string;
	readonly note?: string;
	readonly items: readonly string[];
	readonly remainingText?: string;
}

/** One aggregated cause: stated once, counted, with its names on request. */
export interface EditorMigrationSetupGroup {
	readonly id: string;
	readonly title: string;
	readonly count: number;
	readonly countDescription: string;
	readonly disclosure?: EditorMigrationSetupDisclosure;
}

export interface EditorMigrationSetupChoiceCard {
	readonly id: string;
	readonly title: string;
	readonly detail: string;
	readonly intent: EditorMigrationSetupIntent;
}

export interface EditorMigrationSetupRadioOption {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly checked: boolean;
	readonly intent: EditorMigrationSetupIntent;
}

export interface EditorMigrationSetupRecoveryRecord {
	readonly id: string;
	readonly title: string;
	readonly detail: string;
	readonly action?: EditorMigrationSetupAction;
}

export interface EditorMigrationSetupConflictRow {
	readonly id: string;
	readonly name: string;
	readonly searchText: string;
	readonly currentValue: string;
	readonly importedValue: string;
	readonly valuesDescription: string;
	/** Present while review is editable; absent once publisher confirmation freezes the choices. */
	readonly choices?: readonly EditorMigrationSetupRadioOption[];
	/** Present instead of `choices` in the read-only presentation. */
	readonly chosenText?: string;
}

export interface EditorMigrationSetupProblemRow {
	readonly id: string;
	readonly text: string;
	readonly detail?: string;
	readonly outcome: string;
}

export interface EditorMigrationSetupProgressBar {
	readonly text: string;
	readonly min: number;
	readonly max: number;
	readonly now: number;
}

export interface EditorMigrationSetupProgressRow {
	readonly id: string;
	readonly label: string;
	readonly state: string;
}

/** One detail view. Exactly one panel per section, or one unnamed panel for the plain phases. */
export type EditorMigrationSetupPanel =
	| { readonly kind: 'loading'; readonly id: string; readonly heading: string; readonly progress: EditorMigrationSetupProgressBar }
	| {
		readonly kind: 'recovery'; readonly id: string; readonly heading: string; readonly lead: string;
		readonly filterLabel: string; readonly listLabel: string; readonly emptyText: string;
		readonly records: readonly EditorMigrationSetupRecoveryRecord[];
	}
	| {
		readonly kind: 'applications'; readonly id: string; readonly heading: string; readonly lead: string;
		readonly filterLabel: string; readonly listLabel: string; readonly emptyText: string; readonly noMatchText: string;
		readonly applications: readonly EditorMigrationSetupChoiceCard[];
		readonly diagnostics?: EditorMigrationSetupDisclosure;
	}
	| {
		readonly kind: 'profiles'; readonly id: string; readonly heading: string;
		readonly filterLabel: string; readonly groupLabel: string; readonly noMatchText: string;
		readonly profiles: readonly EditorMigrationSetupRadioOption[];
		readonly details?: EditorMigrationSetupDisclosure;
	}
	| {
		readonly kind: 'target'; readonly id: string; readonly heading: string; readonly lead: string;
		readonly groupLabel: string; readonly targets: readonly EditorMigrationSetupRadioOption[];
		readonly newTarget: {
			readonly label: string; readonly placeholder: string; readonly actionLabel: string;
			readonly value: string; readonly selectedText?: string;
		};
	}
	| {
		readonly kind: 'reviewCategory'; readonly id: string; readonly heading: string; readonly lead: string;
		readonly include?: { readonly label: string; readonly checked: boolean; readonly category: EditorMigrationSetupCategory };
		readonly ownership: string;
		readonly excludedText?: string;
		readonly differencesHeading?: string;
		readonly bulkActions?: readonly EditorMigrationSetupAction[];
		readonly conflictFilterLabel?: string;
		readonly conflicts: readonly EditorMigrationSetupConflictRow[];
		readonly conflictOverflowTemplate?: string;
		readonly notesHeading?: string;
		readonly warnings: readonly EditorMigrationSetupGroup[];
		readonly additions?: EditorMigrationSetupDisclosure;
		readonly exclusionNote?: string;
		readonly emptyText?: string;
	}
	| {
		readonly kind: 'groups'; readonly id: string; readonly heading: string; readonly lead: string;
		readonly groups: readonly EditorMigrationSetupGroup[]; readonly emptyText?: string;
	}
	| {
		readonly kind: 'applyOverview'; readonly id: string; readonly heading: string;
		readonly progress: EditorMigrationSetupProgressBar;
		readonly rows: readonly EditorMigrationSetupProgressRow[];
		readonly currentItem?: string; readonly note: string;
	}
	| {
		readonly kind: 'applyCategory'; readonly id: string; readonly heading: string; readonly lead: string;
		readonly problems: readonly EditorMigrationSetupProblemRow[]; readonly problemOverflowText?: string;
		readonly recordedNote?: string;
	}
	| {
		readonly kind: 'resultsOverview'; readonly id: string; readonly heading: string;
		readonly outcome: string; readonly lead: string;
		readonly placementsHeading?: string; readonly placements: readonly EditorMigrationSetupGroup[];
		readonly preserved?: EditorMigrationSetupDisclosure;
		readonly rollbackOutcome?: { readonly heading: string; readonly rows: readonly string[]; readonly note: string };
	}
	| {
		readonly kind: 'resultsCategory'; readonly id: string; readonly heading: string; readonly lead: string;
		readonly problemsHeading?: string;
		readonly problems: readonly EditorMigrationSetupProblemRow[]; readonly problemOverflowText?: string;
		readonly completed?: EditorMigrationSetupDisclosure; readonly emptyText?: string;
	}
	| {
		readonly kind: 'restore'; readonly id: string; readonly heading: string;
		readonly lead?: string; readonly placeholder?: string;
		readonly selection?: {
			readonly legend: string;
			readonly options: readonly { readonly category: EditorMigrationSetupFileCategory; readonly label: string }[];
			readonly inspectLabel: string;
		};
		readonly inspection?: {
			readonly heading?: string;
			readonly description: string;
			readonly actionLabel: string;
			readonly forced: boolean;
			readonly driftedCategories: readonly EditorMigrationSetupFileCategory[];
		};
	}
	| { readonly kind: 'message'; readonly id: string; readonly heading: string; readonly lead?: string };

export interface EditorMigrationSetupFooter {
	readonly lines: readonly string[];
	readonly actions: readonly EditorMigrationSetupAction[];
}

/** Immutable, fully localized snapshot of everything the renderer draws. */
export interface EditorMigrationSetupPresentation {
	readonly revision: number;
	readonly phase: EditorMigrationSetupPhase;
	readonly regionLabel: string;
	readonly title: string;
	readonly steps: readonly { readonly id: string; readonly label: string; readonly current: boolean }[];
	readonly busy: boolean;
	readonly canceling: boolean;
	readonly error?: string;
	readonly announcement?: string;
	readonly railLabel?: string;
	readonly railTitle?: string;
	readonly sections: readonly EditorMigrationSetupSection[];
	readonly defaultSectionId?: string;
	/**
	 * Identity of what the presentation describes. A change discards renderer-local section,
	 * filter, scroll, and disclosure state; an unchanged value preserves it across snapshots.
	 */
	readonly scopeKey: string;
	readonly panels: readonly EditorMigrationSetupPanel[];
	readonly footer: EditorMigrationSetupFooter;
	/** Announced when the user moves the rail, with `{0}` replaced by the section label. */
	readonly sectionAnnouncementTemplate: string;
}

// #endregion

// #region runtime validation

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCategory(value: unknown): value is EditorMigrationSetupCategory {
	return typeof value === 'string' && (EDITOR_MIGRATION_SETUP_CATEGORIES as readonly string[]).includes(value);
}

function isFileCategory(value: unknown): value is EditorMigrationSetupFileCategory {
	return typeof value === 'string' && (EDITOR_MIGRATION_SETUP_FILE_CATEGORIES as readonly string[]).includes(value);
}

function isFileCategoryList(value: unknown): value is readonly EditorMigrationSetupFileCategory[] {
	return Array.isArray(value) && value.every(isFileCategory);
}

function isChoice(value: unknown): value is EditorMigrationSetupDecisionChoice {
	return value === 'import' || value === 'preserveTarget';
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/** Parses one renderer intent. Returns `undefined` for anything outside the closed union. */
export function parseEditorMigrationSetupIntent(value: unknown): EditorMigrationSetupIntent | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	switch (value.type) {
		case 'ready':
		case 'close':
		case 'startImport':
		case 'refreshDiscovery':
		case 'continueFromProfile':
		case 'continueFromTarget':
		case 'rebuildReview':
		case 'acceptReview':
		case 'confirmPublishers':
		case 'requestCancellation':
		case 'clearRollbackInspection':
		case 'copyReport':
		case 'acknowledge':
		case 'back':
			return { type: value.type };
		case 'selectApplication':
			return isNonEmptyString(value.applicationId) ? { type: 'selectApplication', applicationId: value.applicationId } : undefined;
		case 'selectSourceProfile':
			return isNonEmptyString(value.sourceRef) ? { type: 'selectSourceProfile', sourceRef: value.sourceRef } : undefined;
		case 'selectTarget': {
			const target = value.target;
			if (!isRecord(target)) {
				return undefined;
			}
			if (target.kind === 'existing' && isNonEmptyString(target.profileId)) {
				return { type: 'selectTarget', target: { kind: 'existing', profileId: target.profileId } };
			}
			if (target.kind === 'proposed' && isNonEmptyString(target.name)) {
				return { type: 'selectTarget', target: { kind: 'proposed', name: target.name } };
			}
			return undefined;
		}
		case 'toggleCategory':
			return isCategory(value.category) && typeof value.selected === 'boolean'
				? { type: 'toggleCategory', category: value.category, selected: value.selected }
				: undefined;
		case 'chooseDecision':
			return isNonEmptyString(value.decisionId) && isChoice(value.choice)
				? { type: 'chooseDecision', decisionId: value.decisionId, choice: value.choice }
				: undefined;
		case 'chooseAllSettingDifferences':
			return isChoice(value.choice) ? { type: 'chooseAllSettingDifferences', choice: value.choice } : undefined;
		case 'showRecovery':
		case 'resume':
		case 'retry':
			return isNonEmptyString(value.operationId) ? { type: value.type, operationId: value.operationId } : undefined;
		case 'inspectRollback':
			return isFileCategoryList(value.categories) ? { type: 'inspectRollback', categories: [...value.categories] } : undefined;
		case 'rollback':
			return isFileCategoryList(value.categories) && isFileCategoryList(value.forceCategories)
				? { type: 'rollback', categories: [...value.categories], forceCategories: [...value.forceCategories] }
				: undefined;
		default:
			return undefined;
	}
}

/** Parses one renderer envelope, rejecting unsupported protocol versions and malformed payloads. */
export function parseEditorMigrationSetupIntentMessage(value: unknown): EditorMigrationSetupIntentMessage | undefined {
	if (!isRecord(value) || value.protocolVersion !== EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION) {
		return undefined;
	}
	if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 0) {
		return undefined;
	}
	const intent = parseEditorMigrationSetupIntent(value.intent);
	return intent ? { protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, revision: value.revision, intent } : undefined;
}

/** True when the intent names something from a specific snapshot and must not outlive it. */
export function isEditorMigrationSetupRevisionBound(type: EditorMigrationSetupIntentType): boolean {
	return EDITOR_MIGRATION_SETUP_REVISION_BOUND_INTENTS.includes(type);
}

/** Parses one host message. The renderer refuses anything else, including a foreign version. */
export function parseEditorMigrationSetupHostMessage(value: unknown): EditorMigrationSetupHostMessage | undefined {
	if (!isRecord(value) || value.protocolVersion !== EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION) {
		return undefined;
	}
	switch (value.type) {
		case 'state':
			return typeof value.revision === 'number' && isRecord(value.presentation)
				? value as unknown as EditorMigrationSetupHostMessage
				: undefined;
		case 'accepted':
			return typeof value.revision === 'number' && isNonEmptyString(value.intentType)
				? value as unknown as EditorMigrationSetupHostMessage
				: undefined;
		case 'error':
			return typeof value.revision === 'number' && typeof value.message === 'string'
				? value as unknown as EditorMigrationSetupHostMessage
				: undefined;
		case 'focus':
			return typeof value.revision === 'number' && isNonEmptyString(value.focusId)
				? value as unknown as EditorMigrationSetupHostMessage
				: undefined;
		case 'disposed':
			return { protocolVersion: EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION, type: 'disposed' };
		default:
			return undefined;
	}
}

// #endregion
