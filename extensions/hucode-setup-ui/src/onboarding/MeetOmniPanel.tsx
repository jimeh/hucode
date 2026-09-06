/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FolderIcon, GitBranchIcon, LayoutPanelLeftIcon } from 'lucide-react';
import type {
	EditorMigrationSetupIntent,
	EditorMigrationSetupListPreview,
	EditorMigrationSetupListPreviewRow,
	EditorMigrationSetupPanel,
} from '@/generated/editorMigrationSetupProtocol';
import { Lead, PanelHeading, SubHeading } from '@/components/primitives';
import { Checkbox } from '@/vendor/shadcn/checkbox';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/vendor/shadcn/field';
import { cn } from '@/vendor/shadcn/lib/utils';

/**
 * Meet Omni: the vocabulary, an illustrative Projects list at the staged density, the one density
 * switch, and the shortcuts the host resolved.
 *
 * The list is a picture, not a control. Its rows are presentational and outside the tab order,
 * and the density is named in text beside them, so a change never depends on visual comparison.
 * The rows draw exactly the fields the host resolved through the shared row model; only the
 * line layout is decided here, from the snapshot's `layout`.
 */
export function MeetOmniPanel({ panel, send }: {
	readonly panel: Extract<EditorMigrationSetupPanel, { kind: 'meetOmni' }>;
	readonly send: (intent: EditorMigrationSetupIntent) => void;
}) {
	const toggle = panel.densityToggle;
	return (
		<div className="flex flex-col gap-4 pb-6">
			<PanelHeading>{panel.heading}</PanelHeading>
			<Lead>{panel.lead}</Lead>
			<dl className="grid max-w-2xl grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
				{panel.glossary.map(entry => (
					<div key={entry.term} className="contents">
						<dt className="text-foreground font-medium">{entry.term}</dt>
						<dd className="text-muted-foreground">{entry.definition}</dd>
					</div>
				))}
			</dl>
			<ListPreview preview={panel.preview} />
			<Field orientation="horizontal" className="max-w-2xl">
				<Checkbox
					id={`toggle-${toggle.id}`}
					data-focus-id={`toggle-${toggle.id}`}
					checked={toggle.checked}
					onCheckedChange={() => send(toggle.intent)}
				/>
				<FieldContent>
					<FieldLabel htmlFor={`toggle-${toggle.id}`}>{toggle.label}</FieldLabel>
					{toggle.description ? <FieldDescription>{toggle.description}</FieldDescription> : null}
				</FieldContent>
			</Field>
			<ul className="flex max-w-2xl flex-col">
				{panel.shortcuts.map(shortcut => (
					<li key={shortcut.label} className="border-border/60 flex items-baseline justify-between gap-4 border-b py-1.5 text-sm last:border-b-0">
						<span>{shortcut.label}</span>
						{shortcut.keybinding ? (
							<kbd
								aria-label={shortcut.keybindingAriaLabel}
								className="bg-muted text-foreground border-border rounded-sm border px-1.5 py-0.5 font-mono text-xs whitespace-nowrap"
							>
								{shortcut.keybinding}
							</kbd>
						) : (
							<span className="text-muted-foreground text-right text-xs">{shortcut.noShortcutText}</span>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

function ListPreview({ preview }: { readonly preview: EditorMigrationSetupListPreview }) {
	return (
		<section aria-label={preview.label} className="flex max-w-md flex-col gap-2">
			<SubHeading>{preview.label}</SubHeading>
			<div
				role="presentation"
				aria-hidden
				data-preview-layout={preview.layout}
				className="border-border bg-card flex flex-col rounded-md border px-1 py-1.5 select-none"
			>
				{preview.rows.map(row => <PreviewRow key={row.id} row={row} layout={preview.layout} />)}
			</div>
			<p data-density-label className="text-muted-foreground text-xs">{preview.densityLabel}</p>
		</section>
	);
}

/**
 * One row. Project rows are one line in either density; worktree and workbench rows stack their
 * secondary fields on a second line in `default` and keep to one line in `compact`.
 */
function PreviewRow({ row, layout }: { readonly row: EditorMigrationSetupListPreviewRow; readonly layout: EditorMigrationSetupListPreview['layout'] }) {
	const Icon = row.kind === 'project' ? FolderIcon : row.kind === 'worktree' ? GitBranchIcon : LayoutPanelLeftIcon;
	const twoLine = row.kind !== 'project' && layout === 'default';
	// The sidebar's two-line rows keep the path beside a worktree's name and the branch beside a
	// workbench's, and put the other field on the second line. One-line rows show name then the
	// one secondary field the row model left in.
	const beside = row.kind === 'workbench' ? row.branch : row.path;
	const secondary = row.kind === 'workbench' ? row.path : row.branch;
	return (
		<div
			role="presentation"
			data-preview-row={row.kind}
			className={cn('flex min-w-0 items-start gap-2 rounded-sm px-2', row.kind === 'worktree' ? 'ml-4' : '', twoLine ? 'py-1' : 'py-0.5')}
		>
			<Icon aria-hidden className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
			<div className={cn('flex min-w-0 flex-1 text-xs', twoLine ? 'flex-col' : 'items-baseline gap-2')}>
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="text-foreground truncate font-medium">{row.name}</span>
					{twoLine && beside ? <span className="text-muted-foreground truncate">{beside}</span> : null}
				</span>
				{secondary ? <span className="text-muted-foreground truncate">{secondary}</span> : null}
			</div>
		</div>
	);
}
