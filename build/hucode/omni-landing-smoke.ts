/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Hucode contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type Frame, type Page } from '@playwright/test';

const landingSelector =
	'.hucode-omni-host-root > .hucode-omni-host-empty';

/** Landing states shared by desktop and serve-web Omni smoke tests. */
export type OmniLandingSmokeState =
	| 'first-workbench'
	| 'catalog'
	| 'crashed'
	| 'hidden';

const landingExpectations = {
	'first-workbench': {
		heading: 'Open your first workbench',
		description:
			'A project is a saved Git repository. A workbench can be any folder.',
		actions: ['Add Project', 'Open Folder as Workbench'],
	},
	catalog: {
		heading: 'Choose a project or workbench',
		description: 'Select an item from Projects to open it here.',
		actions: ['Add Project', 'Open Folder as Workbench'],
	},
	crashed: {
		heading: 'Workbench crashed',
		description: 'Select the crashed workbench in Projects to reopen it.',
		actions: [],
	},
} as const;

/**
 * Asserts the user-visible Omni landing state through the real shell DOM.
 */
export async function assertOmniLandingSmokeState(
	surface: Page | Frame,
	state: OmniLandingSmokeState,
	timeoutMs: number
): Promise<void> {
	const landing = surface.locator(landingSelector);
	if (state === 'hidden') {
		await landing.waitFor({ state: 'hidden', timeout: timeoutMs });
		return;
	}

	await landing.waitFor({ state: 'visible', timeout: timeoutMs });
	const expected = landingExpectations[state];
	await landing.getByRole('heading', {
		name: expected.heading,
		exact: true,
	}).waitFor({ state: 'visible', timeout: timeoutMs });
	const observed = await landing.evaluate(element => ({
		headingTag: element.querySelector('h2')?.tagName,
		heading: element.querySelector('h2')?.textContent,
		description: element.querySelector('p')?.textContent,
		actionsHidden: element.querySelector(
			'.hucode-omni-host-empty-actions'
		)?.classList.contains('hidden'),
	}));
	const buttons = landing.getByRole('button');
	const buttonLabels = await buttons.allTextContents();
	const buttonTypes = await buttons.evaluateAll(elements =>
		elements.map(element => element.getAttribute('type'))
	);
	const actionsHidden = state === 'crashed';
	if (
		observed.headingTag !== 'H2'
		|| observed.heading !== expected.heading
		|| observed.description !== expected.description
		|| observed.actionsHidden !== actionsHidden
		|| JSON.stringify(buttonLabels) !== JSON.stringify(expected.actions)
		|| buttonTypes.some(type => type !== 'button')
	) {
		throw new Error(
			`Unexpected Omni ${state} landing state: ` +
			JSON.stringify({ ...observed, buttonLabels, buttonTypes })
		);
	}
}
