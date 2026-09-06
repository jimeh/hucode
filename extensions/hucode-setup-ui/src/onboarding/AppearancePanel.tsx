/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useDeferredValue, useMemo, type RefObject } from 'react';
import type {
	EditorMigrationSetupColorScheme,
	EditorMigrationSetupIntent,
	EditorMigrationSetupPanel,
	EditorMigrationSetupThemeGroup,
} from '@/generated/editorMigrationSetupProtocol';
import type { LocalSetupState } from '@/lib/localState';
import { VirtualCollection } from '@/components/VirtualCollection';
import { FilterInput, Lead, Note, PanelHeading, SubHeading } from '@/components/primitives';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/vendor/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@/vendor/shadcn/radio-group';

/**
 * Appearance stage: the mode as a radio group, then one filterable radio list per preferred theme.
 *
 * Every choice posts the intent the host attached or the identifier it listed, so the renderer can
 * only select what the snapshot offers. The lists virtualize past the shared threshold, which is
 * what keeps a few hundred installed themes responsive.
 */
export function AppearancePanel({ panel, local, scrollRef, send }: {
	readonly panel: Extract<EditorMigrationSetupPanel, { kind: 'appearance' }>;
	readonly local: LocalSetupState;
	readonly scrollRef: RefObject<HTMLElement | null>;
	readonly send: (intent: EditorMigrationSetupIntent) => void;
}) {
	const checkedMode = panel.modes.find(mode => mode.checked)?.id;
	return (
		<div className="flex flex-col gap-4 pb-6">
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			<RadioGroup
				name="onboarding-appearance-mode"
				aria-label={panel.modeGroupLabel}
				value={checkedMode ?? ''}
				onValueChange={id => {
					const mode = panel.modes.find(candidate => candidate.id === id);
					if (mode) {
						send(mode.intent);
					}
				}}
				className="max-w-2xl gap-0"
			>
				{panel.modes.map(mode => (
					<Field key={mode.id} orientation="horizontal" className="border-border/60 border-b py-2 last:border-b-0">
						<RadioGroupItem value={mode.id} id={`mode-${mode.id}`} data-focus-id={`mode-${mode.id}`} />
						<FieldContent>
							<FieldLabel htmlFor={`mode-${mode.id}`}>{mode.label}</FieldLabel>
							{mode.description ? <FieldDescription>{mode.description}</FieldDescription> : null}
						</FieldContent>
					</Field>
				))}
			</RadioGroup>
			<ThemeList scheme="light" group={panel.light} local={local} scrollRef={scrollRef} send={send} />
			<ThemeList scheme="dark" group={panel.dark} local={local} scrollRef={scrollRef} send={send} />
			{panel.paragraphs.map(paragraph => (
				<p key={paragraph} className="text-foreground max-w-2xl text-sm">{paragraph}</p>
			))}
		</div>
	);
}

/** Case-insensitive contains, matching the other filtered collections. */
function matches(text: string, filter: string): boolean {
	return text.toLowerCase().includes(filter.toLowerCase());
}

function ThemeList({ scheme, group, local, scrollRef, send }: {
	readonly scheme: EditorMigrationSetupColorScheme;
	readonly group: EditorMigrationSetupThemeGroup;
	readonly local: LocalSetupState;
	readonly scrollRef: RefObject<HTMLElement | null>;
	readonly send: (intent: EditorMigrationSetupIntent) => void;
}) {
	const filterId = `themes:${scheme}`;
	const filter = useDeferredValue(local.filters[filterId] ?? '');
	const themes = useMemo(() => group.themes.filter(theme => matches(theme.label, filter)), [group.themes, filter]);
	return (
		<section aria-label={group.label} className="flex max-w-2xl flex-col gap-3">
			<SubHeading>{group.label}</SubHeading>
			<FilterInput
				id={filterId}
				label={group.filterLabel}
				value={local.filters[filterId] ?? ''}
				itemCount={group.themes.length}
				onChange={value => local.setFilter(filterId, value)}
			/>
			<Note role="status" className="empty:-mt-3">{group.themes.length > 0 && themes.length === 0 ? group.noMatchText : ''}</Note>
			{themes.length > 0 ? (
				<RadioGroup
					name={`onboarding-theme-${scheme}`}
					aria-label={group.listLabel}
					value={group.selectedId}
					onValueChange={themeId => {
						if (group.themes.some(theme => theme.id === themeId)) {
							send({ type: 'selectPreferredTheme', scheme, themeId });
						}
					}}
					className="gap-0"
				>
					<VirtualCollection items={themes} itemKey={theme => theme.id} estimateSize={40} scrollRef={scrollRef} label={group.listLabel}>
						{(theme, index) => (
							<Field orientation="horizontal" className="border-border/60 border-b py-2">
								<RadioGroupItem value={theme.id} id={`theme-${scheme}-${index}`} data-focus-id={`theme-${scheme}-${theme.id}`} />
								<FieldLabel htmlFor={`theme-${scheme}-${index}`}>{theme.label}</FieldLabel>
							</Field>
						)}
					</VirtualCollection>
				</RadioGroup>
			) : null}
		</section>
	);
}
