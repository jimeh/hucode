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
export const EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION = 2;

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

/**
 * Focus target meaning "the current detail panel's heading".
 *
 * The host asks for it once the renderer has its first snapshot, so opening the modal lands a
 * keyboard user inside the webview rather than on the document body.
 */
export const EDITOR_MIGRATION_SETUP_HEADING_FOCUS_ID = 'panel-heading';

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
	/*
	 * Two identifier-less actions are bound as well, because the phase guard alone cannot protect
	 * what they decide.
	 *
	 * `acceptReview` is the gate into an irreversible apply, and `confirmPublishers` authorizes an
	 * exact publisher list; honouring either against a screen the user is no longer looking at
	 * would approve something they did not see. `back` is bound because the session moves exactly
	 * one phase per press and remains legal in the phase it lands on, so nothing else stops a
	 * double press from skipping two.
	 *
	 * Deliberately not bound: `chooseAllSettingDifferences` and `rebuildReview` read only
	 * authoritative state, are idempotent within a phase, and are already confined to Review — so
	 * binding them would cost the user a refusal without protecting anything.
	 */
	'acceptReview',
	'confirmPublishers',
	'back',
	'showRecovery',
	'resume',
	'retry',
	'inspectRollback',
	'rollback',
];

/** Where one intent may act, and whether a session already working admits it. */
export interface EditorMigrationSetupIntentPolicy {
	readonly phases: readonly EditorMigrationSetupPhase[];
	/** True only for gestures that neither start work nor change what the session is doing. */
	readonly whileBusy: boolean;
}

const ALL_PHASES: readonly EditorMigrationSetupPhase[] = [
	'loading', 'recovery', 'application', 'profile', 'target', 'review', 'publishers', 'apply', 'results',
];

/**
 * Closed admission policy: every renderer intent names the phases it may act in.
 *
 * The table is exhaustive by type, so a new intent cannot default to allowed — adding one without
 * a policy fails to compile. Each entry mirrors the screen that actually offers the control, which
 * is what stops a duplicate click starting a second operation, skipping two phases at once, or
 * racing a recovery deletion.
 */
export const EDITOR_MIGRATION_SETUP_INTENT_POLICY: Readonly<Record<EditorMigrationSetupIntentType, EditorMigrationSetupIntentPolicy>> = {
	// Lifecycle, handled by the host before dispatch. Closing must never be gated.
	ready: { phases: ALL_PHASES, whileBusy: true },
	close: { phases: ALL_PHASES, whileBusy: true },

	// Discovery. Both restart discovery from scratch, so a duplicate would discard the first run.
	startImport: { phases: ['recovery', 'results'], whileBusy: false },
	refreshDiscovery: { phases: ['application'], whileBusy: false },
	selectApplication: { phases: ['application'], whileBusy: false },
	selectSourceProfile: { phases: ['profile'], whileBusy: false },
	continueFromProfile: { phases: ['profile'], whileBusy: false },
	selectTarget: { phases: ['target'], whileBusy: false },
	continueFromTarget: { phases: ['target'], whileBusy: false },

	// Review. The reviewed plan is frozen once publisher confirmation begins.
	rebuildReview: { phases: ['review'], whileBusy: false },
	toggleCategory: { phases: ['review'], whileBusy: false },
	chooseDecision: { phases: ['review'], whileBusy: false },
	chooseAllSettingDifferences: { phases: ['review'], whileBusy: false },
	acceptReview: { phases: ['review'], whileBusy: false },
	confirmPublishers: { phases: ['publishers'], whileBusy: false },

	// Apply. Cancellation is the one thing a working session must always accept.
	requestCancellation: { phases: ['apply'], whileBusy: true },

	// Recovery and results.
	showRecovery: { phases: ['recovery'], whileBusy: false },
	resume: { phases: ['results'], whileBusy: false },
	retry: { phases: ['results'], whileBusy: false },
	inspectRollback: { phases: ['results'], whileBusy: false },
	// Clearing an inspection and copying the report change nothing the session is doing, so they
	// stay usable rather than becoming dead controls whenever anything else is in flight.
	clearRollbackInspection: { phases: ['results'], whileBusy: true },
	copyReport: { phases: ['results'], whileBusy: true },
	rollback: { phases: ['results'], whileBusy: false },
	acknowledge: { phases: ['results'], whileBusy: false },

	/*
	 * Navigation.
	 *
	 * Back is legal while the session is working, because leaving a screen is how the user abandons
	 * the work that screen started: `back()` supersedes the in-flight generation so its result is
	 * discarded on arrival. The presenter leaves the control enabled for exactly that reason.
	 * Revision binding, not the busy flag, is what stops a double press skipping two phases.
	 */
	back: { phases: ['profile', 'target', 'review', 'publishers'], whileBusy: true },
};

