/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/vendor/shadcn/lib/utils';

/** Below this many rows, normal rendering is cheaper than measuring and positioning. */
export const VIRTUALIZATION_THRESHOLD = 40;

/** Rows kept mounted beyond the visible window so keyboard travel does not land on nothing. */
export const OVERSCAN = 8;

export interface VirtualCollectionProps<T> {
	readonly items: readonly T[];
	readonly itemKey: (item: T) => string;
	readonly estimateSize: number;
	readonly children: (item: T, index: number) => ReactNode;
	/**
	 * The one content scroller. Virtualized rows position themselves inside it rather than
	 * introducing a second scroll region.
	 */
	readonly scrollRef: React.RefObject<HTMLElement | null>;
	readonly label?: string;
	readonly className?: string;
	readonly itemClassName?: string;
	/**
	 * Whether a row offers anything to focus.
	 *
	 * Some rows are pure evidence — a recovery record from an unsupported schema version has text
	 * and no control. Keyboard traversal has to step over those rather than stall on them, and only
	 * the caller knows which rows they are without mounting every one to look.
	 */
	readonly isActionable?: (item: T) => boolean;
}

/**
 * Renders a long collection as a list, virtualizing only once it is long enough to matter.
 *
 * The wrapper owns the threshold, stable keys, overscan, variable-height measurement,
 * width-sensitive remeasurement, focus reveal, and `aria-posinset`/`aria-setsize`, so no caller
 * has to reimplement any of it.
 */
/** Index of the row containing an event target, or `undefined` outside any row. */
function rowIndexOf(target: EventTarget | null): number | undefined {
	const row = (target as HTMLElement | null)?.closest?.('[data-virtual-index]');
	const index = row ? Number(row.getAttribute('data-virtual-index')) : Number.NaN;
	return Number.isInteger(index) ? index : undefined;
}

/**
 * The row a key press should move to, or `undefined` when the key is not ours or nothing lies
 * that way.
 *
 * Rows without a control are stepped over, so a run of evidence-only records cannot swallow the
 * caret. Returning `undefined` at either end is what lets Tab leave the list naturally instead of
 * trapping focus inside it.
 */
export function nextRowIndex(
	key: string,
	shiftKey: boolean,
	current: number,
	count: number,
	isActionable: (index: number) => boolean = () => true,
): number | undefined {
	const scan = (from: number, step: number): number | undefined => {
		for (let index = from; index >= 0 && index < count; index += step) {
			if (isActionable(index)) {
				return index;
			}
		}
		return undefined;
	};
	switch (key) {
		case 'ArrowDown': return scan(current + 1, 1);
		case 'ArrowUp': return scan(current - 1, -1);
		case 'Home': {
			const target = scan(0, 1);
			return target === undefined || target === current ? undefined : target;
		}
		case 'End': {
			const target = scan(count - 1, -1);
			return target === undefined || target === current ? undefined : target;
		}
		case 'Tab': return scan(shiftKey ? current - 1 : current + 1, shiftKey ? -1 : 1);
		default: return undefined;
	}
}

/**
 * The control a row hands focus to.
 *
 * A roving-tabindex composite such as a radio group exposes exactly one reachable control, so
 * anything explicitly removed from the tab order is skipped rather than focused.
 */
function firstFocusable(row: Element | null | undefined): HTMLElement | undefined {
	return row?.querySelector<HTMLElement>(
		'button:not([disabled]):not([tabindex="-1"]), a[href], input:not([disabled]):not([tabindex="-1"]),'
		+ ' select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
	) ?? undefined;
}

