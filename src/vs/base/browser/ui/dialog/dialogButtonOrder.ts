/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Applies a complete permutation of original dialog button indices.
 *
 * Returns undefined when the order is absent or invalid so callers can retain
 * their platform-native fallback ordering.
 */
export function applyExplicitDialogButtonOrder<T>(
	buttons: readonly T[],
	buttonOrder: readonly number[] | undefined
): T[] | undefined {
	if (!buttonOrder || buttonOrder.length !== buttons.length) {
		return undefined;
	}

	const seen = new Set<number>();
	const orderedButtons: T[] = [];
	for (const index of buttonOrder) {
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= buttons.length ||
			seen.has(index)
		) {
			return undefined;
		}

		seen.add(index);
		orderedButtons.push(buttons[index]);
	}

	return orderedButtons;
}
