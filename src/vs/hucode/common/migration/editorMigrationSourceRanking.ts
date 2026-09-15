/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorMigrationSourceDescriptor, EditorMigrationSourceRanking } from './editorMigrationSource.js';

/** Compares source ranking tuples in preferred-first order. */
export function compareEditorMigrationSourceRanking(a: EditorMigrationSourceRanking, b: EditorMigrationSourceRanking): number {
	return compareDescending(a.completeness, b.completeness)
		|| compareDescending(a.newestModificationTime, b.newestModificationTime)
		|| compareDescending(a.stableChannelPreference, b.stableChannelPreference)
		|| a.adapterOrder - b.adapterOrder
		|| compareEditorMigrationCodePoints(a.normalizedProfileName, b.normalizedProfileName)
		|| compareEditorMigrationCodePoints(a.canonicalReference, b.canonicalReference);
}

/** Compares migration-owned strings without involving editor UI collation. */
export function compareEditorMigrationCodePoints(a: string, b: string): number {
	const aIterator = a[Symbol.iterator]();
	const bIterator = b[Symbol.iterator]();
	while (true) {
		const aNext = aIterator.next();
		const bNext = bIterator.next();
		if (aNext.done || bNext.done) {
			return aNext.done === bNext.done ? 0 : aNext.done ? -1 : 1;
		}
		const difference = (aNext.value.codePointAt(0) ?? 0) - (bNext.value.codePointAt(0) ?? 0);
		if (difference !== 0) {
			return Math.sign(difference);
		}
	}
}

/** Returns a new deterministically ranked source array. */
export function rankEditorMigrationSources(sources: readonly EditorMigrationSourceDescriptor[]): EditorMigrationSourceDescriptor[] {
	return [...sources].sort((a, b) => compareEditorMigrationSourceRanking(a.ranking, b.ranking));
}

function compareDescending(a: number, b: number): number {
	return b - a;
}
