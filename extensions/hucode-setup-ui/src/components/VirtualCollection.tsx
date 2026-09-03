/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
}

/**
 * Renders a long collection as a list, virtualizing only once it is long enough to matter.
 *
 * The wrapper owns the threshold, stable keys, overscan, variable-height measurement,
 * width-sensitive remeasurement, focus reveal, and `aria-posinset`/`aria-setsize`, so no caller
 * has to reimplement any of it.
 */
export function VirtualCollection<T>({
	items, itemKey, estimateSize, children, scrollRef, label, className, itemClassName,
}: VirtualCollectionProps<T>) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [offset, setOffset] = useState(0);
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
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
			const row = (event.target as HTMLElement | null)?.closest('[data-virtual-index]');
			const index = row ? Number(row.getAttribute('data-virtual-index')) : Number.NaN;
			if (Number.isInteger(index)) {
				virtualizer.scrollToIndex(index, { align: 'auto' });
			}
		};
		container.addEventListener('focusin', onFocus);
		return () => container.removeEventListener('focusin', onFocus);
	}, [virtualize, virtualizer]);

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
		>
			{virtualizer.getVirtualItems().map(virtualRow => (
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
