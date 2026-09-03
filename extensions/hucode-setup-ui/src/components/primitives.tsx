/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type {
	EditorMigrationSetupAction,
	EditorMigrationSetupDisclosure,
	EditorMigrationSetupGroup,
	EditorMigrationSetupProblemRow,
} from '@/generated/editorMigrationSetupProtocol';
import { Badge } from '@/vendor/shadcn/badge';
import { Button } from '@/vendor/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/vendor/shadcn/collapsible';
import { Input } from '@/vendor/shadcn/input';
import { cn } from '@/vendor/shadcn/lib/utils';

/** Maps the protocol's action kinds onto the vendored button variants. */
const ACTION_VARIANT = {
	default: 'outline',
	primary: 'default',
	danger: 'destructive',
} as const;

export function ActionButton({ action, onRun, className }: {
	readonly action: EditorMigrationSetupAction;
	readonly onRun: (action: EditorMigrationSetupAction) => void;
	readonly className?: string;
}) {
	return (
		<Button
			type="button"
			size="sm"
			variant={ACTION_VARIANT[action.kind]}
			disabled={action.disabled}
			data-focus-id={action.id}
			className={className}
			onClick={() => onRun(action)}
		>
			{action.label}
		</Button>
	);
}

/** Filter control. It only appears once a collection is too long to scan. */
export const FILTER_THRESHOLD = 8;

export function FilterInput({ id, label, value, itemCount, onChange }: {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly itemCount: number;
	readonly onChange: (value: string) => void;
}) {
	if (itemCount <= FILTER_THRESHOLD) {
		return null;
	}
	return (
		<div className="relative max-w-sm">
			<SearchIcon aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
			<Input
				type="search"
				className="h-8 pl-7 text-xs"
				placeholder={label}
				aria-label={label}
				value={value}
				data-focus-id={`filter-${id}`}
				onChange={event => onChange(event.target.value)}
			/>
		</div>
	);
}

/**
 * Names behind an aggregate.
 *
 * The list expands in document flow and is already truncated by core, so a disclosure never
 * becomes a second scroll region.
 */
export function Disclosure({ disclosure, scope, open, onOpenChange }: {
	readonly disclosure: EditorMigrationSetupDisclosure;
	readonly scope: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}) {
	return (
		<Collapsible open={open} onOpenChange={onOpenChange}>
			<CollapsibleTrigger
				data-focus-id={`disclosure-${scope}-${disclosure.id}`}
				className="text-muted-foreground hover:text-foreground group flex items-center gap-1.5 rounded-sm text-xs"
			>
				<ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
				{disclosure.summary}
			</CollapsibleTrigger>
			<CollapsibleContent className="border-border/70 mt-1.5 ml-1.5 flex flex-col gap-1.5 border-l pl-3">
				{disclosure.note ? <p className="text-muted-foreground text-xs">{disclosure.note}</p> : null}
				{disclosure.items.length ? (
					<ul className="flex flex-col gap-0.5">
						{disclosure.items.map(item => (
							<li key={item} className="font-mono text-xs break-all">{item}</li>
						))}
					</ul>
				) : null}
				{disclosure.remainingText ? <p className="text-muted-foreground text-xs">{disclosure.remainingText}</p> : null}
			</CollapsibleContent>
		</Collapsible>
	);
}

/** One row per aggregated cause: the cause stated once, its count, and its names on request. */
export function GroupList({ groups, scope, openDisclosures, onToggleDisclosure }: {
	readonly groups: readonly EditorMigrationSetupGroup[];
	readonly scope: string;
	readonly openDisclosures: ReadonlySet<string>;
	readonly onToggleDisclosure: (id: string, open: boolean) => void;
}) {
	return (
		<ul className="flex flex-col">
			{groups.map(group => (
				<li key={group.id} className="border-border/60 flex gap-3 border-b py-2.5 last:border-b-0">
					<Badge variant="secondary" aria-hidden className="mt-0.5 h-5 min-w-8 justify-center font-mono tabular-nums">
						{group.count}
					</Badge>
					<div className="flex min-w-0 flex-col gap-1.5">
						<span className="hucode-sr-only">{group.countDescription}</span>
						<span className="text-sm">{group.title}</span>
						{group.disclosure ? (
							<Disclosure
								disclosure={group.disclosure}
								scope={scope}
								open={openDisclosures.has(`${scope}:${group.disclosure.id}`)}
								onOpenChange={open => onToggleDisclosure(`${scope}:${group.disclosure!.id}`, open)}
							/>
						) : null}
					</div>
				</li>
			))}
		</ul>
	);
}

export function ProblemList({ problems, overflowText }: {
	readonly problems: readonly EditorMigrationSetupProblemRow[];
	readonly overflowText?: string;
}) {
	if (!problems.length) {
		return null;
	}
	return (
		<div className="flex flex-col">
			<ul className="flex flex-col">
				{problems.map(problem => (
					<li key={problem.id} className="border-border/60 flex flex-col gap-0.5 border-b py-2 last:border-b-0">
						<span className="flex items-baseline gap-2 text-sm">
							<span aria-hidden className="text-attention">!</span>
							{problem.text}
						</span>
						{problem.detail ? <span className="text-muted-foreground pl-4 text-xs">{problem.detail}</span> : null}
					</li>
				))}
			</ul>
			{overflowText ? <p className="text-muted-foreground pt-2 text-xs">{overflowText}</p> : null}
		</div>
	);
}

/** Section heading inside the detail pane. Focusable so a phase change can land on it. */
export function PanelHeading({ children, id }: { readonly children: ReactNode; readonly id?: string }) {
	const generated = useId();
	return (
		<h2 id={id ?? generated} tabIndex={-1} data-panel-heading className="text-foreground text-base font-semibold outline-none">
			{children}
		</h2>
	);
}

export function Lead({ children }: { readonly children: ReactNode }) {
	return <p className="text-muted-foreground text-sm">{children}</p>;
}

export function Note({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
	return <p className={cn('text-muted-foreground text-xs', className)}>{children}</p>;
}

export function SubHeading({ children }: { readonly children: ReactNode }) {
	return <h3 className="text-foreground pt-1 text-sm font-medium">{children}</h3>;
}
