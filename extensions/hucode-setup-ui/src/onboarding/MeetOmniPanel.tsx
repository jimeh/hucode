/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { EditorMigrationSetupPanel } from '@/generated/editorMigrationSetupProtocol';
import { Lead, PanelHeading } from '@/components/primitives';

/**
 * Meet Omni: the three nouns as a definition list, and the shortcuts the host resolved.
 *
 * Shortcuts render the host's chord in `<kbd>`, or its fallback text when none is bound; the
 * renderer never formats key chords. The finishes belong to the shell's footer.
 */
export function MeetOmniPanel({ panel }: {
	readonly panel: Extract<EditorMigrationSetupPanel, { kind: 'meetOmni' }>;
}) {
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