/**
 * Whether the authoritative state admits the intent.
 *
 * A refusal here means the user is looking at a screen the session has already left behind, which
 * is a different thing from naming something that never existed.
 */
export function editorMigrationSetupPhaseAdmits(
	type: EditorMigrationSetupIntentType,
	phase: EditorMigrationSetupPhase,
	busy: boolean,
): boolean {
	const policy = EDITOR_MIGRATION_SETUP_INTENT_POLICY[type];
	return policy.phases.includes(phase) && (policy.whileBusy || !busy);
}

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
	/** Labels for readable content comparisons; values contain content, not internal records. */
	readonly comparison?: {
		readonly currentLabel: string;
		readonly importedLabel: string;
		readonly expandLabel: string;
		readonly collapseLabel: string;
		readonly note?: string;
	};
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
		readonly filterLabel: string; readonly listLabel: string; readonly emptyText: string; readonly noMatchText: string;
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

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

/** A count or revision the renderer arithmetic and ARIA attributes depend on. */
function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOptionalCount(value: unknown): boolean {
	return value === undefined || isCount(value);
}

/** Every named key holds a string, and the value is an object at all. */
function hasStrings(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return isRecord(value) && keys.every(key => typeof value[key] === 'string');
}

function isArrayOf(value: unknown, check: (entry: unknown) => boolean): boolean {
	return Array.isArray(value) && value.every(check);
}

function isOptionalArrayOf(value: unknown, check: (entry: unknown) => boolean): boolean {
	return value === undefined || isArrayOf(value, check);
}

const PHASES: readonly string[] = [
	'loading', 'recovery', 'application', 'profile', 'target', 'review', 'publishers', 'apply', 'results',
];

const SECTION_STATUSES: readonly string[] = ['attention', 'ok', 'neutral'];

const ACTION_KINDS: readonly string[] = ['default', 'primary', 'danger'];

/** An action the renderer will post straight back, so its intent has to be one we accept. */
function isAction(value: unknown): boolean {
	return hasStrings(value, ['id', 'label', 'kind'])
		&& ACTION_KINDS.includes(value.kind as string)
		&& typeof value.disabled === 'boolean'
		&& parseEditorMigrationSetupIntent(value.intent) !== undefined;
}

function isDisclosure(value: unknown): boolean {
	return hasStrings(value, ['id', 'summary'])
		&& isStringArray((value as Record<string, unknown>).items)
		&& isOptionalString((value as Record<string, unknown>).note)
		&& isOptionalString((value as Record<string, unknown>).remainingText);
}

function isOptionalDisclosure(value: unknown): boolean {
	return value === undefined || isDisclosure(value);
}

function isGroup(value: unknown): boolean {
	return hasStrings(value, ['id', 'title', 'countDescription'])
		&& isCount(value.count)
		&& isOptionalDisclosure(value.disclosure);
}

function isRadioOption(value: unknown): boolean {
	return hasStrings(value, ['id', 'label'])
		&& typeof value.checked === 'boolean'
		&& isOptionalString(value.description)
		&& parseEditorMigrationSetupIntent(value.intent) !== undefined;
}

function isChoiceCard(value: unknown): boolean {
	return hasStrings(value, ['id', 'title', 'detail'])
		&& parseEditorMigrationSetupIntent(value.intent) !== undefined;
}

function isRecoveryRecord(value: unknown): boolean {
	return hasStrings(value, ['id', 'title', 'detail'])
		&& (value.action === undefined || isAction(value.action));
}