export function VirtualCollection<T>({
	items, itemKey, estimateSize, children, scrollRef, label, className, itemClassName, isActionable,
}: VirtualCollectionProps<T>) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [offset, setOffset] = useState(0);
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	const [pendingFocus, setPendingFocus] = useState<number | undefined>(undefined);
	const virtualize = items.length > VIRTUALIZATION_THRESHOLD;

	// The scroller belongs to an ancestor, whose ref React attaches after this component's layout
	// effects. Reading it from a passive effect is what makes the element available at all, and
	// storing it re-renders once so the virtualizer sees a real viewport instead of nothing.
	useEffect(() => setScroller(scrollRef.current), [scrollRef]);

	useEffect(() => {
		if (!virtualize || !scroller) {
			return;
		}
		const measure = () => {
			const container = containerRef.current;
			if (container) {
				setOffset(container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
			}
		};
		measure();
		// A width change re-wraps rows, so both the offset and every measured height are stale.
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		return () => observer.disconnect();
	}, [virtualize, scroller, items.length]);

	const virtualizer = useVirtualizer({
		count: virtualize ? items.length : 0,
		getScrollElement: () => scroller,
		estimateSize: () => estimateSize,
		overscan: OVERSCAN,
		scrollMargin: offset,
		getItemKey: index => itemKey(items[index]),
	});

	// Keyboard travel can move focus into a row the virtualizer is about to unmount; bring the
	// focused row back into view instead of losing the caret.
	useEffect(() => {
		if (!virtualize) {
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const onFocus = (event: FocusEvent) => {
			const index = rowIndexOf(event.target);
			if (index !== undefined) {
				virtualizer.scrollToIndex(index, { align: 'auto' });
			}
		};
		container.addEventListener('focusin', onFocus);
		return () => container.removeEventListener('focusin', onFocus);
	}, [virtualize, virtualizer]);

	/*
	 * Keyboard traversal has to survive virtualization.
	 *
	 * A row the user is about to reach may not be in the DOM yet, so Tab and the arrow keys would
	 * otherwise stop at the last mounted row. Scrolling the logical target into view mounts it, and
	 * the pending index below focuses it as soon as it renders.
	 */
	const requestRowFocus = useCallback((index: number) => {
		const clamped = Math.max(0, Math.min(items.length - 1, index));
		virtualizer.scrollToIndex(clamped, { align: 'auto' });
		setPendingFocus(clamped);
	}, [items.length, virtualizer]);

	const mountedRows = virtualizer.getVirtualItems();
	useEffect(() => {
		if (pendingFocus === undefined) {
			return;
		}
		const target = firstFocusable(containerRef.current?.querySelector(`[data-virtual-index="${pendingFocus}"]`));
		if (target) {
			target.focus();
			setPendingFocus(undefined);
		}
	}, [pendingFocus, mountedRows]);

	const actionableAt = useCallback((index: number) => !isActionable || isActionable(items[index]), [isActionable, items]);

	const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
		// A composite child such as a radio group handles its own arrow keys first.
		if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) {
			return;
		}
		const current = rowIndexOf(event.target);
		if (current === undefined) {
			return;
		}
		const target = nextRowIndex(event.key, event.shiftKey, current, items.length, actionableAt);
		if (target === undefined) {
			return;
		}
		// Tab keeps its ordinary meaning while the row it would reach is already mounted, so
		// tabbing between controls inside the list is untouched. In practice the reveal above has
		// usually mounted the neighbour already; this is the safety net for when it has not,
		// such as rows tall enough to collapse the rendered window.
		if (event.key === 'Tab' && containerRef.current?.querySelector(`[data-virtual-index="${target}"]`)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		requestRowFocus(target);
	}, [items.length, actionableAt, requestRowFocus]);

	if (!virtualize) {
		return (
			<div ref={containerRef} role="list" aria-label={label} className={cn('flex flex-col', className)}>
				{items.map((item, index) => (
					<div
						key={itemKey(item)}
						role="listitem"
						aria-posinset={index + 1}
						aria-setsize={items.length}
						data-virtual-index={index}
						className={itemClassName}
					>
						{children(item, index)}
					</div>
				))}
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			role="list"
			aria-label={label}
			className={cn('relative w-full', className)}
			style={{ height: `${virtualizer.getTotalSize()}px` }}
			onKeyDown={onKeyDown}
		>
			{mountedRows.map(virtualRow => (
				<div
					key={virtualRow.key}
					ref={virtualizer.measureElement}
					data-index={virtualRow.index}
					data-virtual-index={virtualRow.index}
					role="listitem"
					aria-posinset={virtualRow.index + 1}
					aria-setsize={items.length}
					className={cn('absolute top-0 left-0 w-full', itemClassName)}
					style={{ transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)` }}
				>
					{children(items[virtualRow.index], virtualRow.index)}
				</div>
			))}
		</div>
	);
}
