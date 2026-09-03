/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
	EditorMigrationSetupFileCategory,
	EditorMigrationSetupPresentation,
} from '@/generated/editorMigrationSetupProtocol';

/**
 * Presentation state React owns: the active section, filter text, open disclosures, the new-profile
 * draft name, and the rollback category selection. Everything else is authoritative host state.
 *
 * `scopeKey` identifies what the snapshot describes. When it changes the local state is discarded,
 * which is what keeps a filter typed during one review out of a different review.
 */
export interface LocalSetupState {
	readonly activeSectionId: string | undefined;
	readonly filters: Readonly<Record<string, string>>;
	readonly openDisclosures: ReadonlySet<string>;
	readonly newTargetName: string;
	readonly rollbackSelection: ReadonlySet<EditorMigrationSetupFileCategory>;
	/** Announcement for the last rail move, or `undefined` while the user has not moved it. */
	readonly sectionAnnouncement: string | undefined;
	setActiveSection(id: string): void;
	setFilter(id: string, value: string): void;
	toggleDisclosure(id: string, open: boolean): void;
	setNewTargetName(value: string): void;
	toggleRollbackCategory(category: EditorMigrationSetupFileCategory, selected: boolean): void;
}

export function useLocalSetupState(presentation: EditorMigrationSetupPresentation | undefined): LocalSetupState {
	const [activeSectionId, setActiveSectionId] = useState<string | undefined>(undefined);
	const [filters, setFilters] = useState<Record<string, string>>({});
	const [openDisclosures, setOpenDisclosures] = useState<ReadonlySet<string>>(() => new Set());
	const [newTargetName, setNewTargetName] = useState('');
	const [rollbackSelection, setRollbackSelection] = useState<ReadonlySet<EditorMigrationSetupFileCategory>>(() => new Set());
	const [sectionAnnouncement, setSectionAnnouncement] = useState<string | undefined>(undefined);
	const scopeRef = useRef<string | undefined>(undefined);

	const scopeKey = presentation?.scopeKey;
	useEffect(() => {
		if (scopeKey === undefined || scopeRef.current === scopeKey) {
			return;
		}
		scopeRef.current = scopeKey;
		setActiveSectionId(undefined);
		setFilters({});
		setOpenDisclosures(new Set());
		setNewTargetName('');
		setRollbackSelection(new Set());
		setSectionAnnouncement(undefined);
	}, [scopeKey]);

	// Rollback defaults to every eligible category, and a category the host stops offering must not
	// linger in a selection the user can no longer see.
	const restoreOptions = useMemo(() => {
		const panel = presentation?.panels.find(candidate => candidate.kind === 'restore');
		return panel?.kind === 'restore' ? panel.selection?.options.map(option => option.category) : undefined;
	}, [presentation]);
	const restoreKey = restoreOptions?.join(',');
	useEffect(() => {
		if (!restoreOptions?.length) {
			return;
		}
		setRollbackSelection(previous => {
			const kept = [...previous].filter(category => restoreOptions.includes(category));
			return kept.length === previous.size && previous.size > 0 ? previous : new Set(kept.length ? kept : restoreOptions);
		});
	}, [restoreKey, restoreOptions]);

	const resolvedSectionId = activeSectionId && presentation?.sections.some(section => section.id === activeSectionId)
		? activeSectionId
		: presentation?.defaultSectionId;

	// Announcing from the click keeps the live region out of render-time side effects, and a
	// lingering announcement is harmless: a polite region only speaks when its text changes.
	const setActiveSection = useCallback((id: string) => {
		if (id === resolvedSectionId) {
			return;
		}
		setActiveSectionId(id);
		const label = presentation?.sections.find(section => section.id === id)?.label;
		setSectionAnnouncement(label ? presentation?.sectionAnnouncementTemplate.replace('{0}', label) : undefined);
	}, [presentation, resolvedSectionId]);

	return {
		activeSectionId: resolvedSectionId,
		filters,
		openDisclosures,
		newTargetName,
		rollbackSelection,
		sectionAnnouncement,
		setActiveSection,
		setFilter: useCallback((id, value) => setFilters(previous => ({ ...previous, [id]: value })), []),
		toggleDisclosure: useCallback((id, open) => setOpenDisclosures(previous => {
			const next = new Set(previous);
			open ? next.add(id) : next.delete(id);
			return next;
		}), []),
		setNewTargetName,
		toggleRollbackCategory: useCallback((category, selected) => setRollbackSelection(previous => {
			const next = new Set(previous);
			selected ? next.add(category) : next.delete(category);
			return next;
		}), []),
	};
}
