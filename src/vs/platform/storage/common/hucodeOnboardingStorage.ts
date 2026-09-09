/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Application-scoped storage key of the onboarding record. */
export const ONBOARDING_STATE_STORAGE_KEY = 'hucode.onboarding.state';

/** Schema version this build writes. A stored record with a newer version is never rewritten. */
export const ONBOARDING_RECORD_VERSION = 2;

export type OnboardingRecordStatus = 'notStarted' | 'inProgress' | 'skipped' | 'completed';

export type OnboardingRecordStage = 'bring' | 'migrate' | 'appearance' | 'meetOmni';

export type OnboardingRecordRoute = 'migrate' | 'skipImport';

/**
 * Installation-scoped onboarding record.
 *
 * It stores navigation and an optional import target profile reference, without imported values,
 * paths, or operation identifiers. The migration journal remains the recovery authority.
 */
export interface OnboardingRecord {
	readonly version: typeof ONBOARDING_RECORD_VERSION;
	readonly status: OnboardingRecordStatus;
	readonly stage?: OnboardingRecordStage;
	readonly route?: OnboardingRecordRoute;
	readonly completedAt?: number;
	/** Exact ordinary import target offered for the next folder handoff. */
	readonly handoffProfileId?: string;
}

/**
 * What the store found.
 *
 * A missing or malformed record reads as a fresh `notStarted` record. A record written by a newer
 * schema is reported as `superseded` rather than parsed, so nothing this build does can
 * downgrade it.
 */
export type OnboardingStoredState =
	| { readonly kind: 'record'; readonly record: OnboardingRecord; readonly origin?: 'missing' | 'malformed' }
	| { readonly kind: 'superseded'; readonly version: number };

const STATUSES: readonly string[] = ['notStarted', 'inProgress', 'skipped', 'completed'];
const STAGES: readonly string[] = ['bring', 'migrate', 'appearance', 'meetOmni'];
const ROUTES: readonly string[] = ['migrate', 'skipImport'];

/** Parses navigation state while retaining missing and malformed provenance. */
export function readOnboardingState(raw: string | undefined): OnboardingStoredState {
	if (raw === undefined) {
		return { kind: 'record', origin: 'missing', record: notStartedRecord() };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: 'record', origin: 'malformed', record: notStartedRecord() };
	}
	if (!isObject(parsed) || !isPositiveInteger(parsed.version)) {
		return { kind: 'record', origin: 'malformed', record: notStartedRecord() };
	}
	if (parsed.version > ONBOARDING_RECORD_VERSION) {
		return { kind: 'superseded', version: parsed.version };
	}
	const record = parseRecord(parsed);
	return record ? { kind: 'record', record } : { kind: 'record', origin: 'malformed', record: notStartedRecord() };
}

function notStartedRecord(): OnboardingRecord {
	return { version: ONBOARDING_RECORD_VERSION, status: 'notStarted' };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isOneOf<T extends string>(value: unknown, options: readonly string[]): value is T {
	return typeof value === 'string' && options.includes(value);
}

function isOptionalOneOf<T extends string>(value: unknown, options: readonly string[]): value is T | undefined {
	return value === undefined || isOneOf(value, options);
}

/** Parses supported records; anything malformed is `undefined` so the caller starts fresh. */
function parseRecord(value: Record<string, unknown>): OnboardingRecord | undefined {
	if (!isOneOf<OnboardingRecordStatus>(value.status, STATUSES)
		|| !isOptionalOneOf<OnboardingRecordStage>(value.stage, STAGES)
		|| !isOptionalOneOf<OnboardingRecordRoute>(value.route, ROUTES)
		|| (value.completedAt !== undefined && (typeof value.completedAt !== 'number' || !Number.isFinite(value.completedAt)))
		|| (value.handoffProfileId !== undefined && (typeof value.handoffProfileId !== 'string' || !value.handoffProfileId || value.handoffProfileId.length > 256))) {
		return undefined;
	}
	return {
		version: ONBOARDING_RECORD_VERSION,
		status: value.status,
		stage: value.stage,
		route: value.route,
		completedAt: value.completedAt,
		...(value.version === 2 && value.handoffProfileId !== undefined ? { handoffProfileId: value.handoffProfileId as string } : {}),
	};
}
