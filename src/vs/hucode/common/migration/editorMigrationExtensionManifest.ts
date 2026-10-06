/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as semver from '../../../base/common/semver/semver.js';
import { isUUID } from '../../../base/common/uuid.js';
import { EditorMigrationPlanningError, EditorMigrationTargetExtension } from './editorMigrationPlanning.js';
import { canonicalizeEditorMigrationValue, compareEditorMigrationCodePoints as compare } from './editorMigrationPlanningCanonical.js';

/** Parses current and supported legacy profile extension manifests without rewriting them. */
export function parseEditorMigrationExtensionManifest(contents: string): readonly EditorMigrationTargetExtension[] {
	let raw: unknown;
	try {
		raw = JSON.parse(contents);
	} catch {
		throw new EditorMigrationPlanningError('invalidExtensionManifest', 'Target extension manifest is malformed JSON');
	}
	const entries = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.extensions) ? raw.extensions : undefined;
	if (!entries) {
		throw new EditorMigrationPlanningError('invalidExtensionManifest', 'Target extension manifest must contain an extension array');
	}
	const result = new Map<string, EditorMigrationTargetExtension>();
	for (const entry of entries) {
		if (!isObject(entry)) {
			throw new EditorMigrationPlanningError('invalidExtensionManifest', 'Target extension manifest contains a non-object entry');
		}
		const identifier = isObject(entry.identifier) ? entry.identifier : undefined;
		const id = typeof identifier?.id === 'string' ? identifier.id : typeof entry.id === 'string' ? entry.id : undefined;
		const version = typeof entry.version === 'string' ? entry.version : undefined;
		if (!id || !version || !/^[^.\s]+\.[^.\s]+$/.test(id)) {
			throw new EditorMigrationPlanningError('invalidExtensionManifest', 'Target extension manifest contains an invalid identity or version');
		}
		const normalizedId = id.toLowerCase();
		const metadata = isObject(entry.metadata) ? entry.metadata : undefined;
		const uuid = metadata?.id ?? identifier?.uuid;
		if (uuid !== undefined && (typeof uuid !== 'string' || !isUUID(uuid))) {
			throw new EditorMigrationPlanningError('invalidExtensionManifest', 'Target extension manifest contains an invalid UUID');
		}
		const parsed: EditorMigrationTargetExtension = {
			id: normalizedId,
			...(typeof uuid === 'string' ? { uuid: uuid.toLowerCase() } : {}),
			version,
			...(typeof metadata?.preRelease === 'boolean' ? { preRelease: metadata.preRelease } : {}),
			...(typeof metadata?.hasPreReleaseVersion === 'boolean' ? { hasPreReleaseVersion: metadata.hasPreReleaseVersion } : {}),
			applicationScoped: metadata?.isApplicationScoped === true || entry.applicationScoped === true,
		};
		const existing = result.get(normalizedId);
		if (!existing || compareManifestEntry(existing, parsed) < 0) {
			result.set(normalizedId, parsed);
		}
	}
	return [...result.values()].sort((a, b) => compare(a.id, b.id));
}

/** Combines target membership with application-scoped Default membership. */
export function effectiveEditorMigrationExtensions(
	target: readonly EditorMigrationTargetExtension[],
	defaultProfile: readonly EditorMigrationTargetExtension[],
): readonly EditorMigrationTargetExtension[] {
	const result = new Map(target.map(extension => [extension.id.toLowerCase(), extension]));
	for (const extension of defaultProfile) {
		if (extension.applicationScoped && !result.has(extension.id.toLowerCase())) {
			result.set(extension.id.toLowerCase(), extension);
		}
	}
	return [...result.values()].sort((a, b) => compare(a.id, b.id));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareVersion(a: string, b: string): number {
	const semanticOrder = semver.valid(a) && semver.valid(b) ? semver.compare(a, b) : 0;
	return semanticOrder || compare(a, b);
}

function compareManifestEntry(a: EditorMigrationTargetExtension, b: EditorMigrationTargetExtension): number {
	return compareVersion(a.version, b.version)
		|| compare(canonicalizeEditorMigrationValue(a), canonicalizeEditorMigrationValue(b));
}
