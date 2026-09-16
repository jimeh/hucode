/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react';
import type { EditorMigrationSetupSection } from '@/generated/editorMigrationSetupProtocol';
import { cn } from '@/vendor/shadcn/lib/utils';
import { Separator } from '@/vendor/shadcn/separator';

/** Glyph per state. It is decorative: every marker is also spoken through `statusDescription`. */
const STATUS_MARK = { attention: '!', ok: '✓', neutral: '·' } as const;

/**
 * Compact manifest of the import.
 *
 * Section buttons are navigation, not choices, so they never carry checkbox or radio semantics.
 * At narrow widths and high zoom the rail becomes a horizontally scrollable strip above the detail.
 */
export function SectionRail({ sections, activeId, label, title, onSelect }: {
	readonly sections: readonly EditorMigrationSetupSection[];
	readonly activeId: string | undefined;
	readonly label: string;
	readonly title: string;
	readonly onSelect: (id: string) => void;
}) {
	const activeRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}, [activeId]);

	return (
		<nav
			aria-label={label}
			className="border-border/70 flex shrink-0 gap-1 overflow-x-auto border-b pb-2 md:w-52 md:flex-col md:gap-0.5 md:overflow-x-visible md:border-r md:border-b-0 md:pr-3 md:pb-0"
		>
			<div className="text-muted-foreground hidden px-2 pb-1 text-[11px] font-medium tracking-wide uppercase md:block">
				{title}
			</div>
			{sections.map(section => (
				<div key={section.id} className="contents">
					{section.separated ? <Separator aria-hidden className="my-1.5 hidden md:block" /> : null}
					<button
						type="button"
						ref={section.id === activeId ? activeRef : undefined}
						aria-current={section.id === activeId ? 'true' : undefined}
						data-focus-id={`section-${section.id}`}
						onClick={() => onSelect(section.id)}
						className={cn(
							'flex shrink-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap',
							'hover:bg-accent hover:text-accent-foreground md:w-full',
							section.id === activeId && 'bg-selection text-selection-foreground font-medium md:border-primary md:rounded-l-none md:border-l-2',
						)}
					>
						<span
							aria-hidden
							className={cn(
								'w-3 shrink-0 text-center font-mono',
								section.status === 'attention' && 'text-attention',
								section.status === 'ok' && 'text-ok',
								section.status === 'neutral' && 'text-muted-foreground',
							)}
						>
							{STATUS_MARK[section.status]}
						</span>
						<span className="min-w-0 flex-1 truncate">{section.label}</span>
						{section.count === undefined ? null : (
							<span aria-hidden className="text-muted-foreground font-mono tabular-nums">{section.count}</span>
						)}
						<span className="hucode-sr-only">{section.statusDescription}</span>
					</button>
				</div>
			))}
		</nav>
	);
}
