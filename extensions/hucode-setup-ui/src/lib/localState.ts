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
	/** The typed profile name, or `undefined` while the user has not edited the field. */
	readonly newTargetName: string | undefined;
	readonly rollbackSelection: ReadonlySet<EditorMigrationSetupFileCategory>;
	/** Announcement for the last rail move, valid only for the revision it was made against. */
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
	const [newTargetName, setNewTargetName] = useState<string | undefined>(undefined);
	const [rollbackSelection, setRollbackSelection] = useState<ReadonlySet<EditorMigrationSetupFileCategory>>(() => new Set());
	const [announcement, setAnnouncement] = useState<{ readonly revision: number; readonly text: string } | undefined>(undefined);
	const scopeRef = useRef<string | undefined>(undefined);
	const phaseRef = useRef<string | undefined>(undefined);
	const seededRestoreRef = useRef<string | undefined>(undefined);

	const scopeKey = presentation?.scopeKey;
	useEffect(() => {
		if (scopeKey === undefined || scopeRef.current === scopeKey) {
			return;
		}
		scopeRef.current = scopeKey;
		setFilters({});
		setOpenDisclosures(new Set());
		setNewTargetName(undefined);
		setRollbackSelection(new Set());
		seededRestoreRef.current = undefined;
	}, [scopeKey]);

	/*
	 * The active section is scoped to the phase, not to the scope key.
	 *
	 * Review and publisher confirmation describe the same draft and deliberately share a scope so
	 * filters and disclosures survive the transition. They do not share a rail: a category the user
	 * selected during review would otherwise stay active in publisher confirmation and hide the
	 * publisher list the footer is asking them to confirm.
	 */
	const phase = presentation?.phase;
	useEffect(() => {
		if (phase === undefined || phaseRef.current === phase) {
			return;
		}
		phaseRef.current = phase;
		setActiveSectionId(undefined);
	}, [phase]);

	/*
	 * Rollback defaults to every eligible category, seeded once per option set. Reseeding on every
	 * snapshot would undo the user's own clearing the moment any unrelated progress arrived.
	 */
	const restoreOptions = useMemo(() => {
		const panel = presentation?.panels.find(candidate => candidate.kind === 'restore');
		return panel?.kind === 'restore' ? panel.selection?.options.map(option => option.category) : undefined;
	}, [presentation]);
	const restoreKey = restoreOptions?.join(',');
	useEffect(() => {
		if (!restoreOptions?.length || restoreKey === undefined) {
			return;
		}
		if (seededRestoreRef.current === restoreKey) {
			// The option set is unchanged, so only drop categories the host has stopped offering.
			setRollbackSelection(previous => {
				const kept = [...previous].filter(category => restoreOptions.includes(category));
				return kept.length === previous.size ? previous : new Set(kept);
			});
			return;
		}
		seededRestoreRef.current = restoreKey;
		setRollbackSelection(new Set(restoreOptions));
	}, [restoreKey, restoreOptions]);

	const resolvedSectionId = activeSectionId && presentation?.sections.some(section => section.id === activeSectionId)
		? activeSectionId
		: presentation?.defaultSectionId;

	// Announcing from the click keeps the live region out of render-time side effects. Binding it
	// to a revision keeps a rail move from riding along with a later host announcement.
	const setActiveSection = useCallback((id: string) => {
		if (id === resolvedSectionId || !presentation) {
			return;
		}
		setActiveSectionId(id);
		const label = presentation.sections.find(section => section.id === id)?.label;
		setAnnouncement(label
			? { revision: presentation.revision, text: presentation.sectionAnnouncementTemplate.replace('{0}', label) }
			: undefined);
	}, [presentation, resolvedSectionId]);

	return {
		activeSectionId: resolvedSectionId,
		filters,
		openDisclosures,
		newTargetName,
		rollbackSelection,
		sectionAnnouncement: announcement && announcement.revision === presentation?.revision ? announcement.text : undefined,
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
