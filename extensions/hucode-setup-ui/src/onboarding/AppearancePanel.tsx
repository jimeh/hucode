/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
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
import { buttonVariants } from '@/vendor/shadcn/button';
import { Field, FieldLabel } from '@/vendor/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@/vendor/shadcn/radio-group';
import { cn } from '@/vendor/shadcn/lib/utils';

/**
 * Appearance stage: the mode as one row of three tiles, then the preferred light and dark theme
 * lists side by side, each a filterable radio list.
 *
 * Every choice posts the intent the host attached or the identifier it listed, so the renderer can
 * only select what the snapshot offers. The lists virtualize past the shared threshold, which is
 * what keeps a few hundred installed themes responsive. The tiles are radio items styled like the
 * Bring choices, so the two stages read as one family; the lists stack below the medium width.
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
			{panel.paragraphs.map(paragraph => (
				<Note key={paragraph} className="-mt-2 max-w-2xl">{paragraph}</Note>
			))}
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
				className="max-w-3xl grid-cols-3 gap-3"
			>
				{panel.modes.map(mode => (
					<RadioGroupPrimitive.Item
						key={mode.id}
						value={mode.id}
						id={`mode-${mode.id}`}
						data-focus-id={`mode-${mode.id}`}
						aria-labelledby={`mode-${mode.id}-label`}
						aria-describedby={mode.description ? `mode-${mode.id}-description` : undefined}
						className={cn(
							buttonVariants({ variant: 'outline' }),
							'h-auto min-w-0 flex-col items-start gap-1 px-3 py-2.5 text-left whitespace-normal',
							'data-[state=checked]:border-primary data-[state=checked]:ring-2 data-[state=checked]:ring-primary/60',
						)}
					>
						<span id={`mode-${mode.id}-label`} className="text-sm font-medium">{mode.label}</span>
						{mode.description ? (
							<span id={`mode-${mode.id}-description`} className="text-muted-foreground text-xs font-normal">{mode.description}</span>
						) : null}
					</RadioGroupPrimitive.Item>
				))}
			</RadioGroup>
			<div className="grid max-w-3xl gap-x-6 gap-y-4 md:grid-cols-2">
				<ThemeList scheme="light" group={panel.light} local={local} scrollRef={scrollRef} send={send} />
				<ThemeList scheme="dark" group={panel.dark} local={local} scrollRef={scrollRef} send={send} />
			</div>
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
		<section aria-label={group.label} className="flex min-w-0 flex-col gap-2">
			<SubHeading>{group.label}</SubHeading>
			<FilterInput
				id={filterId}
				label={group.filterLabel}
				value={local.filters[filterId] ?? ''}
				itemCount={group.themes.length}
				onChange={value => local.setFilter(filterId, value)}
			/>
			<Note role="status" className="empty:-mt-2">{group.themes.length > 0 && themes.length === 0 ? group.noMatchText : ''}</Note>
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
					<VirtualCollection items={themes} itemKey={theme => theme.id} estimateSize={32} scrollRef={scrollRef} label={group.listLabel}>
						{(theme, index) => (
							<Field orientation="horizontal" className="border-border/60 items-center border-b py-1.5">
								<RadioGroupItem value={theme.id} id={`theme-${scheme}-${index}`} data-focus-id={`theme-${scheme}-${theme.id}`} />
								<FieldLabel htmlFor={`theme-${scheme}-${index}`} className="truncate text-xs font-normal">{theme.label}</FieldLabel>
							</Field>
						)}
					</VirtualCollection>
				</RadioGroup>
			) : null}
		</section>
	);
}
