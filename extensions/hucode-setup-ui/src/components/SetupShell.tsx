/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AlertCircleIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { EditorMigrationSetupIntent } from '@/generated/editorMigrationSetupProtocol';
import { SectionRail } from '@/components/SectionRail';
import { SetupPanelView } from '@/components/SetupPanel';
import { ActionButton } from '@/components/primitives';
import { useLocalSetupState } from '@/lib/localState';
import type { SetupHost } from '@/lib/host';
import { Alert, AlertDescription } from '@/vendor/shadcn/alert';
import { Skeleton } from '@/vendor/shadcn/skeleton';
import { cn } from '@/vendor/shadcn/lib/utils';

/**
 * The one setup surface.
 *
 * Title, step progress, errors, and the action footer stay outside the content scroller, so the
 * detail pane is the only vertical scroll region at every width and zoom level.
 */
export function SetupShell({ host }: { readonly host: SetupHost }) {
	const state = useSyncExternalStore(host.subscribe, host.getSnapshot);
	const presentation = state.presentation;
	const local = useLocalSetupState(presentation);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const headingRef = useRef<HTMLElement | null>(null);
	const focusedIdRef = useRef<string | undefined>(undefined);
	const announcement = [presentation?.announcement, local.sectionAnnouncement].filter(Boolean).join(' ');

	const send = (intent: EditorMigrationSetupIntent) => host.send(intent);

	// Track the focused control by its stable ID so a snapshot can restore it, or fall back to the
	// phase heading when a transition removes it.
	useEffect(() => {
		const onFocusIn = (event: FocusEvent) => {
			const target = (event.target as HTMLElement | null)?.closest('[data-focus-id]');
			focusedIdRef.current = target?.getAttribute('data-focus-id') ?? undefined;
		};
		document.addEventListener('focusin', onFocusIn);
		return () => document.removeEventListener('focusin', onFocusIn);
	}, []);

	const revision = presentation?.revision;
	useLayoutEffect(() => {
		if (revision === undefined) {
			return;
		}
		const focusId = focusedIdRef.current;
		if (!focusId || document.querySelector(`[data-focus-id="${CSS.escape(focusId)}"]`)) {
			return;
		}
		headingRef.current?.focus();
	}, [revision]);

	// The scroll position belongs to the section being read, not to the phase.
	useLayoutEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = 0;
		}
	}, [local.activeSectionId, presentation?.scopeKey]);

	if (!presentation) {
		return (
			<div className="flex h-full flex-col gap-3 p-6" aria-busy="true">
				<Skeleton className="h-6 w-64" />
				<Skeleton className="h-4 w-96" />
				<Skeleton className="h-40 w-full max-w-2xl" />
			</div>
		);
	}

	const panel = presentation.panels.find(candidate => candidate.id === (local.activeSectionId ?? '')) ?? presentation.panels[0];
	const error = state.hostError ?? presentation.error;

	return (
		<div role="region" aria-label={presentation.regionLabel} className="bg-background text-foreground flex h-full flex-col">
			<header className="border-border/70 shrink-0 border-b px-5 pt-4 pb-3">
				<div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
					<h1 tabIndex={-1} className="text-base font-semibold outline-none">{presentation.title}</h1>
					<ol className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
						{presentation.steps.map(step => (
							<li
								key={step.id}
								aria-current={step.current ? 'step' : undefined}
								className={cn('flex items-center gap-1.5', step.current && 'text-foreground font-medium')}
							>
								<span aria-hidden className={cn('size-1.5 rounded-full', step.current ? 'bg-primary' : 'bg-border')} />
								{step.label}
							</li>
						))}
					</ol>
				</div>
			</header>

			{error ? (
				<div className="shrink-0 px-5 pt-3">
					<Alert variant="destructive" role="alert" className="mx-auto max-w-4xl">
						<AlertCircleIcon />
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				</div>
			) : null}

			<div className="flex min-h-0 flex-1 justify-center px-5 pt-3">
				<div className="flex min-h-0 w-full max-w-4xl flex-col gap-3 md:flex-row md:gap-4">
					{presentation.sections.length ? (
						<SectionRail
							sections={presentation.sections}
							activeId={local.activeSectionId}
							label={presentation.railLabel ?? ''}
							title={presentation.railTitle ?? ''}
							onSelect={local.setActiveSection}
						/>
					) : null}
					<div
						ref={scrollRef}
						tabIndex={0}
						data-focus-id="detail"
						aria-label={panel?.heading}
						className="min-h-0 flex-1 overflow-y-auto outline-none"
					>
						{panel ? (
							<SetupPanelView
								key={panel.id}
								panel={panel}
								local={local}
								scrollRef={scrollRef}
								send={send}
								busy={presentation.busy}
							/>
						) : null}
					</div>
				</div>
			</div>

			<footer className="border-border/70 shrink-0 border-t px-5 py-3">
				<div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-3">
					<div className="text-muted-foreground flex min-w-0 flex-col gap-0.5 text-xs">
						{presentation.footer.lines.map(line => <p key={line}>{line}</p>)}
					</div>
					<div className="flex flex-wrap gap-2">
						{presentation.footer.actions.map(action => (
							<ActionButton key={action.id} action={action} onRun={run => send(run.intent)} />
						))}
					</div>
				</div>
			</footer>

			<div className="hucode-sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
			<HeadingBinder containerRef={scrollRef} headingRef={headingRef} revision={presentation.revision} />
		</div>
	);
}

/** Keeps a handle on the current panel heading so focus can land there after a transition. */
function HeadingBinder({ containerRef, headingRef, revision }: {
	readonly containerRef: React.RefObject<HTMLElement | null>;
	readonly headingRef: React.MutableRefObject<HTMLElement | null>;
	readonly revision: number;
}) {
	useLayoutEffect(() => {
		headingRef.current = containerRef.current?.querySelector('[data-panel-heading]') ?? null;
	}, [containerRef, headingRef, revision]);
	return null;
}
