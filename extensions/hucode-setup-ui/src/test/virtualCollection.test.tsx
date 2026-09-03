/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cleanup, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { VIRTUALIZATION_THRESHOLD, VirtualCollection } from '@/components/VirtualCollection';

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
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
		const height = this.hasAttribute('data-virtual-index') ? ROW_HEIGHT : VIEWPORT_HEIGHT;
		return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: height, width: 600, height, toJSON: () => ({}) } as DOMRect;
	});
});

afterAll(() => {
	vi.restoreAllMocks();
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

	test('does not introduce a second scroll region', () => {
		render(<Harness items={rows(400)} />);
		const list = screen.getByRole('list', { name: 'Rows' });
		expect(list.style.overflow).toBe('');
		expect(list.style.overflowY).toBe('');
		expect(screen.getByTestId('scroller').querySelectorAll('[style*="overflow"]')).toHaveLength(0);
	});
});