function isConflictRow(value: unknown): boolean {
	return hasStrings(value, ['id', 'name', 'searchText', 'currentValue', 'importedValue', 'valuesDescription'])
		&& (value.comparison === undefined || (hasStrings(value.comparison, ['currentLabel', 'importedLabel', 'expandLabel', 'collapseLabel']) && isOptionalString(value.comparison.note)))
		&& isOptionalArrayOf(value.choices, isRadioOption)
		&& isOptionalString(value.chosenText);
}

function isProblemRow(value: unknown): boolean {
	return hasStrings(value, ['id', 'text', 'outcome']) && isOptionalString(value.detail);
}

function isProgressBar(value: unknown): boolean {
	return hasStrings(value, ['text']) && isCount(value.min) && isCount(value.max) && isCount(value.now);
}

function isProgressRow(value: unknown): boolean {
	return hasStrings(value, ['id', 'label', 'state']);
}

function isFileCategoryArray(value: unknown): boolean {
	return isArrayOf(value, entry => typeof entry === 'string' && (EDITOR_MIGRATION_SETUP_FILE_CATEGORIES as readonly string[]).includes(entry));
}

/**
 * One validator per panel kind, discriminated the same way the renderer switches on it.
 *
 * The renderer reads these fields without guarding each one — it maps over `applications`, reads
 * `progress.now`, spreads `newTarget` — so a panel that carries only a `kind` and an `id` is a
 * crash, not a cosmetic defect. Each entry lists exactly what its component dereferences.
 */
const PANEL_VALIDATORS: Readonly<Record<string, (panel: Record<string, unknown>) => boolean>> = {
	loading: panel => isProgressBar(panel.progress),
	recovery: panel => hasStrings(panel, ['lead', 'filterLabel', 'listLabel', 'emptyText', 'noMatchText'])
		&& isArrayOf(panel.records, isRecoveryRecord),
	applications: panel => hasStrings(panel, ['lead', 'filterLabel', 'listLabel', 'emptyText', 'noMatchText'])
		&& isArrayOf(panel.applications, isChoiceCard)
		&& isOptionalDisclosure(panel.diagnostics),
	profiles: panel => hasStrings(panel, ['filterLabel', 'groupLabel', 'noMatchText'])
		&& isArrayOf(panel.profiles, isRadioOption)
		&& isOptionalDisclosure(panel.details),
	target: panel => hasStrings(panel, ['lead', 'groupLabel'])
		&& isArrayOf(panel.targets, isRadioOption)
		&& hasStrings(panel.newTarget, ['label', 'placeholder', 'actionLabel', 'value'])
		&& isOptionalString((panel.newTarget as Record<string, unknown>).selectedText),
	reviewCategory: panel => hasStrings(panel, ['lead', 'ownership'])
		&& (panel.include === undefined || (hasStrings(panel.include, ['label', 'category'])
			&& typeof (panel.include as Record<string, unknown>).checked === 'boolean'
			&& (EDITOR_MIGRATION_SETUP_CATEGORIES as readonly string[]).includes((panel.include as Record<string, unknown>).category as string)))
		&& isArrayOf(panel.conflicts, isConflictRow)
		&& isArrayOf(panel.warnings, isGroup)
		&& isOptionalArrayOf(panel.bulkActions, isAction)
		&& isOptionalDisclosure(panel.additions)
		&& [panel.excludedText, panel.differencesHeading, panel.conflictFilterLabel, panel.conflictOverflowTemplate, panel.notesHeading, panel.exclusionNote, panel.emptyText].every(isOptionalString),
	groups: panel => hasStrings(panel, ['lead'])
		&& isArrayOf(panel.groups, isGroup)
		&& isOptionalString(panel.emptyText),
	applyOverview: panel => hasStrings(panel, ['note'])
		&& isProgressBar(panel.progress)
		&& isArrayOf(panel.rows, isProgressRow)
		&& isOptionalString(panel.currentItem),
	applyCategory: panel => hasStrings(panel, ['lead'])
		&& isArrayOf(panel.problems, isProblemRow)
		&& isOptionalString(panel.problemOverflowText)
		&& isOptionalString(panel.recordedNote),
	resultsOverview: panel => hasStrings(panel, ['outcome', 'lead'])
		&& isArrayOf(panel.placements, isGroup)
		&& isOptionalString(panel.placementsHeading)
		&& isOptionalDisclosure(panel.preserved)
		&& (panel.rollbackOutcome === undefined || (hasStrings(panel.rollbackOutcome, ['heading', 'note'])
			&& isStringArray((panel.rollbackOutcome as Record<string, unknown>).rows))),
	resultsCategory: panel => hasStrings(panel, ['lead'])
		&& isArrayOf(panel.problems, isProblemRow)
		&& isOptionalDisclosure(panel.completed)
		&& [panel.problemsHeading, panel.problemOverflowText, panel.emptyText].every(isOptionalString),
	restore: panel => [panel.lead, panel.placeholder].every(isOptionalString)
		&& (panel.selection === undefined || (hasStrings(panel.selection, ['legend', 'inspectLabel'])
			&& isArrayOf((panel.selection as Record<string, unknown>).options, option => hasStrings(option, ['category', 'label'])
				&& (EDITOR_MIGRATION_SETUP_FILE_CATEGORIES as readonly string[]).includes((option as Record<string, unknown>).category as string))))
		&& (panel.inspection === undefined || (hasStrings(panel.inspection, ['description', 'actionLabel'])
			&& typeof (panel.inspection as Record<string, unknown>).forced === 'boolean'
			&& isOptionalString((panel.inspection as Record<string, unknown>).heading)
			&& isFileCategoryArray((panel.inspection as Record<string, unknown>).driftedCategories))),
	message: panel => isOptionalString(panel.lead),
};

