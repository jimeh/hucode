/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cleanup, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { VIRTUALIZATION_THRESHOLD, VirtualCollection, nextRowIndex } from '@/components/VirtualCollection';

afterEach(cleanup);

/**
 * jsdom implements no layout, so the virtualizer would measure every element as zero-sized and
 * mount nothing. Give the scroller a viewport and each row its estimated height.
 */
beforeAll(() => {
	// The virtualizer reads its viewport from `offsetHeight`, which jsdom always reports as zero.
	originalMetrics.offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
	originalMetrics.offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get(this: HTMLElement) { return this.hasAttribute('data-virtual-index') ? ROW_HEIGHT : VIEWPORT_HEIGHT; },
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 600 });
	// jsdom neither implements `scrollTo` nor fires `scroll`, so the virtualizer would never learn
	// that a programmatic reveal moved the viewport and would never mount the revealed row.
	originalMetrics.scrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
	const offsets = new WeakMap<Element, number>();
	Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
		configurable: true,
		get(this: HTMLElement) { return offsets.get(this) ?? 0; },
		set(this: HTMLElement, value: number) {
			offsets.set(this, Math.max(0, value));
			// Real browsers deliver `scroll` after the current task; dispatching it synchronously
			// here would re-enter React from inside its own effects.
			queueMicrotask(() => this.dispatchEvent(new Event('scroll')));
		},
	});
	HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
		this.scrollTop = typeof options === 'number' ? options : options?.top ?? this.scrollTop;
	} as HTMLElement['scrollTo'];
	// The virtualizer clamps every scroll to `scrollHeight - clientHeight`, so without these the
	// viewport can never move off zero and no row beyond the first window is ever revealed.
	originalMetrics.clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
	originalMetrics.scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get(this: HTMLElement) { return this.hasAttribute('data-virtual-index') ? ROW_HEIGHT : VIEWPORT_HEIGHT; },
	});
	Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
		configurable: true,
		get(this: HTMLElement) {
			const declared = [this, ...this.querySelectorAll<HTMLElement>('*')]
				.map(element => Number.parseFloat(element.style.height))
				.filter(value => Number.isFinite(value));
			return declared.length ? Math.max(...declared) : VIEWPORT_HEIGHT;
		},
	});
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
		const height = this.hasAttribute('data-virtual-index') ? ROW_HEIGHT : VIEWPORT_HEIGHT;
		return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: height, width: 600, height, toJSON: () => ({}) } as DOMRect;
	});
});

afterAll(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
	for (const [name, descriptor] of Object.entries(originalMetrics)) {
		if (descriptor) {
			Object.defineProperty(HTMLElement.prototype, name, descriptor);
		} else {
			Reflect.deleteProperty(HTMLElement.prototype, name);
		}
	}
});

const originalMetrics: Record<string, PropertyDescriptor | undefined> = {};

const ROW_HEIGHT = 40;
const VIEWPORT_HEIGHT = 300;

interface Row {
	readonly id: string;
	readonly label: string;
}

