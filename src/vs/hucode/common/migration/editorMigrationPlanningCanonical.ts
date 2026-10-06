/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isObject } from '../../../base/common/types.js';
import { EditorMigrationPlanningError } from './editorMigrationPlanning.js';

/** Serializes JSON-compatible input with recursively sorted object keys. */
export function canonicalizeEditorMigrationValue(value: unknown): string {
	return JSON.stringify(normalize(value));
}

/** Computes a lowercase Web Crypto SHA-256 digest of canonical UTF-8. */
export async function fingerprintEditorMigrationValue(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalizeEditorMigrationValue(value));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Returns a recursively frozen copy with sorted object keys. */
export function immutableEditorMigrationValue<T>(value: T): T {
	return freeze(normalize(value)) as T;
}

function normalize(value: unknown): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new EditorMigrationPlanningError('nonCanonicalInput', 'Migration planning values must contain finite numbers');
		}
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) {
		return value.map(normalize);
	}
	if (isObject(value)) {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort(compareEditorMigrationCodePoints)) {
			const item = (value as Record<string, unknown>)[key];
			if (item === undefined) {
				continue;
			}
			if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
				throw new EditorMigrationPlanningError('nonCanonicalInput', `Migration planning value '${key}' is not canonical JSON`);
			}
			result[key] = normalize(item);
		}
		return result;
	}
	throw new EditorMigrationPlanningError('nonCanonicalInput', 'Migration planning values must be canonical JSON');
}

function freeze(value: unknown): unknown {
	if (Array.isArray(value)) {
		for (const item of value) {
			freeze(item);
		}
		return Object.freeze(value);
	}
	if (isObject(value)) {
		for (const item of Object.values(value)) {
			freeze(item);
		}
		return Object.freeze(value);
	}
	return value;
}

/** Compares strings by Unicode code point without locale-dependent collation. */
export function compareEditorMigrationCodePoints(a: string, b: string): number {
	const left = Array.from(a);
	const right = Array.from(b);
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const difference = left[index].codePointAt(0)! - right[index].codePointAt(0)!;
		if (difference !== 0) {
			return difference;
		}
	}
	return left.length - right.length;
}