/** Every panel kind is known, and its own required fields are present. */
export function isEditorMigrationSetupPanel(value: unknown): value is EditorMigrationSetupPanel {
	if (!hasStrings(value, ['kind', 'id', 'heading'])) {
		return false;
	}
	const validator = PANEL_VALIDATORS[value.kind as string];
	return validator !== undefined && validator(value);
}

function isSection(value: unknown): boolean {
	return hasStrings(value, ['id', 'label', 'status', 'statusDescription'])
		&& SECTION_STATUSES.includes(value.status as string)
		&& isOptionalCount(value.count)
		&& (value.separated === undefined || typeof value.separated === 'boolean');
}

function isStep(value: unknown): boolean {
	return hasStrings(value, ['id', 'label']) && typeof value.current === 'boolean';
}

/**
 * Structural check of a presentation snapshot at the trust boundary.
 *
 * The renderer reads these fields without guarding each one, so a payload that merely looks like an
 * object would crash it on the first access. This validates the whole shape the renderer
 * dereferences, discriminated per panel kind, rather than trusting a `kind` string on its own.
 */
export function isEditorMigrationSetupPresentation(value: unknown): value is EditorMigrationSetupPresentation {
	if (!isRecord(value)) {
		return false;
	}
	return isCount(value.revision)
		&& typeof value.phase === 'string' && PHASES.includes(value.phase)
		&& typeof value.regionLabel === 'string'
		&& typeof value.title === 'string'
		&& typeof value.scopeKey === 'string'
		&& typeof value.sectionAnnouncementTemplate === 'string'
		&& typeof value.busy === 'boolean'
		&& typeof value.canceling === 'boolean'
		&& isOptionalString(value.error)
		&& isOptionalString(value.announcement)
		&& isOptionalString(value.railLabel)
		&& isOptionalString(value.railTitle)
		&& isOptionalString(value.defaultSectionId)
		&& isArrayOf(value.steps, isStep)
		&& isArrayOf(value.sections, isSection)
		&& isArrayOf(value.panels, isEditorMigrationSetupPanel)
		&& isRecord(value.footer)
		&& isStringArray(value.footer.lines)
		&& isArrayOf(value.footer.actions, isAction);
}

/** Parses one host message. The renderer refuses anything else, including a foreign version. */
export function parseEditorMigrationSetupHostMessage(value: unknown): EditorMigrationSetupHostMessage | undefined {
	if (!isRecord(value) || value.protocolVersion !== EDITOR_MIGRATION_SETUP_PROTOCOL_VERSION) {
		return undefined;
	}
	switch (value.type) {
		case 'state':
			return typeof value.revision === 'number' && isEditorMigrationSetupPresentation(value.presentation)
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
