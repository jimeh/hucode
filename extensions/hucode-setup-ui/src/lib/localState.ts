/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useState } from 'react';
import type {
	EditorMigrationSetupFileCategory,
	EditorMigrationSetupPresentation,
} from '@/generated/editorMigrationSetupProtocol';

/**
 * Presentation state React owns: the active section, filter text, open disclosures, the new-profile
 * draft name, and the rollback category selection. Everything else is authoritative host state.
 *
 * Every piece is tagged with the snapshot identity it belongs to and resolved during render, not in
 * a passive effect. An effect would let one frame paint the previous phase's rail and filters
 * against the new phase's panels, which is how a focused control could vanish after the commit that
 * was supposed to notice it leaving.
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

/** Local state belonging to one draft or operation, discarded when the snapshot describes another. */
interface ScopedState {
	readonly scopeKey: string | undefined;
	readonly filters: Readonly<Record<string, string>>;
	readonly openDisclosures: ReadonlySet<string>;
	readonly newTargetName: string | undefined;
	/** The rollback option set this selection was made against, so a new set reseeds exactly once. */
	readonly rollbackOptionsKey: string | undefined;
	readonly rollbackSelection: ReadonlySet<EditorMigrationSetupFileCategory> | undefined;
}

const EMPTY_SCOPE: ScopedState = {
	scopeKey: undefined,
	filters: {},
	openDisclosures: new Set(),
	newTargetName: undefined,
	rollbackOptionsKey: undefined,
	rollbackSelection: undefined,
};

export function useLocalSetupState(presentation: EditorMigrationSetupPresentation | undefined): LocalSetupState {
	const [stored, setStored] = useState<ScopedState>(EMPTY_SCOPE);
	const [section, setSection] = useState<{ readonly phase: string; readonly id: string } | undefined>(undefined);
	const [announcement, setAnnouncement] = useState<{ readonly revision: number; readonly text: string } | undefined>(undefined);

	const scopeKey = presentation?.scopeKey;
	// Resolved, not reset: a stale tag simply stops contributing, so the very first render of a new
	// scope already shows empty filters rather than the previous draft's.
	const scoped = stored.scopeKey === scopeKey ? stored : EMPTY_SCOPE;

	const restoreOptions = useMemo(() => {
		const panel = presentation?.panels.find(candidate => candidate.kind === 'restore');
		return panel?.kind === 'restore' ? panel.selection?.options.map(option => option.category) ?? [] : [];
	}, [presentation]);
	const restoreKey = restoreOptions.join(',');

	/*
	 * Rollback defaults to every eligible category and is seeded once per option set. Reseeding
	 * whenever a snapshot arrives would undo the user's own clearing on the next progress update.
	 */
	const rollbackSelection = scoped.rollbackOptionsKey === restoreKey && scoped.rollbackSelection
		? scoped.rollbackSelection
		: new Set(restoreOptions);

	/*
	 * The active section is tagged with the phase, not the scope.
	 *
	 * Review and publisher confirmation describe the same draft and deliberately share a scope so
	 * filters and disclosures survive the transition. They do not share a rail: a category the user
	 * selected during review would otherwise stay active in publisher confirmation and hide the
	 * publisher list the footer is asking them to confirm.
	 */
	const carriedSectionId = presentation && section?.phase === presentation.phase ? section.id : undefined;
	const activeSectionId = carriedSectionId && presentation?.sections.some(candidate => candidate.id === carriedSectionId)
		? carriedSectionId
		: presentation?.defaultSectionId;

	const update = useCallback((change: Partial<ScopedState>) => {
		setStored(previous => ({
			...(previous.scopeKey === scopeKey ? previous : EMPTY_SCOPE),
			scopeKey,
			...change,
		}));
	}, [scopeKey]);

	// Announcing from the click keeps the live region out of render-time side effects. Binding it
	// to a revision keeps a rail move from outliving the screen it described.
	const setActiveSection = useCallback((id: string) => {
		if (id === activeSectionId || !presentation) {
			return;
		}
		setSection({ phase: presentation.phase, id });
		const label = presentation.sections.find(candidate => candidate.id === id)?.label;
		setAnnouncement(label
			? { revision: presentation.revision, text: presentation.sectionAnnouncementTemplate.replace('{0}', label) }
			: undefined);
	}, [presentation, activeSectionId]);

	return {
		activeSectionId,
		filters: scoped.filters,
		openDisclosures: scoped.openDisclosures,
		newTargetName: scoped.newTargetName,
		rollbackSelection,
		sectionAnnouncement: announcement && announcement.revision === presentation?.revision ? announcement.text : undefined,
		setActiveSection,
		setFilter: useCallback((id, value) => update({ filters: { ...(stored.scopeKey === scopeKey ? stored.filters : {}), [id]: value } }), [update, stored, scopeKey]),
		toggleDisclosure: useCallback((id, open) => {
			const current = stored.scopeKey === scopeKey ? stored.openDisclosures : EMPTY_SCOPE.openDisclosures;
			const next = new Set(current);
			open ? next.add(id) : next.delete(id);
			update({ openDisclosures: next });
		}, [update, stored, scopeKey]),
		setNewTargetName: useCallback(value => update({ newTargetName: value }), [update]),
		toggleRollbackCategory: useCallback((category, selected) => {
			const next = new Set(rollbackSelection);
			selected ? next.add(category) : next.delete(category);
			update({ rollbackOptionsKey: restoreKey, rollbackSelection: next });
		}, [update, rollbackSelection, restoreKey]),
	};
}
