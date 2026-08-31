/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorMigrationOperation } from './editorMigrationApply.js';
import { EditorMigrationCategory } from './editorMigrationSource.js';

/** Formats a stable migration report without private source contents or local paths. */
export function formatEditorMigrationReport(operation: EditorMigrationOperation): string {
	const lines = [
		'Hucode editor setup import report',
		'',
		`Operation: ${operation.id}`,
		`Source: ${operation.plan.source.adapter.productName} / ${operation.plan.source.profile.name}`,
		`Target: ${operation.target.profileName ?? operation.plan.target.profile?.name ?? proposedTargetName(operation)}`,
		`Started: ${new Date(operation.createdAt).toISOString()}`,
		`Updated: ${new Date(operation.updatedAt).toISOString()}`,
		`Status: ${operation.aggregateOutcome ?? operation.stage}`,
		`Categories: ${operation.plan.choices.selectedCategories.join(', ')}`,
	];

	if (operation.results.length) {
		lines.push('', 'Results:');
		const indexes = categoryIndexes(operation);
		for (const result of operation.results) {
			const diagnostic = result.diagnostic?.code ? ` [${result.diagnostic.code}]` : '';
			lines.push(`- ${resultLabel(operation, result.id, result.category, indexes)}: ${result.outcome}${diagnostic}`);
		}
	}

	const preserved = operation.plan.choices.decisions.filter(decision => decision.choice === 'preserveTarget');
	if (preserved.length) {
		lines.push('', 'Kept current values:');
		for (const decision of preserved) {
			const draft = operation.plan.operations.find(item => item.id === decision.id);
			lines.push(`- ${draft ? safeOperationLabel(draft.category, draft.item, 0) : safeDecisionLabel(operation, decision.id)}`);
		}
	}

	if (operation.plan.exclusions.length) {
		lines.push('', 'Excluded during review:');
		for (const exclusion of operation.plan.exclusions) {
			lines.push(`- ${exclusion.category === 'extensions' ? exclusion.item : `Setting ${exclusion.item}`}: ${exclusion.reason}`);
		}
	}

	return `${lines.join('\n')}\n`;
}

function proposedTargetName(operation: EditorMigrationOperation): string {
	return operation.plan.target.selection.kind === 'proposed' ? operation.plan.target.selection.name : 'Unknown';
}

function categoryIndexes(operation: EditorMigrationOperation): Map<string, number> {
	const result = new Map<string, number>();
	const counters = new Map<EditorMigrationCategory, number>();
	for (const item of operation.plan.operations) {
		const index = (counters.get(item.category) ?? 0) + 1;
		counters.set(item.category, index);
		result.set(item.id, index);
	}
	return result;
}

function resultLabel(operation: EditorMigrationOperation, id: string, category: EditorMigrationCategory, indexes: ReadonlyMap<string, number>): string {
	const item = operation.plan.operations.find(operation => operation.id === id);
	return item ? safeOperationLabel(item.category, item.item, indexes.get(id) ?? 1) : categoryLabel(category);
}

function safeDecisionLabel(operation: EditorMigrationOperation, id: string): string {
	const decision = operation.plan.source.categories.length
		? id.startsWith('settings:') ? `Setting ${id.slice('settings:'.length)}`
			: id.startsWith('snippets:') ? `Snippet ${id.slice('snippets:'.length).split(':')[0]}`
				: id.startsWith('extensions:') ? `Extension ${id.slice('extensions:'.length).split(':')[0]}`
					: 'Keybinding difference'
		: 'Reviewed difference';
	return decision;
}

function safeOperationLabel(category: EditorMigrationCategory, item: string, index: number): string {
	switch (category) {
		case 'settings': return `Setting ${item}`;
		case 'keybindings': return `Keybinding change ${index || ''}`.trim();
		case 'snippets': return `Snippet ${item}`;
		case 'extensions': return `Extension ${item}`;
	}
}

function categoryLabel(category: EditorMigrationCategory): string {
	switch (category) {
		case 'settings': return 'Settings';
		case 'keybindings': return 'Keybindings';
		case 'snippets': return 'Snippets';
		case 'extensions': return 'Extensions';
	}
}