function rows(count: number): Row[] {
	return Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}` }));
}

/** The same harness, with rows that only sometimes carry a control. */
function ActionableHarness({ items, isActionable }: { readonly items: readonly Row[]; readonly isActionable: (row: Row) => boolean }) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	return (
		<div ref={scrollRef} data-testid="scroller" style={{ height: `${VIEWPORT_HEIGHT}px`, overflowY: 'auto' }}>
			<VirtualCollection
				items={items}
				itemKey={row => row.id}
				estimateSize={ROW_HEIGHT}
				scrollRef={scrollRef}
				label="Rows"
				isActionable={isActionable}
			>
				{row => isActionable(row)
					? <button type="button" data-focus-id={row.id}>{row.label}</button>
					: <span>{row.label}</span>}
			</VirtualCollection>
		</div>
	);
}

/** Hosts the collection inside one scroller, the way the setup shell does. */
function Harness({ items, filterable = false }: { readonly items: readonly Row[]; readonly filterable?: boolean }) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [filter, setFilter] = useState('');
	const visible = items.filter(row => row.label.toLowerCase().includes(filter.toLowerCase()));
	return (
		<div ref={scrollRef} data-testid="scroller" style={{ height: `${VIEWPORT_HEIGHT}px`, overflowY: 'auto' }}>
			{filterable ? <input aria-label="Filter" value={filter} onChange={event => setFilter(event.target.value)} /> : null}
			<VirtualCollection items={visible} itemKey={row => row.id} estimateSize={ROW_HEIGHT} scrollRef={scrollRef} label="Rows">
				{row => <button type="button" data-focus-id={row.id}>{row.label}</button>}
			</VirtualCollection>
		</div>
	);
}

describe('VirtualCollection', () => {
	test('renders a short collection in full without virtualizing it', () => {
		render(<Harness items={rows(6)} />);
		const list = screen.getByRole('list', { name: 'Rows' });
		expect(within(list).getAllByRole('listitem')).toHaveLength(6);
		expect(list).not.toHaveAttribute('style', expect.stringContaining('height'));
	});

	test('mounts only a window of a long collection while reporting the true set size', () => {
		const items = rows(400);
		render(<Harness items={items} />);
		const list = screen.getByRole('list', { name: 'Rows' });
		const mounted = within(list).getAllByRole('listitem');

		expect(items.length).toBeGreaterThan(VIRTUALIZATION_THRESHOLD);
		expect(mounted.length).toBeLessThan(items.length);
		expect(mounted[0]).toHaveAttribute('aria-posinset', '1');
		expect(mounted[0]).toHaveAttribute('aria-setsize', '400');
		expect(mounted.length).toBeGreaterThan(0);
		expect(Number.parseInt(list.style.height, 10)).toBeGreaterThan(VIEWPORT_HEIGHT);
	});

	test('keeps item identity stable while filtering a long collection', async () => {
		const user = userEvent.setup();
		render(<Harness items={rows(400)} filterable />);

		await user.type(screen.getByLabelText('Filter'), 'Row 399');
		const list = screen.getByRole('list', { name: 'Rows' });
		const mounted = within(list).getAllByRole('listitem');
		expect(mounted).toHaveLength(1);
		expect(within(mounted[0]).getByRole('button')).toHaveAttribute('data-focus-id', 'row-399');
		expect(mounted[0]).toHaveAttribute('aria-setsize', '1');
	});

	test('traverses beyond the mounted window with Tab and back with Shift+Tab', async () => {
		const user = userEvent.setup();
		const items = rows(400);
		render(<Harness items={items} />);
		const list = screen.getByRole('list', { name: 'Rows' });

		const mountedIndexes = () => within(list).getAllByRole('listitem')
			.map(row => Number(row.getAttribute('data-virtual-index')));

		// Park focus on the last mounted row and let the reveal that follows settle, so the window
		// below is the one Tab actually has to cross.
		screen.getByRole('button', { name: `Row ${mountedIndexes().at(-1)}` }).focus();
		await vi.waitFor(() => expect(document.activeElement?.textContent).toMatch(/^Row \d+$/));
		const last = Number(/\d+/.exec(document.activeElement!.textContent!)![0]);
		screen.getByRole('button', { name: `Row ${mountedIndexes().at(-1)}` }).focus();
		const settled = mountedIndexes();
		const from = settled.at(-1)!;
		const beyond = from + 1;
		expect(settled).not.toContain(beyond);
		expect(from).toBeGreaterThanOrEqual(last);

		await user.tab();

		// Revealing the row is a scroll, a remount, and then a focus, so it settles asynchronously.
		await vi.waitFor(() => {
			expect(mountedIndexes()).toContain(beyond);
			expect(document.activeElement).toHaveTextContent(`Row ${beyond}`);
		});

		await user.tab({ shift: true });
		await vi.waitFor(() => expect(document.activeElement).toHaveTextContent(`Row ${from}`));
	});

	test('moves by row with the arrow keys and jumps to either end', async () => {
		const user = userEvent.setup();
		render(<Harness items={rows(400)} />);

		screen.getByRole('button', { name: 'Row 0' }).focus();
		await user.keyboard('{ArrowDown}');
		await vi.waitFor(() => expect(document.activeElement).toHaveTextContent('Row 1'));
		await user.keyboard('{ArrowUp}');
		await vi.waitFor(() => expect(document.activeElement).toHaveTextContent('Row 0'));

		await user.keyboard('{End}');
		await vi.waitFor(() => expect(document.activeElement).toHaveTextContent('Row 399'));
		await user.keyboard('{Home}');
		await vi.waitFor(() => expect(document.activeElement).toHaveTextContent('Row 0'));
	});

	test('steps over rows that offer nothing to focus, forwards and back', async () => {
		const user = userEvent.setup();
		// 60 rows, so the collection virtualizes; only every seventh carries a control, which puts
		// long runs of evidence-only rows between the actionable ones.
		const items = rows(60);
		const actionable = (row: Row) => Number(/\d+/.exec(row.label)![0]) % 7 === 0;
		render(<ActionableHarness items={items} isActionable={actionable} />);
		const list = screen.getByRole('list', { name: 'Rows' });
		const mountedIndexes = () => within(list).getAllByRole('listitem')
			.map(row => Number(row.getAttribute('data-virtual-index')));

		screen.getByRole('button', { name: 'Row 0' }).focus();
		await user.keyboard('{ArrowDown}');
		await vi.waitFor(() => expect(document.activeElement).toHaveTextContent('Row 7'));

		// Reach an actionable row well past the initial virtual window.
		await user.keyboard('{End}');
		await vi.waitFor(() => {
			expect(document.activeElement).toHaveTextContent('Row 56');
			expect(mountedIndexes()).toContain(56);
		});

		await user.keyboard('{ArrowUp}');
		await vi.waitFor(() => expect(document.activeElement).toHaveTextContent('Row 49'));
		await user.keyboard('{Home}');
		await vi.waitFor(() => expect(document.activeElement).toHaveTextContent('Row 0'));
	});

	test('lets Tab leave a list whose remaining rows are all actionless', () => {
		// Rows 0 and 1 are actionable, nothing after them is. Tab from row 1 must return undefined
		// so the browser moves focus past the list instead of stalling on an unfocusable row.
		const actionable = (index: number) => index < 2;
		expect(nextRowIndex('Tab', false, 0, 60, actionable)).toBe(1);
		expect(nextRowIndex('Tab', false, 1, 60, actionable)).toBeUndefined();
		expect(nextRowIndex('ArrowDown', false, 1, 60, actionable)).toBeUndefined();
		expect(nextRowIndex('Tab', true, 1, 60, actionable)).toBe(0);
		expect(nextRowIndex('End', false, 0, 60, actionable)).toBe(1);
		expect(nextRowIndex('Home', false, 1, 60, actionable)).toBe(0);
		// A collection with no actionable row at all never claims a key.
		expect(nextRowIndex('ArrowDown', false, 0, 60, () => false)).toBeUndefined();
		expect(nextRowIndex('End', false, 0, 60, () => false)).toBeUndefined();
	});

	test('lets focus leave the list at either end rather than trapping it', () => {
		// Tab at the ends returns `undefined`, so the browser's own traversal takes over.
		expect(nextRowIndex('Tab', false, 399, 400)).toBeUndefined();
		expect(nextRowIndex('Tab', true, 0, 400)).toBeUndefined();
		expect(nextRowIndex('ArrowDown', false, 399, 400)).toBeUndefined();
		expect(nextRowIndex('ArrowUp', false, 0, 400)).toBeUndefined();
		expect(nextRowIndex('Tab', false, 12, 400)).toBe(13);
		expect(nextRowIndex('Tab', true, 12, 400)).toBe(11);
		expect(nextRowIndex('Enter', false, 12, 400)).toBeUndefined();
	});

	test('does not introduce a second scroll region', () => {
		render(<Harness items={rows(400)} />);
		const list = screen.getByRole('list', { name: 'Rows' });
		expect(list.style.overflow).toBe('');
		expect(list.style.overflowY).toBe('');
		expect(screen.getByTestId('scroller').querySelectorAll('[style*="overflow"]')).toHaveLength(0);
	});
});
